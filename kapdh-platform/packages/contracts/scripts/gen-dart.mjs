#!/usr/bin/env node
// Membangkitkan SDK Dart `kapdh_api` dari dist/openapi.yaml dan events/*.schema.json (PRD 5.2: "OpenAPI 3.1
// menghasilkan SDK Dart"; N-13) tanpa Java: model imutabel, enum dengan nilai cadangan `unknown`, satu kelas API per
// tag di atas Dio yang diinjeksi, ApiException dari skema Error, event realtime bertipe, serta katalog galat dan
// rute status dari @kapdh/shared.
//
// Keluaran: packages/contracts/dart/kapdh_api/lib/src/** (di-gitignore; jalankan `pnpm contracts:gen`).
// Berkas tulisan tangan (pubspec.yaml, analysis_options.yaml, lib/kapdh_api.dart, test/) tidak disentuh.
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { generateDartSdk } from "./lib/dart/generate.mjs";
import { analyzeEvents, readEventFiles } from "./lib/events.mjs";
import { PATHS, rel, syncDirectory } from "./lib/fs.mjs";
import { loadSharedCatalog } from "./lib/shared-catalog.mjs";

function fail(errors) {
  console.error(`SDK Dart tidak dapat dibangkitkan (${errors.length} galat):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (!existsSync(PATHS.bundle))
  fail([`${rel(PATHS.bundle)} belum ada; jalankan \`pnpm --filter @kapdh/contracts bundle\``]);
const bundle = parse(readFileSync(PATHS.bundle, "utf8"));
const { files: eventFiles, errors: readErrors } = readEventFiles(PATHS.eventsDir);
if (readErrors.length) fail(readErrors);
const events = analyzeEvents(eventFiles);
const shared = await loadSharedCatalog();

const { files, errors, stats } = generateDartSdk({ bundle, events, shared });
if (errors.length) fail(errors);

const { written, removed } = syncDirectory(PATHS.dartSrc, files);
console.log(
  `${rel(PATHS.dartSrc)}: ${Object.keys(files).length} berkas (${written} ditulis, ${removed} dihapus); ` +
    `${stats.types} tipe, ${stats.apis} kelas API, ${stats.operations} operasi.`,
);
