#!/usr/bin/env node
// Membangkitkan SDK Dart `kapdh_api` dari dist/openapi.yaml (PRD 5.2: "OpenAPI 3.1 menghasilkan SDK Dart"; N-13)
// tanpa Java: model imutabel, enum dengan nilai cadangan `unknown`, satu kelas API per tag di atas Dio yang
// diinjeksi, ApiException dari skema Error, serta katalog galat dan rute status dari @kapdh/shared.
//
// Keluaran: packages/contracts/dart/kapdh_api/lib/src/** (di-gitignore; jalankan `pnpm contracts:gen`).
// Berkas tulisan tangan (pubspec.yaml, analysis_options.yaml, lib/kapdh_api.dart, test/) tidak disentuh.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { apiFileName, buildApis, renderApiFile, renderClientFile } from "./lib/dart/api.mjs";
import { renderCatalogs } from "./lib/dart/catalog.mjs";
import { ModelRegistry, omit } from "./lib/dart/model.mjs";
import {
  API_EXCEPTION_DART,
  GENERATED_HEADER,
  JSON_DART,
  OPTIONAL_DART,
  OPTIONS_DART,
  REQUEST_DART,
} from "./lib/dart/runtime.mjs";
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

// Amplop realtime (events/envelope.schema.json) ikut menjadi model Dart RealtimeEnvelope.
const envelopeFile = join(PATHS.eventsDir, "envelope.schema.json");
const envelopeSchema = JSON.parse(readFileSync(envelopeFile, "utf8"));
const envelope = omit(envelopeSchema, ["$schema", "$id", "examples", "title"]);
const registry = new ModelRegistry(bundle, { extraSchemas: { [envelopeSchema.title]: envelope } }).buildAll();
const groups = buildApis(bundle, registry);
const shared = await loadSharedCatalog();
const catalogs = renderCatalogs(registry, shared);
if (registry.errors.length) fail(registry.errors);

// models.dart: enum, alias, lalu kelas (urut nama).
const defs = [...registry.types.values()].sort((a, b) => a.name.localeCompare(b.name));
const enums = defs.filter((d) => d.kind === "enum").map((d) => registry.renderEnum(d));
const aliases = defs.filter((d) => d.kind === "alias").map((d) => registry.renderAlias(d));
const classes = defs.filter((d) => d.kind === "class").map((d) => registry.renderClass(d));
const modelBody = [...enums, ...aliases, ...classes].join("\n\n");
const modelImports = [];
if (/\b(FormData|MultipartFile)\b/.test(modelBody))
  modelImports.push("import 'package:dio/dio.dart' show FormData, MultipartFile;");
modelImports.push("import 'package:meta/meta.dart';", "");
if (/\b(read[A-Z]\w*|decode[A-Z]\w*|encode[A-Z]\w*|deepEquals|deepHash)\b/.test(modelBody)) {
  modelImports.push("import 'runtime/json.dart';");
}
if (/\bOptional</.test(modelBody)) modelImports.push("import 'runtime/optional.dart';");
const models = `${GENERATED_HEADER}
// Model, enum dan alias dari components.schemas kontrak (JSON snake_case <-> field camelCase).

${modelImports.join("\n")}

${modelBody}
`;

const files = {
  "models.dart": models,
  "runtime/json.dart": JSON_DART,
  "runtime/optional.dart": OPTIONAL_DART,
  "runtime/options.dart": OPTIONS_DART,
  "runtime/request.dart": REQUEST_DART,
  "runtime/api_exception.dart": API_EXCEPTION_DART,
  "kapdh_api_client.dart": renderClientFile(groups),
  ...catalogs,
};
for (const group of groups) files[apiFileName(group.tag)] = renderApiFile(registry, group);

const exportsList = [
  "models.dart",
  ...groups.map((g) => apiFileName(g.tag)).sort(),
  "kapdh_api_client.dart",
  "error_catalog.dart",
  "status_routes.dart",
  "runtime/api_exception.dart",
  "runtime/optional.dart",
  "runtime/options.dart",
];
files["generated.dart"] = `${GENERATED_HEADER}
// Barrel seluruh API publik SDK; diekspor ulang oleh lib/kapdh_api.dart.

${exportsList.map((f) => `export '${f}';`).join("\n")}
`;

const { written, removed } = syncDirectory(PATHS.dartSrc, files);
const operations = groups.reduce((n, g) => n + g.operations.length, 0);
console.log(
  `${rel(PATHS.dartSrc)}: ${Object.keys(files).length} berkas (${written} ditulis, ${removed} dihapus); ` +
    `${defs.length} tipe, ${groups.length} kelas API, ${operations} operasi.`,
);
