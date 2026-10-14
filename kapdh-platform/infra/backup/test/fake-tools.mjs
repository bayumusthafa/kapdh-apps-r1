// Tiruan psql, pg_dump, pg_restore, restic dan rclone untuk uji kering (dry run) skrip backup/restore KAPDH
// (infra/backup/test/dry-run.sh). BUKAN alat produksi: hanya meniru perilaku yang dipakai skrip, termasuk batasan
// penting (pg_dump --snapshot hanya sah selama transaksi pengekspor masih terbuka; restic snapshot/restore/dump; filter
// rclone --include). SQL sungguhan diuji terpisah pada PGlite (apps/api/test/ops/backup-sql.test.ts).
//
// Pemakaian: node fake-tools.mjs <alat> [argumen...]; status di FAKE_STATE_DIR. Variabel kegagalan:
//   FAKE_PG_DUMP_FAIL=1, FAKE_LEDGER_NOT_DELETED=<n>, FAKE_RESTORED_STATS=<berkas json>, FAKE_STATS=<berkas json>.
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";

/** Path gaya MSYS (/c/Users/...) menjadi path Windows yang dimengerti Node; path lain apa adanya. */
function p(path) {
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(path)) return `${path[1]}:/${path.slice(3)}`;
  return path;
}
function norm(path) {
  return p(path).replace(/\\/g, "/").replace(/\/+$/, "");
}

const stateDir = norm(process.env.FAKE_STATE_DIR ?? "");
if (!stateDir) {
  process.stderr.write("FAKE_STATE_DIR wajib\n");
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true });
const state = (name) => join(stateDir, name);
const readState = (name) => (existsSync(state(name)) ? readFileSync(state(name), "utf8").trim() : "");
const logCall = (tool, args) => appendFileSync(state("calls.log"), `${tool} ${args.join(" ")}\n`);

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

function flag(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) values.push(args[++i]);
    else if (args[i].startsWith(`${name}=`)) values.push(args[i].slice(name.length + 1));
  }
  return values;
}

// ---------------------------------------------------------------------------------------------------- psql

function psqlVars(args) {
  const vars = {};
  for (const value of flag(args, "-v")) {
    const eq = value.indexOf("=");
    vars[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return vars;
}

function compareStats(expected, actual) {
  const lines = [];
  for (const grp of ["info", "invariant", "schema"]) {
    for (const key of Object.keys(expected[grp] ?? {}).sort()) {
      const text = (v) =>
        v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      lines.push(`${grp}|${key}|${text(expected[grp][key])}|${text(actual[grp]?.[key])}`);
    }
  }
  return lines;
}

function filesLocal() {
  const root = norm(process.env.FAKE_FILES_ROOT ?? "");
  const keys = walk(root).filter(
    (key) => !key.startsWith(".tmp/") && !key.startsWith("ledger/") && !key.startsWith("health/"),
  );
  const extra = (process.env.FAKE_DB_EXTRA_FILE_KEYS ?? "").split(",").filter(Boolean);
  return [
    ...keys.map((key) => {
      const sha = createHash("sha256")
        .update(readFileSync(join(root, key)))
        .digest("hex");
      return `${key} ${sha} ready`;
    }),
    ...extra.map((key) => `${key} ${"0".repeat(64)} ready`),
  ].sort();
}

function handleStatement(sql, vars, out) {
  const tag = /\/\* kapdh:([a-z-]+) \*\//.exec(sql)?.[1];
  if (/BEGIN ISOLATION LEVEL REPEATABLE READ/.test(sql)) {
    writeFileSync(state("snapshot-open"), "1");
    return;
  }
  if (/pg_export_snapshot\(\)/.test(sql)) {
    const id = `00000003-0000${randomBytes(2).toString("hex").toUpperCase()}-1`;
    writeFileSync(state("snapshot-id"), id);
    out(`SNAPSHOT=${id}`);
    return;
  }
  if (/SELECT 'STATS=' \|\|/.test(sql)) {
    if (!/json_build_object\(/.test(sql)) throw new Error("ekspresi statistik tidak dikirim");
    const file = readState("restored") === "1" ? process.env.FAKE_RESTORED_STATS : process.env.FAKE_STATS;
    const text = readFileSync(norm(file), "utf8").trim();
    JSON.parse(text);
    out(`STATS=${text}`);
    return;
  }
  if (/^\s*COMMIT;/m.test(sql)) {
    writeFileSync(state("snapshot-open"), "0");
    return;
  }
  switch (tag) {
    case "db-exists":
      return out(readState("db-created") === "1" ? "1" : "0");
    case "target-state":
      return out(readState("restored") === "1" ? "2" : "0");
    case "create-db":
      if (vars.db === undefined) throw new Error("variabel db tidak dikirim");
      writeFileSync(state("db-created"), "1");
      return;
    case "compare-stats":
      return compareStats(JSON.parse(vars.expected), JSON.parse(vars.actual)).forEach(out);
    case "verify-checks": {
      const ids = (vars.ledger_user_ids ?? "{}").replace(/[{}]/g, "").split(",").filter(Boolean);
      writeFileSync(state("ledger-user-ids"), ids.join("\n"));
      out("super_admins_active=2");
      out(`ledger_users_present=${ids.length}`);
      out(`ledger_users_not_deleted=${process.env.FAKE_LEDGER_NOT_DELETED ?? 0}`);
      out("ledger_users_with_profile=0");
      out("deletions_completed_not_deleted=0");
      out("deletions_open=0");
      out("outbox_dead=0");
      out(`outbox_leased=${readState("outbox-released") === "1" ? 0 : 3}`);
      return;
    }
    case "release-outbox":
      writeFileSync(state("outbox-released"), "1");
      return;
    case "outbox-counts":
      out("outbox_dispatched=10");
      out("outbox_pending=3");
      return;
    case "files-local":
      return filesLocal().forEach(out);
    case "public-file":
      return;
    default:
      // roles.sql dan pernyataan lain tanpa tag: diterima tanpa keluaran.
      if (/kapdh_migrator/.test(sql)) appendFileSync(state("roles-applied"), "1\n");
  }
}

async function psql(args) {
  const vars = psqlVars(args);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buffer = "";
  const out = (line) => process.stdout.write(`${line}\n`);
  let inDollar = false;
  for await (const line of rl) {
    if (line.trim() === "\\q") break;
    buffer += `${line}\n`;
    // Seperti lexer psql: titik koma di dalam komentar `--` bukan akhir pernyataan.
    const code = line.replace(/--.*$/, "");
    const dollars = (code.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(code)) {
      handleStatement(buffer, vars, out);
      buffer = "";
    }
  }
  if (buffer.trim()) handleStatement(buffer, vars, out);
}

// ------------------------------------------------------------------------------------------- pg_dump/restore

function pgDump(args) {
  if (process.env.FAKE_PG_DUMP_FAIL === "1") {
    process.stderr.write("pg_dump: error: tiruan gagal\n");
    process.exit(1);
  }
  const snapshot = flag(args, "--snapshot")[0];
  if (!snapshot || snapshot !== readState("snapshot-id"))
    throw new Error("--snapshot tidak cocok dengan ekspor");
  if (readState("snapshot-open") !== "1") throw new Error("transaksi pengekspor snapshot sudah ditutup");
  if (!args.includes("--format=custom")) throw new Error("format custom wajib");
  process.stdout.write(Buffer.concat([Buffer.from("PGDMP"), randomBytes(4096)]));
}

async function pgRestore(args) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  if (data.subarray(0, 5).toString() !== "PGDMP") {
    process.stderr.write("pg_restore: error: input file does not appear to be a valid archive\n");
    process.exit(1);
  }
  if (args.includes("--list")) {
    process.stdout.write(
      ";\n; Archive created at ...\n;\n215; 2615 16385 SCHEMA - app kapdh_migrator\n3456; 1259 16400 TABLE app users kapdh_migrator\n",
    );
    return;
  }
  if (!args.includes("--single-transaction")) throw new Error("--single-transaction wajib");
  if (readState("roles-applied") === "") throw new Error("roles.sql belum dijalankan sebelum pg_restore");
  writeFileSync(state("restored"), "1");
}

// ---------------------------------------------------------------------------------------------------- restic

function repo() {
  const root = norm(process.env.RESTIC_REPOSITORY ?? "");
  if (!root) throw new Error("RESTIC_REPOSITORY kosong");
  if (!process.env.RESTIC_PASSWORD_FILE) throw new Error("RESTIC_PASSWORD_FILE kosong");
  mkdirSync(join(root, "snapshots"), { recursive: true });
  return root;
}

function snapshots(root) {
  return readdirSync(join(root, "snapshots")).map((f) =>
    JSON.parse(readFileSync(join(root, "snapshots", f), "utf8")),
  );
}

function hasTags(snapshot, tagLists) {
  if (tagLists.length === 0) return true;
  return tagLists.some((list) => list.split(",").every((tag) => snapshot.tags.includes(tag)));
}

function restic(args) {
  const [command, ...rest] = args;
  switch (command) {
    case "version":
      process.stdout.write("restic 0.18.0 compiled with go1.24.1 on linux/amd64\n");
      return;
    case "backup": {
      const root = repo();
      const source = norm(rest[rest.length - 1]);
      const excludes = flag(rest, "--exclude").map(norm);
      const id = randomBytes(32).toString("hex");
      const files = walk(source).filter(
        (key) => !excludes.some((ex) => `${source}/${key}`.startsWith(`${ex}/`)),
      );
      let bytes = 0;
      for (const key of files) {
        const target = join(root, "data", id, key);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(source, key), target);
        bytes += statSync(join(source, key)).size;
      }
      const meta = {
        time: new Date().toISOString(),
        paths: [source],
        hostname: flag(rest, "--host")[0],
        tags: flag(rest, "--tag").flatMap((t) => t.split(",")),
        id,
        short_id: id.slice(0, 8),
      };
      writeFileSync(join(root, "snapshots", `${id}.json`), JSON.stringify(meta));
      process.stdout.write(`{"message_type":"status","percent_done":1}\n`);
      process.stdout.write(
        `{"message_type":"summary","files_new":${files.length},"total_files_processed":${files.length},"total_bytes_processed":${bytes},"total_duration":0.1,"snapshot_id":"${id}"}\n`,
      );
      return;
    }
    case "snapshots": {
      const root = repo();
      const host = flag(rest, "--host")[0];
      let list = snapshots(root).filter(
        (s) => (!host || s.hostname === host) && hasTags(s, flag(rest, "--tag")),
      );
      if (flag(rest, "--latest")[0]) {
        const groups = new Map();
        for (const s of list.sort((a, b) => a.time.localeCompare(b.time)))
          groups.set(`${s.hostname}|${s.paths}`, s);
        list = [...groups.values()];
      }
      process.stdout.write(`${JSON.stringify(list)}\n`);
      return;
    }
    case "restore": {
      const root = repo();
      const spec = rest.find((a) => !a.startsWith("--") && a !== flag(rest, "--target")[0]);
      const colon = spec.indexOf(":");
      const id = colon >= 0 ? spec.slice(0, colon) : spec;
      const sub = colon >= 0 ? norm(spec.slice(colon + 1)) : null;
      const target = norm(flag(rest, "--target")[0]);
      const meta = snapshots(root).find((s) => s.id === id);
      if (!meta) throw new Error(`snapshot ${id} tidak ada`);
      if (sub !== null && sub !== meta.paths[0]) throw new Error(`subfolder ${sub} bukan path snapshot`);
      const dest = sub !== null ? target : join(target, meta.paths[0].replace(/^[A-Za-z]:/, ""));
      for (const key of walk(join(root, "data", id))) {
        mkdirSync(dirname(join(dest, key)), { recursive: true });
        cpSync(join(root, "data", id, key), join(dest, key));
      }
      return;
    }
    case "dump": {
      const root = repo();
      const id = rest.find((a) => !a.startsWith("--"));
      const file = norm(rest[rest.length - 1]);
      const meta = snapshots(root).find((s) => s.id === id);
      process.stdout.write(readFileSync(join(root, "data", id, relative(meta.paths[0], file))));
      return;
    }
    case "forget":
      repo();
      if (!flag(rest, "--keep-within")[0]) throw new Error("--keep-within wajib");
      process.stdout.write("Applying Policy: keep snapshots within 30d\n");
      return;
    default:
      throw new Error(`perintah restic tiruan tidak dikenal: ${command}`);
  }
}

// ---------------------------------------------------------------------------------------------------- rclone

function rclone(args) {
  const [command, ...rest] = args;
  if (command === "version") {
    process.stdout.write("rclone v1.69.1\n- os/version: tiruan\n");
    return;
  }
  if (command !== "copy") throw new Error(`perintah rclone tiruan tidak dikenal: ${command}`);
  const [src, dst] = rest.filter((a) => !a.startsWith("--") && !flag(rest, "--include").includes(a));
  const bucket = src.slice(src.indexOf(":") + 1);
  const root = join(norm(process.env.FAKE_RCLONE_ROOT ?? ""), bucket);
  const include = flag(rest, "--include")[0];
  if (include !== "/account-deletions/**") throw new Error("filter --include tidak sesuai");
  for (const key of walk(root).filter((k) => k.startsWith("account-deletions/"))) {
    mkdirSync(dirname(join(norm(dst), key)), { recursive: true });
    cpSync(join(root, key), join(norm(dst), key));
  }
}

const [tool, ...args] = process.argv.slice(2);
logCall(tool, args);
try {
  if (tool === "psql") await psql(args);
  else if (tool === "pg_dump") pgDump(args);
  else if (tool === "pg_restore") await pgRestore(args);
  else if (tool === "restic") restic(args);
  else if (tool === "rclone") rclone(args);
  else throw new Error(`alat tiruan tidak dikenal: ${tool}`);
} catch (error) {
  process.stderr.write(`${tool} (tiruan): ${error.message}\n`);
  process.exit(1);
}
