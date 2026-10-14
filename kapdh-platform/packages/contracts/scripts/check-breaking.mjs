#!/usr/bin/env node
// Gerbang perubahan kontrak yang memutus klien (N-13, PRD 5.2, U-13; temuan audit D2-12).
//
// Membandingkan kontrak kepala (openapi/ dirakit ulang) dengan kontrak rilis terakhir (tag `contracts-vX.Y.Z`
// tertinggi, atau --base-ref) memakai `oasdiff breaking`, lalu menerapkan kebijakan di scripts/lib/breaking.mjs:
// lulus bila aditif; perubahan memutus hanya lulus bila versi mayor info.version DAN info.x-kapdh-min-app-version
// naik bersama. Juga memastikan info.version = package.json = pubspec kapdh_api.
//
// Kontrak dasar diambil dari tag: dist/openapi.yaml yang ikut di commit rilis (release-dart-sdk.mjs), atau bila tidak
// ada (tag lama), dirakit dari openapi/ pada tag itu dengan perakit saat ini. Sebelum ada tag rilis kontrak, belum
// ada klien yang didukung sehingga gerbang lulus dengan pemberitahuan (oasdiff tetap diuji memuat kontrak kepala).
//
// Pemakaian (dari kapdh-platform): pnpm contracts:breaking [-- opsi]
//   --base-ref <ref>       pembanding selain tag contracts-v* tertinggi (mis. tag sebelumnya, commit)
//   --oasdiff <path>       biner oasdiff (bawaan: env OASDIFF, lalu `oasdiff` di PATH)
//   --changes-json <file>  pakai keluaran `oasdiff breaking --format json` yang sudah ada (uji kering tanpa oasdiff)
//   --report <file.md>     tulis laporan Markdown (juga ke GITHUB_STEP_SUMMARY bila ada)
//   --head-out <file>      simpan bundle kepala (untuk artefak CI)
// Keluar 0 lulus, 1 gagal kebijakan, 2 galat alat (oasdiff/git tidak dapat dijalankan).
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadSources, renderBundle } from "./assemble.mjs";
import { assemble } from "./lib/assemble.mjs";
import {
  compareSemver,
  contractMeta,
  evaluateCompatibility,
  normalizeChanges,
  parseSemver,
  renderReport,
  versionConsistency,
} from "./lib/breaking.mjs";
import { PACKAGE_ROOT, PATHS } from "./lib/fs.mjs";

const TAG_PREFIX = "contracts-v";

class ToolError extends Error {}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let topLevel;
const top = () =>
  (topLevel ??= execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  }).trim());

/** Semua perintah git dari akar repo agar pathspec relatif akar (bukan folder paket). */
function git(args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd: top(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new ToolError(`git ${args.join(" ")} gagal: ${(r.stderr ?? "").trim()}`);
  }
  return r.stdout;
}

/** Tag contracts-v* dengan versi semver tertinggi, atau null. */
export function latestContractsTag(tags) {
  const valid = tags
    .map((t) => t.trim())
    .filter((t) => t.startsWith(TAG_PREFIX) && parseSemver(t.slice(TAG_PREFIX.length)))
    .sort((a, b) => compareSemver(b.slice(TAG_PREFIX.length), a.slice(TAG_PREFIX.length)));
  return valid[0] ?? null;
}

function assembleOrThrow(srcDir, label) {
  const { doc, errors } = assemble(loadSources(srcDir));
  if (errors.length > 0)
    throw new ToolError(`kontrak ${label} tidak dapat dirakit:\n  - ${errors.join("\n  - ")}`);
  return doc;
}

/** Kontrak pada ref git: bundle rilis bila ada, selain itu dirakit dari openapi/ pada ref tersebut. */
function contractAtRef(ref, work) {
  const pkgPath = relative(top(), PACKAGE_ROOT).split("\\").join("/");
  const bundled = git(["show", `${ref}:${pkgPath}/dist/openapi.yaml`], { allowFail: true });
  if (bundled !== null) return { doc: parse(bundled), source: "dist/openapi.yaml pada tag rilis" };
  const listing = git(["ls-tree", "-r", "--name-only", ref, "--", `${pkgPath}/openapi`])
    .split("\n")
    .filter((f) => f.endsWith(".yaml"));
  if (listing.length === 0) throw new ToolError(`ref ${ref} tidak memuat ${pkgPath}/openapi`);
  const dir = join(work, "base-openapi");
  const contents = readBlobs(listing.map((file) => `${ref}:${file}`));
  listing.forEach((file, i) => {
    const target = join(dir, file.slice(`${pkgPath}/openapi/`.length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents[i]);
  });
  return { doc: assembleOrThrow(dir, `pada ${ref}`), source: "dirakit dari openapi/ pada ref" };
}

/** Membaca banyak blob `<ref>:<path>` dalam satu proses `git cat-file --batch`. */
function readBlobs(specs) {
  const r = spawnSync("git", ["cat-file", "--batch"], {
    cwd: top(),
    input: `${specs.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new ToolError(`git cat-file gagal: ${String(r.stderr).trim()}`);
  const out = r.stdout;
  const blobs = [];
  let pos = 0;
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl).toString("utf8");
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) throw new ToolError(`blob ${spec} tidak ditemukan (${header})`);
    const size = Number(m[1]);
    blobs.push(out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

function findOasdiff() {
  return arg("--oasdiff") ?? process.env.OASDIFF ?? "oasdiff";
}

function runOasdiff(bin, base, head) {
  const r = spawnSync(bin, ["breaking", base, head, "--format", "json", "--color", "never"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new ToolError(`oasdiff tidak dapat dijalankan (${bin}): ${r.error.message}`);
  if (r.status !== 0)
    throw new ToolError(`oasdiff keluar ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 2000)}`);
  try {
    return normalizeChanges(JSON.parse(r.stdout.trim() === "" ? "[]" : r.stdout));
  } catch (e) {
    throw new ToolError(`keluaran oasdiff tidak dapat dibaca: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function pubspecVersion() {
  const text = readFileSync(join(PATHS.dartPackage, "pubspec.yaml"), "utf8");
  return /^version:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null;
}

function emitReport(markdown) {
  console.log(`\n${markdown}\n`);
  const out = arg("--report");
  if (out) writeFileSync(resolve(out), `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

const annotate = (level, title, message) =>
  console.log(`::${level} title=${title}::${String(message).replaceAll("\n", " ")}`);

export function main() {
  const work = mkdtempSync(join(tmpdir(), "kapdh-contract-compat-"));
  try {
    // 1. Kontrak kepala dan konsistensi versi.
    const headDoc = assembleOrThrow(PATHS.openapiDir, "kepala");
    const headFile = join(work, "head.yaml");
    writeFileSync(headFile, renderBundle(headDoc));
    if (arg("--head-out")) writeFileSync(resolve(arg("--head-out")), renderBundle(headDoc));
    const head = contractMeta(headDoc);
    const consistency = versionConsistency({
      infoVersion: head.version,
      packageVersion: JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version,
      pubspecVersion: pubspecVersion(),
    });
    for (const p of consistency) annotate("error", "Versi kontrak tidak konsisten", p);

    // 2. Pembanding.
    const baseRef =
      arg("--base-ref") ?? latestContractsTag((git(["tag", "--list", `${TAG_PREFIX}*`]) ?? "").split("\n"));
    const changesJson = arg("--changes-json");
    const bin = findOasdiff();
    if (!changesJson && !process.argv.includes("--no-self-check")) {
      // oasdiff harus dapat memuat kontrak OpenAPI 3.1 kepala; diff dengan dirinya sendiri wajib kosong.
      const self = runOasdiff(bin, headFile, headFile);
      if (self.length > 0)
        throw new ToolError(`oasdiff melaporkan ${self.length} perubahan pada diff kepala-kepala`);
      console.log("oasdiff memuat kontrak kepala (OpenAPI 3.1) tanpa galat.");
    }
    if (!baseRef) {
      annotate(
        "notice",
        "Gerbang kontrak N-13",
        `Belum ada tag ${TAG_PREFIX}*; belum ada klien rilis yang didukung sehingga tidak ada pembanding. ` +
          "Tag pertama dibuat lewat workflow Release (aksi contracts-sdk).",
      );
      emitReport(
        `### Gerbang kontrak N-13: belum ada rilis kontrak\n\nTidak ada tag \`${TAG_PREFIX}*\`; ` +
          `kontrak kepala versi ${head.version} (aplikasi minimum ${head.minAppVersion ?? "-"}) menjadi garis dasar ` +
          "pada rilis SDK pertama." +
          (consistency.length ? `\n\nMasalah:\n${consistency.map((p) => `- ${p}`).join("\n")}` : ""),
      );
      return consistency.length === 0 ? 0 : 1;
    }

    // 3. Kontrak dasar dan diff.
    const { doc: baseDoc, source } = contractAtRef(baseRef, work);
    const baseFile = join(work, "base.yaml");
    writeFileSync(baseFile, renderBundle(baseDoc));
    console.log(`Pembanding ${baseRef}: ${source}.`);
    const changes = changesJson
      ? normalizeChanges(JSON.parse(readFileSync(changesJson, "utf8")))
      : runOasdiff(bin, baseFile, headFile);

    // 4. Kebijakan.
    const base = contractMeta(baseDoc);
    const result = evaluateCompatibility({ changes, base, head });
    result.problems.unshift(...consistency);
    result.ok = result.problems.length === 0;
    if (!result.ok && result.verdict === "breaking-approved") result.verdict = "breaking-blocked";
    for (const c of result.breaking)
      annotate(
        result.ok ? "warning" : "error",
        `Kontrak memutus: ${c.id}`,
        `${[c.operation, c.path].filter(Boolean).join(" ")} ${c.text ?? ""}`,
      );
    for (const p of result.problems) annotate("error", "Gerbang kontrak N-13", p);
    emitReport(renderReport({ baseRef, base, head, result }));
    return result.ok ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    annotate("error", "check-breaking", e instanceof Error ? e.message : String(e));
    process.exitCode = e instanceof ToolError ? 2 : 1;
  }
}
