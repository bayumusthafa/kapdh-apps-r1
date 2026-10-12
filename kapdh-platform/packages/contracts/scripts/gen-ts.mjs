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
import { analyzeEvents, eventComponentSchemas, payloadKinds, readEventFiles } from "./lib/events.mjs";
import { PATHS, rel, writeIfChanged } from "./lib/fs.mjs";

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
const schemas = eventComponentSchemas(analysis);
const realtimeAst = await openapiTS(
  {
    openapi: "3.1.0",
    info: { title: "Event realtime KAPDH", version: String(analysis.version) },
    paths: {},
    components: { schemas },
  },
  { silent: true },
);
const realtimeSchemas = `/**
 * DIBANGKITKAN oleh packages/contracts/scripts/gen-ts.mjs dari events/*.schema.json. JANGAN DISUNTING.
 * Skema event realtime sebagai komponen OpenAPI; pakai tipe bernama dari ./realtime.ts.
 */
${astToString(realtimeAst)}`;
report(PATHS.tsRealtimeSchemasOut, writeIfChanged(PATHS.tsRealtimeSchemasOut, realtimeSchemas));

const kinds = payloadKinds(analysis);
const constList = (list) => `${JSON.stringify(list)} as const satisfies readonly RealtimeEventType[]`;
const payloadEntries = kinds.map(({ type, kind, title }) => {
  if (kind === "schema")
    return `  /** events/${type}.schema.json */\n  ${JSON.stringify(type)}: RealtimeSchemas[${JSON.stringify(title)}];`;
  if (kind === "none")
    return `  /** Tanpa payload (x-kapdh-payload-less): selalu {}. */\n  ${JSON.stringify(type)}: Record<string, never>;`;
  return `  /** Skema payload belum ditulis (x-kapdh-payload-pending, C6): objek bebas. */\n  ${JSON.stringify(type)}: Record<string, unknown>;`;
});
const namedTypes = [...analysis.payloads.values(), ...analysis.shared]
  .map((s) => s.title)
  .sort()
  .map((t) => `export type ${t} = RealtimeSchemas[${JSON.stringify(t)}];`);
const realtime = `/**
 * DIBANGKITKAN oleh packages/contracts/scripts/gen-ts.mjs dari events/*.schema.json. JANGAN DISUNTING.
 * Event Socket.IO /realtime (PRD 5.2, ARCHITECTURE §4.9): amplop {v, event_id, type, entity_id, ts, payload}.
 */
import type { components } from "./realtime-schemas.js";

type RealtimeSchemas = components["schemas"];

/** Versi amplop event realtime. */
export const REALTIME_ENVELOPE_VERSION = ${JSON.stringify(analysis.version)} as const;

/** Jenis event server ke klien. */
export const REALTIME_EVENT_TYPES = ${JSON.stringify(analysis.types)} as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/** Jenis event yang payload-nya selalu {} (x-kapdh-payload-less). */
export const REALTIME_PAYLOAD_LESS_TYPES = ${constList(analysis.payloadLess)};

/** Jenis event yang skema payload-nya belum ditulis (x-kapdh-payload-pending, penulis kontrak C6). */
export const REALTIME_PAYLOAD_PENDING_TYPES = ${constList(analysis.pending)};

/** Payload minimum per jenis event. */
export interface RealtimePayloads {
${payloadEntries.join("\n")}
}

/** Amplop event; \`T\` mempersempit jenis dan payload-nya. */
export type RealtimeEnvelope<T extends RealtimeEventType = RealtimeEventType> = Omit<
  RealtimeSchemas["RealtimeEnvelope"],
  "type" | "payload"
> & {
  type: T;
  payload: RealtimePayloads[T];
};

/** Union terdiskriminasi semua event: \`switch (event.type)\` mempersempit tipe payload. */
export type RealtimeEvent = { [K in RealtimeEventType]: RealtimeEnvelope<K> }[RealtimeEventType];
${namedTypes.length ? `\n${namedTypes.join("\n")}\n` : ""}`;
report(PATHS.tsRealtimeOut, writeIfChanged(PATHS.tsRealtimeOut, realtime));
