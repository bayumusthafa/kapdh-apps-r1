#!/usr/bin/env node
// Membangkitkan tipe TypeScript dari dist/openapi.yaml (openapi-typescript) ke src/generated/api.ts dan tipe
// amplop realtime dari events/envelope.schema.json ke src/generated/realtime.ts (PRD 5.2, N-13).
// Berkas hanya ditulis bila isinya berubah sehingga aman dijalankan paralel oleh turbo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { parse } from "yaml";
import { PATHS, rel, writeIfChanged } from "./lib/fs.mjs";

const ast = await openapiTS(pathToFileURL(PATHS.bundle), {
  // Kontrak wajib tanpa galat lint; peringatan redocly tidak perlu diulang di sini.
  silent: true,
});
const api = COMMENT_HEADER + astToString(ast);
console.log(`${rel(PATHS.tsOut)} ${writeIfChanged(PATHS.tsOut, api) ? "ditulis" : "tidak berubah"}.`);

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
console.log(
  `${rel(PATHS.tsEnumsOut)} ${writeIfChanged(PATHS.tsEnumsOut, enums) ? "ditulis" : "tidak berubah"}.`,
);

const envelope = JSON.parse(readFileSync(join(PATHS.eventsDir, "envelope.schema.json"), "utf8"));
const types = envelope.properties?.type?.enum;
if (!Array.isArray(types) || types.length === 0 || envelope.properties?.v?.const === undefined) {
  console.error("events/envelope.schema.json: properties.type.enum dan properties.v.const wajib ada.");
  process.exit(1);
}
const realtime = `/**
 * DIBANGKITKAN oleh packages/contracts/scripts/gen-ts.mjs dari events/envelope.schema.json.
 * JANGAN DISUNTING. Amplop event Socket.IO /realtime (PRD 5.2, ARCHITECTURE §4.9).
 */

/** Versi amplop event realtime. */
export const REALTIME_ENVELOPE_VERSION = ${JSON.stringify(envelope.properties.v.const)} as const;

/** Jenis event server ke klien. */
export const REALTIME_EVENT_TYPES = ${JSON.stringify(types)} as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/** Amplop setiap event server ke klien; payload minimum per jenis event. */
export interface RealtimeEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  v: typeof REALTIME_ENVELOPE_VERSION;
  /** UUID v7 unik per event untuk deduplikasi setelah reconnect (N-02). */
  event_id: string;
  type: RealtimeEventType;
  /** ID entitas utama (pesan, room, notifikasi, pengguna, atau sesi). */
  entity_id: string;
  /** Waktu server UTC (RFC 3339). */
  ts: string;
  payload: TPayload;
}
`;
console.log(
  `${rel(PATHS.tsRealtimeOut)} ${writeIfChanged(PATHS.tsRealtimeOut, realtime) ? "ditulis" : "tidak berubah"}.`,
);
