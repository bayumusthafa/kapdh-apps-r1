#!/usr/bin/env node
// Membangkitkan tipe TypeScript dari kontrak (PRD 5.2, N-13):
// - src/generated/api.ts: openapi-typescript dari dist/openapi.yaml;
// - src/generated/enums.ts: nilai runtime setiap enum string bernama;
// - src/generated/realtime-schemas.ts + realtime.ts: amplop dan payload per jenis event dari events/*.schema.json
//   (ARCHITECTURE §4.9), termasuk peta RealtimePayloads dan union terdiskriminasi RealtimeEvent.
// Berkas hanya ditulis bila isinya berubah sehingga aman dijalankan paralel oleh turbo.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { parse } from "yaml";
import { analyzeEvents, readEventFiles } from "./lib/events.mjs";
import { PATHS, rel, writeIfChanged } from "./lib/fs.mjs";
import { renderRealtimeTs } from "./lib/ts-realtime.mjs";

const report = (file, written) => console.log(`${rel(file)} ${written ? "ditulis" : "tidak berubah"}.`);

const ast = await openapiTS(pathToFileURL(PATHS.bundle), {
  // Kontrak wajib tanpa galat lint; peringatan redocly tidak perlu diulang di sini.
  silent: true,
});
report(PATHS.tsOut, writeIfChanged(PATHS.tsOut, COMMENT_HEADER + astToString(ast)));

// Nilai runtime setiap enum string bernama (mis. ERROR_CODE_VALUES, PERMISSION_VALUES) untuk pemeriksaan
// kelengkapan katalog, filter admin, dan daftar izin super_admin.
const bundle = parse(readFileSync(PATHS.bundle, "utf8"));
const enumLines = [];
for (const [name, schema] of Object.entries(bundle.components?.schemas ?? {})) {
  if (schema?.type !== "string" || !Array.isArray(schema.enum)) continue;
  const constName = `${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_VALUES`;
  enumLines.push(
    `/** Nilai enum ${name}. */`,
    `export const ${constName} = ${JSON.stringify(schema.enum)} as const satisfies readonly Schemas["${name}"][];`,
    "",
  );
}
const enums = `/**
 * DIBANGKITKAN oleh packages/contracts/scripts/gen-ts.mjs dari dist/openapi.yaml. JANGAN DISUNTING.
 */
import type { components } from "./api.js";

type Schemas = components["schemas"];

${enumLines.join("\n")}`;
report(PATHS.tsEnumsOut, writeIfChanged(PATHS.tsEnumsOut, enums));

// ------------------------------------------------------------------ event realtime
const { files, errors: readErrors } = readEventFiles(PATHS.eventsDir);
const analysis = analyzeEvents(files);
const eventErrors = [...readErrors, ...analysis.errors];
if (eventErrors.length) {
  console.error(
    `events/*.schema.json tidak valid (${eventErrors.length} galat); jalankan pnpm contracts:lint:`,
  );
  for (const e of eventErrors) console.error(`  - ${e}`);
  process.exit(1);
}
const { schemasTs, realtimeTs } = await renderRealtimeTs(analysis);
report(PATHS.tsRealtimeSchemasOut, writeIfChanged(PATHS.tsRealtimeSchemasOut, schemasTs));
report(PATHS.tsRealtimeOut, writeIfChanged(PATHS.tsRealtimeOut, realtimeTs));
