#!/usr/bin/env node
// Rilis SDK Dart `kapdh_api` sebagai dependensi git bertag `contracts-vX.Y.Z` (ADR-001, PRD 7.2: repo Flutter terpisah
// memakai SDK bertag; N-13).
//
// Masalah yang diselesaikan: lib/src/** SDK dibangkitkan dan di-gitignore (ARCHITECTURE §6), sehingga commit biasa
// di main tidak berisi kode SDK dan dependensi git ke tag biasa akan gagal dikompilasi. Skrip ini:
// 1. memastikan sumber kontrak bersih (tidak ada perubahan belum di-commit di packages/contracts dan packages/shared)
//    dan versi package.json @kapdh/contracts = versi pubspec.yaml kapdh_api;
// 2. membangkitkan ulang bundle dan SDK dari HEAD;
// 3. membuat commit rilis TERPISAH (anak HEAD, tidak memindahkan branch mana pun dan tidak menyentuh index/working
//    tree) berisi pohon HEAD + lib/src terbangkit + dist/openapi.yaml (kontrak rilis yang dibekukan; menjadi
//    pembanding gerbang N-13 `pnpm contracts:breaking`), lalu tag beranotasi `contracts-v<versi>` menunjuk commit itu.
// Main tetap tanpa berkas terbangkit; hanya tag rilis yang membawanya. Di CI dijalankan oleh workflow Release
// (aksi contracts-sdk), yang juga mendorong tag dan memverifikasi isinya (docs/runbooks/ci-cd.md).
//
// Pemakaian (dari kapdh-platform): pnpm contracts:release-sdk [--dry-run]
// Lalu: git push origin contracts-v<versi>. Repo Flutter terpisah memakai:
//   kapdh_api:
//     git:
//       url: <URL repo KAPDHAPPS>
//       path: kapdh-platform/packages/contracts/dart/kapdh_api
//       ref: contracts-v<versi>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PACKAGE_ROOT, PATHS, PLATFORM_ROOT } from "./lib/fs.mjs";

const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`release-dart-sdk: ${message}`);
  process.exit(1);
}

// Semua perintah git dijalankan dari akar repo dengan path relatif akar.
const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: PACKAGE_ROOT,
  encoding: "utf8",
}).trim();

function git(args, { env, input } = {}) {
  return execFileSync("git", args, {
    cwd: top,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Versi dari pubspec.yaml (baris `version: X.Y.Z`). */
function pubspecVersion(text) {
  return /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(text)?.[1];
}

const toGitPath = (abs) => relative(top, abs).split("\\").join("/");
const packageVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
const dartVersion = pubspecVersion(readFileSync(join(PATHS.dartPackage, "pubspec.yaml"), "utf8"));
if (!dartVersion) fail("dart/kapdh_api/pubspec.yaml tidak memiliki `version: X.Y.Z`");
if (packageVersion !== dartVersion)
  fail(
    `versi @kapdh/contracts (${packageVersion}) berbeda dengan kapdh_api (${dartVersion}); samakan keduanya ` +
      "dan catat di packages/contracts/CHANGELOG.md",
  );
const tag = `contracts-v${dartVersion}`;

const sourcePaths = [PACKAGE_ROOT, join(PLATFORM_ROOT, "packages", "shared")].map(toGitPath);
const dirty = git(["status", "--porcelain", "--", ...sourcePaths]);
if (dirty) fail(`sumber kontrak belum di-commit; SDK rilis harus sama persis dengan HEAD:\n${dirty}`);
if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: top }).status === 0)
  fail(`tag ${tag} sudah ada; naikkan versi (N-13) sebelum merilis ulang`);

// Bangkitkan ulang bundle dan SDK dari HEAD.
for (const script of ["assemble.mjs", "gen-dart.mjs"]) {
  const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, "scripts", script)], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`scripts/${script} gagal`);
}

// Pohon rilis = pohon HEAD + lib/src terbangkit, lewat index sementara (index dan working tree asli tidak berubah).
const head = git(["rev-parse", "HEAD"]);
const tmp = mkdtempSync(join(tmpdir(), "kapdh-sdk-release-"));
const env = { GIT_INDEX_FILE: join(tmp, "index") };
let tree;
let added;
try {
  git(["read-tree", head], { env });
  git(["add", "--force", "--", toGitPath(PATHS.dartSrc), toGitPath(PATHS.bundle)], { env });
  tree = git(["write-tree"], { env });
  added = git(["diff-tree", "-r", "--name-only", "--no-commit-id", `${head}^{tree}`, tree], {}).split("\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const generatedEntry = `${toGitPath(PATHS.dartSrc)}/generated.dart`;
if (!added.includes(generatedEntry)) fail(`${generatedEntry} tidak masuk pohon rilis`);
if (!added.includes(toGitPath(PATHS.bundle))) fail(`${toGitPath(PATHS.bundle)} tidak masuk pohon rilis`);
console.log(
  `\nPohon rilis ${tree}: ${added.length} berkas SDK terbangkit ditambahkan ke HEAD ${head.slice(0, 12)}.`,
);

if (dryRun) {
  console.log(`--dry-run: tag ${tag} tidak dibuat.`);
  process.exit(0);
}
const message =
  `release(contracts): kapdh_api ${dartVersion} (SDK Dart terbangkit, ADR-001)\n\n` +
  `Pohon HEAD ${head} ditambah ${toGitPath(PATHS.dartSrc)}/** hasil gen-dart.mjs dan ` +
  `${toGitPath(PATHS.bundle)} hasil assemble.mjs (pembanding N-13).`;
const commit = git(["commit-tree", tree, "-p", head, "-F", "-"], { input: message });
git([
  "tag",
  "-a",
  tag,
  commit,
  "-m",
  `kapdh_api ${dartVersion} (kontrak @kapdh/contracts ${packageVersion})`,
]);
console.log(`Tag ${tag} -> ${commit.slice(0, 12)} dibuat. Dorong dengan: git push origin ${tag}`);
