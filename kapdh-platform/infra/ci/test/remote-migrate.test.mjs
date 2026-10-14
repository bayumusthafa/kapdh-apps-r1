// Uji job migrasi deployment tunggal (infra/ci/remote-migrate.sh; PRD 5.3, 5.5, 8.4, 9.2 #9, 9.3) dengan `docker` palsu di
// PATH: lingkungan terikat forced command, roles.sql hanya dari image, production hanya image rilis, dump pra-migrasi
// wajib di production, URL database tidak pernah muncul di argumen proses. Butuh `sh` POSIX (dash di CI; Git Bash di
// Windows); dilewati bila tidak ada.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "remote-migrate.sh");
const HAS_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const REPO = "ghcr.io/kapdh/kapdh-api";
const DIGEST = "a".repeat(64);
const REF = `${REPO}@sha256:${DIGEST}`;
const posix = (p) => p.split("\\").join("/");

// docker palsu: mencatat setiap pemanggilan (argumen + apakah URL database diteruskan lewat environment), perilaku
// diatur variabel FAKE_*.
const FAKE_DOCKER = `#!/bin/sh
printf 'docker %s | admin_env=%s db_env=%s\\n' "$*" "\${ADMIN_DATABASE_URL:+set}" "\${DATABASE_URL:+set}" >>"$FAKE_LOG"
cmd=$1
shift
last=""
for a in "$@"; do last=$a; done
case "$cmd" in
  pull)
    if [ -n "\${FAKE_PULL_FAIL:-}" ]; then
      case "$*" in *"$FAKE_PULL_FAIL"*) exit 1 ;; esac
    fi
    exit 0 ;;
  image)
    case "$last" in
      *@sha256:*) printf '%s\\n' "sha256:img-by-digest" ;;
      *) printf '%s\\n' "\${FAKE_TAG_ID:-sha256:img-by-digest}" ;;
    esac
    exit 0 ;;
  create) printf '%s\\n' "fakecid0001"; exit 0 ;;
  cp)
    case "$1" in
      *_journal.json)
        [ -z "\${FAKE_NO_JOURNAL:-}" ] || exit 1
        i=0
        : >"$2"
        while [ "$i" -lt "\${FAKE_JOURNAL_TAGS:-8}" ]; do printf '{"idx":%s,"tag":"%04d_m"}\\n' "$i" "$i" >>"$2"; i=$((i + 1)); done
        exit 0 ;;
    esac
    [ -z "\${FAKE_NO_ROLES:-}" ] || exit 1
    printf '%s\\n' "\${FAKE_ROLES:--- roles kapdh_migrator}" >"$2"
    exit 0 ;;
  rm) exit 0 ;;
  run)
    case "$*" in
      *pg_dump*)
        [ -z "\${FAKE_DUMP_FAIL:-}" ] || exit 1
        printf 'PGDMP-palsu'
        exit 0 ;;
      *pg_restore*) cat >/dev/null; exit "\${FAKE_RESTORE_EXIT:-0}" ;;
      *SQL_COUNT*)
        [ -z "\${FAKE_SCHEMA_FAIL:-}" ] || exit 1
        printf '%s\\n' "\${FAKE_DB_MIGRATIONS:-0}"
        exit 0 ;;
      *migrate.js*) exit "\${FAKE_MIGRATE_EXIT:-0}" ;;
      *seed-reference.js*) exit "\${FAKE_SEED_EXIT:-0}" ;;
      *golive-check.js*--preflight*) echo "laporan pra-migrasi palsu"; exit "\${FAKE_PREFLIGHT_EXIT:-0}" ;;
      *golive-check.js*) echo "laporan gerbang palsu"; exit "\${FAKE_GATE_EXIT:-0}" ;;
      *psql*)
        for a in "$@"; do
          case "$a" in *:/kapdh/roles.sql:ro) head -n 1 "\${a%:/kapdh/roles.sql:ro}" >>"$FAKE_LOG" ;; esac
        done
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

let root;
let script;

function config(env, extra = {}) {
  const values = {
    KAPDH_ENVIRONMENT: env,
    KAPDH_DOCKER_NETWORK: `net-${env}`,
    KAPDH_API_REPOSITORY: REPO,
    KAPDH_PSQL_IMAGE: `postgres:17.11-alpine3.24@sha256:${"b".repeat(64)}`,
    KAPDH_MIGRATOR_DATABASE_URL: `postgres://kapdh_migrator:sandi-${env}@db:5432/kapdh`,
    KAPDH_ADMIN_DATABASE_URL: `postgres://postgres:admin-${env}@db:5432/kapdh`,
    KAPDH_BACKUP_DIR: posix(join(root, `backup-${env}`)),
    ...extra,
  };
  const lines = Object.entries(values)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}='${v}'`);
  writeFileSync(join(root, "config", `${env}.env`), `${lines.join("\n")}\n`);
}

/** Menjalankan skrip seperti sshd: argumen = forced command, SSH_ORIGINAL_COMMAND = perintah klien. */
function run({ bound = ["staging"], command, args = [], env = {} } = {}) {
  const log = join(root, `docker-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(log, "");
  const r = spawnSync("sh", [posix(script), ...bound, ...args], {
    encoding: "utf8",
    input: "-- stdin diabaikan; DROP SCHEMA app CASCADE; kapdh_migrator\n",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
      FAKE_LOG: posix(log),
      ...(command === undefined ? {} : { SSH_ORIGINAL_COMMAND: command }),
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, docker: readFileSync(log, "utf8") };
}

function stepOf(line) {
  if (line.includes("pg_dump")) return "dump";
  if (line.includes("pg_restore")) return "verify-dump";
  if (line.includes("migrate.js")) return "migrate";
  if (line.includes("seed-reference.js")) return "seed";
  if (line.includes("golive-check.js --preflight")) return "gate-preflight";
  if (line.includes("golive-check.js")) return "gate";
  if (line.includes("-e SQL_COUNT")) return "schema";
  if (line.includes("/kapdh/roles.sql:ro")) return "roles";
  return `tak-dikenal: ${line}`;
}

const steps = (docker) =>
  docker
    .split("\n")
    .filter((l) => l.startsWith("docker run"))
    .map(stepOf);

describe(
  "remote-migrate.sh (forced command job migrasi)",
  { skip: !HAS_SH && "sh POSIX tidak tersedia" },
  () => {
    before(() => {
      root = mkdtempSync(join(tmpdir(), "kapdh-remote-migrate-"));
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "config"));
      mkdirSync(join(root, "backup-staging"));
      mkdirSync(join(root, "backup-production"));
      writeFileSync(join(root, "bin", "docker"), FAKE_DOCKER);
      chmodSync(join(root, "bin", "docker"), 0o755);
      const text = readFileSync(SCRIPT, "utf8");
      assert.match(text, /^CONFIG_DIR=\/etc\/kapdh\/ci-migrate$/m, "satu baris CONFIG_DIR tetap");
      script = join(root, "kapdh-ci-migrate.sh");
      writeFileSync(script, text.replace(/^CONFIG_DIR=.*$/m, `CONFIG_DIR='${posix(join(root, "config"))}'`));
      config("staging", { KAPDH_BACKUP_DIR: null });
      config("production");
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    it("staging: roles.sql (dari image) -> migrate -> roles.sql -> seed -> gerbang (laporan), URL database hanya lewat environment", () => {
      const r = run({ command: `migrate staging ${REF}` });
      assert.equal(r.status, 0, r.out);
      // Staging = mode laporan: gerbang pra-migrasi dilewati, gerbang penuh hanya dicetak.
      assert.deepEqual(steps(r.docker), ["schema", "roles", "migrate", "roles", "seed", "gate"]);
      assert.match(r.docker, /docker create ghcr\.io\/kapdh\/kapdh-api@sha256:a{64}/);
      assert.match(r.docker, /docker cp fakecid0001:\/app\/db\/roles\.sql /);
      // SQL yang dijalankan berasal dari image, bukan stdin klien.
      assert.match(r.docker, /^-- roles kapdh_migrator$/m);
      assert.doesNotMatch(r.docker, /DROP SCHEMA/);
      assert.doesNotMatch(r.docker, /postgres:\/\//);
      assert.doesNotMatch(r.out, /sandi-|admin-staging/);
      assert.match(r.docker, /--network net-staging -e ADMIN_DATABASE_URL .*\| admin_env=set/);
      assert.match(r.docker, /-e DATABASE_URL -e NODE_ENV=production .*migrate\.js \| admin_env= db_env=set/);
      assert.match(r.out, /selesai/);
    });

    it("kunci staging tidak dapat memigrasi production (lingkungan diikat forced command)", () => {
      const r = run({ bound: ["staging"], command: `migrate production ${REF} v1.0.0` });
      assert.equal(r.status, 1);
      assert.match(r.out, /terikat ke lingkungan staging/);
      assert.equal(r.docker, "");
    });

    it("forced command tanpa lingkungan, lingkungan asing, atau argumen tambahan ditolak", () => {
      for (const bound of [[], ["dev"], ["staging", "extra"]]) {
        const r = run({ bound, command: `migrate staging ${REF}` });
        assert.equal(r.status, 1, `bound=${bound.join(" ")}: ${r.out}`);
        assert.equal(r.docker, "");
      }
    });

    it("perintah klien divalidasi ketat (repositori, digest, injeksi, glob, tag)", () => {
      const bad = [
        "",
        "shell",
        `migrate staging ghcr.io/lain/kapdh-api@sha256:${DIGEST}`,
        `migrate staging ${REPO}:sha-${"1".repeat(40)}`,
        `migrate staging ${REPO}@sha256:${"a".repeat(63)}`,
        `migrate staging ${REPO}@sha256:${"A".repeat(64)}`,
        `migrate staging ${REF};id`,
        `migrate staging ${REF} $(id)`,
        `migrate staging ${REPO}@sha256:*`,
        `migrate staging ${REF} latest`,
        `migrate staging ${REF} v1.0.0 extra`,
        `seed staging ${REF}`,
      ];
      for (const command of bad) {
        const r = run({ command });
        assert.equal(r.status, 1, `${command}: ${r.out}`);
        assert.equal(r.docker, "", command);
      }
    });

    it("production: wajib tag rilis, digest harus sama dengan image bertag, dump pra-migrasi sebelum migrasi", () => {
      const noTag = run({ bound: ["production"], command: `migrate production ${REF}` });
      assert.equal(noTag.status, 1);
      assert.match(noTag.out, /hanya menerima image rilis/);

      const mismatch = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0`,
        env: { FAKE_TAG_ID: "sha256:image-lain" },
      });
      assert.equal(mismatch.status, 1);
      assert.match(mismatch.out, /bukan image rilis v1\.2\.0/);
      assert.deepEqual(steps(mismatch.docker), []);

      const missingTag = run({
        bound: ["production"],
        command: `migrate production ${REF} v9.9.9`,
        env: { FAKE_PULL_FAIL: ":v9.9.9" },
      });
      assert.equal(missingTag.status, 1);
      assert.match(missingTag.out, /tidak ada di registry/);

      const ok = run({ bound: ["production"], command: `migrate production ${REF} v1.2.0` });
      assert.equal(ok.status, 0, ok.out);
      assert.deepEqual(steps(ok.docker), [
        "dump",
        "verify-dump",
        "schema",
        "roles",
        "gate-preflight",
        "migrate",
        "roles",
        "seed",
        "gate",
      ]);
      assert.match(ok.out, /mode gerbang go-live enforce/);
      assert.match(ok.docker, /docker pull --quiet ghcr\.io\/kapdh\/kapdh-api:v1\.2\.0/);
      const dir = join(root, "backup-production");
      const dumps = readdirSync(dir).filter((f) => f.endsWith(".dump"));
      assert.equal(dumps.length, 1);
      assert.match(dumps[0], /^kapdh-production-premigrate-\d{8}T\d{6}Z-a{12}\.dump$/);
      assert.equal(readFileSync(join(dir, dumps[0]), "utf8"), "PGDMP-palsu");
      const manifest = readFileSync(join(dir, "premigrate-manifest.jsonl"), "utf8").trim().split("\n");
      const entry = JSON.parse(manifest.at(-1));
      assert.equal(entry.environment, "production");
      assert.equal(entry.release, "v1.2.0");
      assert.equal(entry.api_digest, `sha256:${DIGEST}`);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    });

    it("dump gagal, dump tidak terbaca atau hook luar VPS gagal: migrasi TIDAK dijalankan", () => {
      for (const env of [{ FAKE_DUMP_FAIL: "1" }, { FAKE_RESTORE_EXIT: "1" }]) {
        const r = run({ bound: ["production"], command: `migrate production ${REF} v1.2.0`, env });
        assert.equal(r.status, 1, JSON.stringify(env));
        assert.match(r.out, /migrasi TIDAK dijalankan/);
        assert.ok(!steps(r.docker).includes("migrate"));
        assert.ok(!steps(r.docker).includes("roles"));
      }
      const hook = join(root, "bin", "hook-gagal");
      writeFileSync(hook, "#!/bin/sh\nexit 3\n");
      chmodSync(hook, 0o755);
      config("production", { KAPDH_BACKUP_OFFSITE_HOOK: posix(hook) });
      try {
        const r = run({ bound: ["production"], command: `migrate production ${REF} v1.2.0` });
        assert.equal(r.status, 1);
        assert.match(r.out, /hook salinan luar VPS gagal/);
        assert.ok(!steps(r.docker).includes("migrate"));
      } finally {
        config("production");
      }
      assert.ok(
        readdirSync(join(root, "backup-production")).every((f) => !f.endsWith(".partial")),
        "berkas .partial dibersihkan",
      );
    });

    it("production tanpa KAPDH_BACKUP_DIR ditolak; berkas konfigurasi tertukar ditolak", () => {
      config("production", { KAPDH_BACKUP_DIR: null });
      try {
        const r = run({ bound: ["production"], command: `migrate production ${REF} v1.2.0` });
        assert.equal(r.status, 1);
        assert.match(r.out, /KAPDH_BACKUP_DIR wajib/);
        assert.equal(r.docker, "");
      } finally {
        config("production");
      }
      config("staging", { KAPDH_ENVIRONMENT: "production", KAPDH_BACKUP_DIR: null });
      try {
        const r = run({ command: `migrate staging ${REF}` });
        assert.equal(r.status, 1);
        assert.match(r.out, /berkas tertukar/);
      } finally {
        config("staging", { KAPDH_BACKUP_DIR: null });
      }
    });

    it("rotasi dump: hanya KAPDH_BACKUP_KEEP terbaru yang disimpan", () => {
      const dir = join(root, "backup-staging");
      config("staging", { KAPDH_BACKUP_DIR: posix(dir), KAPDH_BACKUP_KEEP: "2" });
      try {
        for (const stamp of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"])
          writeFileSync(join(dir, `kapdh-staging-premigrate-${stamp}-${"c".repeat(12)}.dump`), "lama");
        const r = run({ command: `migrate staging ${REF}` });
        assert.equal(r.status, 0, r.out);
        const left = readdirSync(dir)
          .filter((f) => f.endsWith(".dump"))
          .sort();
        assert.equal(left.length, 2);
        assert.match(left[0], /20260103T000000Z/);
        assert.ok(!existsSync(join(dir, `kapdh-staging-premigrate-20260101T000000Z-${"c".repeat(12)}.dump`)));
      } finally {
        config("staging", { KAPDH_BACKUP_DIR: null });
      }
    });

    it("image tanpa /app/db/roles.sql, migrasi gagal: berhenti dengan kode 1", () => {
      const noRoles = run({ command: `migrate staging ${REF}`, env: { FAKE_NO_ROLES: "1" } });
      assert.equal(noRoles.status, 1);
      assert.match(noRoles.out, /tidak memuat \/app\/db\/roles\.sql/);
      assert.deepEqual(steps(noRoles.docker), []);

      const notRoles = run({ command: `migrate staging ${REF}`, env: { FAKE_ROLES: "SELECT 1;" } });
      assert.equal(notRoles.status, 1);
      assert.deepEqual(steps(notRoles.docker), []);

      const failed = run({ command: `migrate staging ${REF}`, env: { FAKE_MIGRATE_EXIT: "1" } });
      assert.equal(failed.status, 1);
      assert.deepEqual(steps(failed.docker), ["schema", "roles", "migrate"]);
      assert.match(failed.out, /JANGAN dideploy/);
    });

    it("PRD 9.2 #9: production (enforce) - gerbang pra-migrasi menolak: migrasi TIDAK dijalankan", () => {
      const r = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0`,
        env: { FAKE_PREFLIGHT_EXIT: "1" },
      });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /pra-migrasi MENOLAK/);
      assert.deepEqual(steps(r.docker), ["dump", "verify-dump", "schema", "roles", "gate-preflight"]);
    });

    it("PRD 9.2 #9: production (enforce) - gerbang penuh menolak sesudah migrasi: kode 1, image tidak dideploy", () => {
      const r = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0`,
        env: { FAKE_GATE_EXIT: "1" },
      });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /MENOLAK setelah migrasi; image JANGAN dideploy/);
      assert.deepEqual(steps(r.docker).slice(-4), ["migrate", "roles", "seed", "gate"]);
      // Gerbang memakai image API yang sama (digest), sebagai kapdh_migrator lewat environment, mengizinkan skema
      // lebih baru (deploy ulang tag lama = rollback image).
      const gateLine = r.docker.split("\n").find((l) => l.includes("golive-check.js --allow-schema-ahead"));
      assert.ok(gateLine, r.docker);
      assert.match(
        gateLine,
        /-e DATABASE_URL -e NODE_ENV=production ghcr\.io\/kapdh\/kapdh-api@sha256:a{64} /,
      );
      assert.match(gateLine, /\| admin_env= db_env=set$/);
    });

    it("gerbang pra-migrasi tidak dapat dijalankan (kode 3, skema lama): peringatan, gerbang penuh menentukan", () => {
      const r = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0`,
        env: { FAKE_PREFLIGHT_EXIT: "3" },
      });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /pra-migrasi tidak dapat dijalankan \(kode 3/);
      assert.deepEqual(steps(r.docker).slice(-3), ["roles", "seed", "gate"]);
      const broken = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0`,
        env: { FAKE_GATE_EXIT: "3" },
      });
      assert.equal(broken.status, 1);
      assert.match(broken.out, /tidak dapat dijalankan \(kode 3\); image JANGAN dideploy/);
    });

    it("staging (report): gerbang yang menolak hanya dilaporkan; seed gagal menghentikan job", () => {
      const r = run({ command: `migrate staging ${REF}`, env: { FAKE_GATE_EXIT: "1" } });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /2\/6 gerbang pra-migrasi dilewati \(mode laporan\)/);
      assert.match(r.out, /gerbang menolak, tetapi mode laporan/);
      assert.match(r.out, /laporan gerbang palsu/);

      const seed = run({ command: `migrate staging ${REF}`, env: { FAKE_SEED_EXIT: "1" } });
      assert.equal(seed.status, 1);
      assert.match(seed.out, /seed referensi gagal/);
      assert.ok(!steps(seed.docker).includes("gate"));
    });

    it("pengecualian gerbang production hanya dari konfigurasi server, wajib alasan dan penyetuju", () => {
      config("production", { KAPDH_RELEASE_GATE: "report" });
      try {
        const r = run({ bound: ["production"], command: `migrate production ${REF} v1.2.0` });
        assert.equal(r.status, 1);
        assert.match(r.out, /wajib disertai KAPDH_RELEASE_GATE_REASON dan KAPDH_RELEASE_GATE_APPROVER/);
        assert.equal(r.docker, "");
      } finally {
        config("production");
      }
      config("production", {
        KAPDH_RELEASE_GATE: "report",
        KAPDH_RELEASE_GATE_REASON: "inisialisasi pertama PRD 8.2",
        KAPDH_RELEASE_GATE_APPROVER: "Pemilik Produk",
      });
      try {
        const r = run({
          bound: ["production"],
          command: `migrate production ${REF} v1.2.0`,
          env: { FAKE_GATE_EXIT: "1" },
        });
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /PENGECUALIAN GERBANG go-live di production/);
        assert.match(r.out, /alasan: inisialisasi pertama PRD 8\.2/);
        assert.match(r.out, /disetujui: Pemilik Produk/);
        assert.ok(!steps(r.docker).includes("gate-preflight"));
      } finally {
        config("production");
      }
      config("staging", { KAPDH_BACKUP_DIR: null, KAPDH_RELEASE_GATE: "longgar" });
      try {
        const r = run({ command: `migrate staging ${REF}` });
        assert.equal(r.status, 1);
        assert.match(r.out, /KAPDH_RELEASE_GATE harus enforce atau report/);
        assert.equal(r.docker, "");
      } finally {
        config("staging", { KAPDH_BACKUP_DIR: null });
      }
      // Perintah klien tidak dapat melonggarkan gerbang.
      const client = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0 report`,
      });
      assert.equal(client.status, 1);
      assert.equal(client.docker, "");
    });

    it("nama variabel job rilis manual (RELEASE_GATE*) di konfigurasi atau environment ditolak dengan pesan jelas", () => {
      for (const extra of [
        { RELEASE_GATE: "report" },
        { RELEASE_GATE_REASON: "inisialisasi pertama PRD 8.2" },
        { RELEASE_GATE_APPROVER: "Pemilik Produk" },
      ]) {
        config("production", extra);
        try {
          const r = run({ bound: ["production"], command: `migrate production ${REF} v1.2.0` });
          const [name] = Object.keys(extra);
          assert.equal(r.status, 1, r.out);
          assert.match(r.out, new RegExp(`${name} tidak berlaku untuk job migrasi CI; tulis KAPDH_${name}`));
          assert.equal(r.docker, "");
        } finally {
          config("production");
        }
      }
      const env = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.2.0`,
        env: { RELEASE_GATE: "report" },
      });
      assert.equal(env.status, 1);
      assert.match(env.out, /RELEASE_GATE tidak berlaku untuk job migrasi CI/);
      assert.equal(env.docker, "");
    });

    it("rollback image (skema lebih baru dari journal image): roles.sql, migrasi dan seed image lama DILEWATI; gerbang tetap berjalan", () => {
      const r = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.1.0`,
        env: { FAKE_DB_MIGRATIONS: "10", FAKE_JOURNAL_TAGS: "8" },
      });
      assert.equal(r.status, 0, r.out);
      // roles.sql lama tidak pernah diterapkan (hak tabel yang dibatasi rilis baru tetap), skema dan data tidak diubah.
      assert.deepEqual(steps(r.docker), ["dump", "verify-dump", "schema", "gate-preflight", "gate"]);
      assert.doesNotMatch(r.docker, /^-- roles kapdh_migrator$/m);
      assert.match(r.out, /migrasi tercatat 10, journal image 8/);
      assert.match(r.out, /memuat 2 migrasi yang tidak dikenal image ini/);
      assert.match(r.out, /1\/6 roles\.sql DILEWATI/);
      assert.match(r.out, /4\/6 roles\.sql DILEWATI/);
      assert.match(r.out, /5\/6 seed referensi DILEWATI/);
      // Gerbang penuh tetap menolak konfigurasi yang belum disahkan pada rollback (mode enforce).
      const refused = run({
        bound: ["production"],
        command: `migrate production ${REF} v1.1.0`,
        env: { FAKE_DB_MIGRATIONS: "10", FAKE_JOURNAL_TAGS: "8", FAKE_GATE_EXIT: "1" },
      });
      assert.equal(refused.status, 1);
      assert.match(refused.out, /image JANGAN dideploy/);

      // Skema sama dengan journal (deploy ulang tag yang sama) atau tertinggal: urutan normal.
      for (const count of ["8", "0"]) {
        const same = run({ command: `migrate staging ${REF}`, env: { FAKE_DB_MIGRATIONS: count } });
        assert.equal(same.status, 0, same.out);
        assert.deepEqual(steps(same.docker), ["schema", "roles", "migrate", "roles", "seed", "gate"]);
      }
    });

    it("versi skema tidak terbaca atau journal image tidak ada: berhenti sebelum roles.sql", () => {
      const unreadable = run({ command: `migrate staging ${REF}`, env: { FAKE_SCHEMA_FAIL: "1" } });
      assert.equal(unreadable.status, 1);
      assert.match(unreadable.out, /versi skema database tidak dapat dibaca/);
      assert.deepEqual(steps(unreadable.docker), ["schema"]);

      const invalid = run({ command: `migrate staging ${REF}`, env: { FAKE_DB_MIGRATIONS: "t" } });
      assert.equal(invalid.status, 1);
      assert.match(invalid.out, /jumlah migrasi tercatat tidak valid/);

      const noJournal = run({ command: `migrate staging ${REF}`, env: { FAKE_NO_JOURNAL: "1" } });
      assert.equal(noJournal.status, 1);
      assert.match(noJournal.out, /tidak memuat journal migrasi/);
      assert.deepEqual(steps(noJournal.docker), []);

      const emptyJournal = run({ command: `migrate staging ${REF}`, env: { FAKE_JOURNAL_TAGS: "0" } });
      assert.equal(emptyJournal.status, 1);
      assert.match(emptyJournal.out, /journal migrasi image kosong/);
      assert.deepEqual(steps(emptyJournal.docker), []);
    });

    it("pengelola infra dapat menjalankan manual dengan argumen yang sama (lingkungan tetap terikat)", () => {
      const ok = run({ bound: ["staging"], args: ["migrate", "staging", REF] });
      assert.equal(ok.status, 0, ok.out);
      const cross = run({ bound: ["staging"], args: ["migrate", "production", REF, "v1.0.0"] });
      assert.equal(cross.status, 1);
    });
  },
);
