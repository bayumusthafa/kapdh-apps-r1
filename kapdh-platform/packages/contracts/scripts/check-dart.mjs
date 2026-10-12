#!/usr/bin/env node
// Verifikasi SDK Dart terbangkit dengan toolchain Dart (PRD 5.2, N-13; ARCHITECTURE §6: `dart analyze` tanpa
// galat/peringatan/info):
// 1. paket nyata dart/kapdh_api: `dart pub get`, `dart analyze --fatal-infos`, `dart test`;
// 2. paket fixture (.dart_tool/kapdh_api_fixture, di-gitignore): SDK dibangkitkan dari kontrak nyata + fixture
//    scripts/test/fixtures/sdk (konstruksi yang belum dipakai kontrak produk), lalu analyze dan test
//    scripts/test/fixtures/sdk/fixture_test.dart.
// Jalankan lewat `pnpm contracts:test-dart` (membangkitkan ulang bundle dan SDK lebih dulu). Dart dicari dari env
// DART, PATH, atau C:\flutter\flutter\bin (mesin build Windows, ARCHITECTURE §1).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parse } from "yaml";
import { fixtureInputs, FIXTURE_DIR } from "./lib/dart/fixture.mjs";
import { generateDartSdk } from "./lib/dart/generate.mjs";
import { PACKAGE_ROOT, PATHS, rel, syncDirectory } from "./lib/fs.mjs";
import { loadSharedCatalog } from "./lib/shared-catalog.mjs";

const isWindows = process.platform === "win32";
const only = process.argv.includes("--real-only")
  ? "real"
  : process.argv.includes("--fixture-only")
    ? "fixture"
    : "all";

function fail(message) {
  console.error(`check-dart: ${message}`);
  process.exit(1);
}

function findDart() {
  if (process.env.DART) return process.env.DART;
  const names = isWindows ? ["dart.bat", "dart.exe"] : ["dart"];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (isWindows) dirs.push("C:\\flutter\\flutter\\bin");
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return fail("Dart SDK tidak ditemukan; set env DART atau tambahkan Flutter/Dart bin ke PATH");
}

const dart = findDart();

function run(cwd, args) {
  console.log(`\n$ dart ${args.join(" ")}   (${rel(cwd)})`);
  // .bat di Windows wajib lewat shell (Node menolak spawn .bat tanpa shell); argumen di sini statis tanpa spasi.
  const result = isWindows
    ? spawnSync(`"${dart}" ${args.join(" ")}`, { cwd, stdio: "inherit", shell: true })
    : spawnSync(dart, args, { cwd, stdio: "inherit" });
  return result.status === 0;
}

function verifyPackage(dir, { offline = false } = {}) {
  const pubGet = offline
    ? run(dir, ["pub", "get", "--offline"]) || run(dir, ["pub", "get"])
    : run(dir, ["pub", "get"]);
  if (!pubGet) fail(`dart pub get gagal di ${rel(dir)}`);
  if (!run(dir, ["analyze", "--fatal-infos"])) fail(`dart analyze menemukan masalah di ${rel(dir)}`);
  if (!run(dir, ["test"])) fail(`dart test gagal di ${rel(dir)}`);
}

if (!existsSync(join(PATHS.dartSrc, "generated.dart")))
  fail(`${rel(PATHS.dartSrc)} belum dibangkitkan; jalankan \`pnpm contracts:gen\``);

if (only !== "fixture") verifyPackage(PATHS.dartPackage);

if (only !== "real") {
  const fixtureDir = join(PACKAGE_ROOT, ".dart_tool", "kapdh_api_fixture");
  const { bundle, events } = fixtureInputs(parse(readFileSync(PATHS.bundle, "utf8")));
  const { files, errors, stats } = generateDartSdk({ bundle, events, shared: await loadSharedCatalog() });
  if (errors.length) fail(`SDK fixture tidak dapat dibangkitkan:\n  - ${errors.join("\n  - ")}`);
  rmSync(join(fixtureDir, "test"), { recursive: true, force: true });
  mkdirSync(join(fixtureDir, "lib"), { recursive: true });
  mkdirSync(join(fixtureDir, "test"), { recursive: true });
  for (const file of ["pubspec.yaml", "analysis_options.yaml", "pubspec.lock"]) {
    if (existsSync(join(PATHS.dartPackage, file)))
      copyFileSync(join(PATHS.dartPackage, file), join(fixtureDir, file));
  }
  copyFileSync(join(PATHS.dartPackage, "lib", "kapdh_api.dart"), join(fixtureDir, "lib", "kapdh_api.dart"));
  copyFileSync(join(FIXTURE_DIR, "fixture_test.dart"), join(fixtureDir, "test", "fixture_test.dart"));
  syncDirectory(join(fixtureDir, "lib", "src"), files);
  console.log(
    `\nSDK fixture: ${Object.keys(files).length} berkas, ${stats.types} tipe, ${stats.apis} kelas API, ` +
      `${stats.operations} operasi di ${rel(fixtureDir)}`,
  );
  verifyPackage(fixtureDir, { offline: true });
}
console.log("\ncheck-dart: SDK Dart lolos analyze (tanpa info) dan test.");
