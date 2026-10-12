// Pembangkit tipe TypeScript event realtime (PRD 5.2, ARCHITECTURE §4.9): skema events/*.schema.json dijadikan
// komponen OpenAPI lalu dirender openapi-typescript (realtime-schemas.ts), ditambah peta RealtimePayloads, amplop
// generik dan union terdiskriminasi RealtimeEvent (realtime.ts). Murni selain pemanggilan openapi-typescript.
import openapiTS, { astToString } from "openapi-typescript";
import { ENVELOPE_TITLE, eventComponentSchemas, payloadKinds } from "./events.mjs";

/**
 * @param {ReturnType<typeof import("./events.mjs").analyzeEvents>} analysis katalog event tanpa galat.
 * @returns {Promise<{ schemasTs: string, realtimeTs: string }>}
 */
export async function renderRealtimeTs(analysis) {
  const ast = await openapiTS(
    {
      openapi: "3.1.0",
      info: { title: "Event realtime KAPDH", version: String(analysis.version) },
      paths: {},
      components: { schemas: eventComponentSchemas(analysis) },
    },
    { silent: true },
  );
  const schemasTs = `/**
 * DIBANGKITKAN oleh packages/contracts/scripts/gen-ts.mjs dari events/*.schema.json. JANGAN DISUNTING.
 * Skema event realtime sebagai komponen OpenAPI; pakai tipe bernama dari ./realtime.ts.
 */
${astToString(ast)}`;

  const constList = (list) => `${JSON.stringify(list)} as const satisfies readonly RealtimeEventType[]`;
  const payloadEntries = payloadKinds(analysis).map(({ type, kind, title }) => {
    const key = JSON.stringify(type);
    if (kind === "schema")
      return `  /** events/${type}.schema.json */\n  ${key}: RealtimeSchemas[${JSON.stringify(title)}];`;
    if (kind === "none")
      return `  /** Tanpa payload (x-kapdh-payload-less): selalu {}. */\n  ${key}: Record<string, never>;`;
    return `  /** Skema payload belum ditulis (x-kapdh-payload-pending, C6): objek bebas. */\n  ${key}: Record<string, unknown>;`;
  });
  const namedTypes = [...analysis.payloads.values(), ...analysis.shared]
    .map((s) => s.title)
    .sort()
    .map((t) => `export type ${t} = RealtimeSchemas[${JSON.stringify(t)}];`);

  const realtimeTs = `/**
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
  RealtimeSchemas[${JSON.stringify(ENVELOPE_TITLE)}],
  "type" | "payload"
> & {
  type: T;
  payload: RealtimePayloads[T];
};

/** Union terdiskriminasi semua event: \`switch (event.type)\` mempersempit tipe payload. */
export type RealtimeEvent = { [K in RealtimeEventType]: RealtimeEnvelope<K> }[RealtimeEventType];
${namedTypes.length ? `\n${namedTypes.join("\n")}\n` : ""}`;
  return { schemasTs, realtimeTs };
}
