// Inti pembangkit SDK Dart `kapdh_api` (PRD 5.2, N-13): murni (tanpa I/O) sehingga dipakai bersama oleh
// scripts/gen-dart.mjs (kontrak nyata), scripts/check-dart.mjs (paket fixture) dan uji generator.
import { eventComponentSchemas } from "../events.mjs";
import { apiFileName, buildApis, renderApiFile, renderClientFile } from "./api.mjs";
import { renderCatalogs } from "./catalog.mjs";
import { ModelRegistry } from "./model.mjs";
import { renderRealtimeEvents } from "./realtime.mjs";
import {
  API_EXCEPTION_DART,
  GENERATED_HEADER,
  IO_FAILURE_DART,
  IO_FAILURE_IO_DART,
  JSON_DART,
  OPTIONAL_DART,
  OPTIONS_DART,
  REQUEST_DART,
  RETRY_DART,
} from "./runtime.mjs";

/**
 * Membangkitkan seluruh isi lib/src SDK Dart.
 * @param {{
 *   bundle: object,
 *   events: ReturnType<typeof import("../events.mjs").analyzeEvents>,
 *   shared: Awaited<ReturnType<typeof import("../shared-catalog.mjs").loadSharedCatalog>>,
 * }} input
 * @returns {{ files: Record<string, string>, errors: string[], stats: { types: number, apis: number, operations: number } }}
 */
export function generateDartSdk({ bundle, events, shared }) {
  const errors = [...events.errors];
  const registry = new ModelRegistry(bundle, { extraSchemas: eventComponentSchemas(events) }).buildAll();
  const groups = buildApis(bundle, registry);
  const catalogs = renderCatalogs(registry, shared);
  const realtime = registry.errors.length ? undefined : renderRealtimeEvents(registry, events);
  errors.push(...registry.errors);
  if (errors.length) return { files: {}, errors, stats: { types: 0, apis: 0, operations: 0 } };

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
// Model, enum dan alias dari components.schemas kontrak dan events/*.schema.json (JSON snake_case <-> field
// camelCase).

${modelImports.join("\n")}

${modelBody}
`;

  const files = {
    "models.dart": models,
    "realtime_events.dart": realtime,
    "runtime/json.dart": JSON_DART,
    "runtime/optional.dart": OPTIONAL_DART,
    "runtime/options.dart": OPTIONS_DART,
    "runtime/request.dart": REQUEST_DART,
    "runtime/retry.dart": RETRY_DART,
    "runtime/io_failure.dart": IO_FAILURE_DART,
    "runtime/io_failure_io.dart": IO_FAILURE_IO_DART,
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
    "realtime_events.dart",
    "runtime/api_exception.dart",
    "runtime/optional.dart",
    "runtime/options.dart",
    "runtime/retry.dart",
  ];
  files["generated.dart"] = `${GENERATED_HEADER}
// Barrel seluruh API publik SDK; diekspor ulang oleh lib/kapdh_api.dart.

${exportsList.map((f) => `export '${f}';`).join("\n")}
`;
  return {
    files,
    errors,
    stats: {
      types: defs.length,
      apis: groups.length,
      operations: groups.reduce((n, g) => n + g.operations.length, 0),
    },
  };
}
