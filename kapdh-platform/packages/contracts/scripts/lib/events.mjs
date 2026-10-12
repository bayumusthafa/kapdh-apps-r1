// Katalog skema event realtime packages/contracts/events/*.schema.json (PRD 5.2, ARCHITECTURE §4.9).
// Murni (tanpa I/O kecuali readEventFiles) agar dipakai bersama oleh validate-events, gen-ts, gen-dart dan uji.
//
// Aturan katalog:
// - envelope.schema.json: amplop {v, event_id, type, entity_id, ts, payload}; `properties.type.enum` = jenis event.
// - events/<type>.schema.json (nama berkas = jenis event, mis. message.created.schema.json): payload jenis itu,
//   title `<Type>Payload` (MessageCreatedPayload), objek dengan `additionalProperties: false`, properti snake_case.
// - Berkas lain = skema bersama yang dirujuk payload lewat `$id` (utuh, tanpa fragmen).
// - Setiap jenis event WAJIB memiliki berkas payload, atau terdaftar eksplisit di amplop:
//   `x-kapdh-payload-less` (payload selalu `{}`) atau `x-kapdh-payload-pending` (skema belum ditulis penulis
//   kontrak C6; payload bertipe objek bebas dan lint memberi peringatan).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { pascalCase } from "./names.mjs";

export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
export const ENVELOPE_FILE = "envelope.schema.json";
/** Nama tipe amplop di TS/Dart. */
export const ENVELOPE_TITLE = "RealtimeEnvelope";
export const ENVELOPE_FIELDS = ["v", "event_id", "type", "entity_id", "ts", "payload"];
/** Anotasi amplop: jenis event yang payload-nya selalu objek kosong. */
export const PAYLOAD_LESS_KEY = "x-kapdh-payload-less";
/** Anotasi amplop: jenis event yang skema payload-nya belum ditulis (C6). */
export const PAYLOAD_PENDING_KEY = "x-kapdh-payload-pending";
/** Kata kunci anotasi yang dikenal (Ajv strict menolak kata kunci lain). */
export const ANNOTATION_KEYWORDS = [PAYLOAD_LESS_KEY, PAYLOAD_PENDING_KEY, "x-sensitive"];

const SCHEMA_SUFFIX = ".schema.json";
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const COMPONENT_REF = "#/components/schemas/";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Nama tipe payload untuk jenis event: `room.member_changed` -> `RoomMemberChangedPayload`. */
export function payloadTitle(type) {
  return `${pascalCase(type)}Payload`;
}

/** Ajv 2020-12 mode strict dengan format dan anotasi katalog. */
export function createEventsAjv() {
  const addFormats = addFormatsModule.default ?? addFormatsModule;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addVocabulary(ANNOTATION_KEYWORDS);
  return ajv;
}

/** Membaca semua berkas .json di direktori events (urut nama). */
export function readEventFiles(dir) {
  const files = [];
  const errors = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    try {
      files.push({ file, schema: JSON.parse(readFileSync(join(dir, file), "utf8")) });
    } catch (error) {
      errors.push(
        `events/${file}: JSON tidak valid (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return { files, errors };
}

/** Semua `$ref` dalam skema beserta lokasinya. */
function collectRefs(node, path = "", out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => collectRefs(v, `${path}/${i}`, out));
  else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push({ ref: v, at: path || "/" });
      else collectRefs(v, `${path}/${k}`, out);
    }
  }
  return out;
}

/** Nama properti (kunci `properties`) di semua tingkat. */
function collectPropertyNames(node, path = "", out = []) {
  if (Array.isArray(node)) node.forEach((v, i) => collectPropertyNames(v, `${path}/${i}`, out));
  else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "properties" && isObject(v)) {
        for (const name of Object.keys(v)) out.push({ name, at: `${path}/properties/${name}` });
      }
      collectPropertyNames(v, `${path}/${k}`, out);
    }
  }
  return out;
}

/**
 * Menganalisis katalog event dari berkas yang sudah dibaca. Tidak mengompilasi Ajv (lihat validate-events).
 * @param {{file: string, schema: any}[]} files
 */
export function analyzeEvents(files) {
  const errors = [];
  const warnings = [];
  const byId = new Map();
  const titles = new Map();
  for (const { file, schema } of files) {
    if (!file.endsWith(SCHEMA_SUFFIX)) {
      errors.push(`events/${file}: nama berkas skema wajib berakhiran ${SCHEMA_SUFFIX}`);
      continue;
    }
    if (!isObject(schema)) {
      errors.push(`events/${file}: skema wajib objek JSON`);
      continue;
    }
    if (schema.$schema !== DRAFT_2020_12) errors.push(`events/${file}: $schema wajib ${DRAFT_2020_12}`);
    if (typeof schema.$id !== "string" || !URL.canParse(schema.$id)) {
      errors.push(`events/${file}: $id wajib URI absolut`);
    } else if (byId.has(schema.$id)) {
      errors.push(`events/${file}: $id ${schema.$id} sudah dipakai events/${byId.get(schema.$id).file}`);
    } else byId.set(schema.$id, { file, schema });
    if (typeof schema.title !== "string" || !PASCAL.test(schema.title)) {
      errors.push(`events/${file}: title wajib PascalCase (dipakai sebagai nama tipe TS/Dart)`);
    } else if (titles.has(schema.title)) {
      errors.push(`events/${file}: title ${schema.title} sudah dipakai events/${titles.get(schema.title)}`);
    } else titles.set(schema.title, file);
    if (!Array.isArray(schema.examples) || schema.examples.length === 0)
      errors.push(`events/${file}: wajib memiliki minimal satu contoh di examples`);
    if (schema.$defs !== undefined || schema.definitions !== undefined)
      errors.push(
        `events/${file}: $defs/definitions tidak didukung generator; pindahkan ke berkas events/<nama>.schema.json sendiri`,
      );
  }

  const envelopeEntry = files.find((f) => f.file === ENVELOPE_FILE);
  const envelope = isObject(envelopeEntry?.schema) ? envelopeEntry.schema : undefined;
  let types = [];
  let version;
  let payloadLess = [];
  let pending = [];
  if (!envelope) errors.push(`events/${ENVELOPE_FILE} wajib ada (ARCHITECTURE §4.9)`);
  else {
    const required = new Set(envelope.required ?? []);
    for (const field of ENVELOPE_FIELDS) {
      if (!required.has(field)) errors.push(`events/${ENVELOPE_FILE}: '${field}' wajib ada di required`);
    }
    if (envelope.additionalProperties !== false)
      errors.push(`events/${ENVELOPE_FILE}: additionalProperties wajib false`);
    if (envelope.title !== ENVELOPE_TITLE)
      errors.push(`events/${ENVELOPE_FILE}: title wajib ${ENVELOPE_TITLE}`);
    const typeEnum = envelope.properties?.type?.enum;
    if (!Array.isArray(typeEnum) || typeEnum.length === 0 || typeEnum.some((t) => typeof t !== "string"))
      errors.push(`events/${ENVELOPE_FILE}: properties.type.enum wajib berisi jenis event (string)`);
    else types = typeEnum;
    version = envelope.properties?.v?.const;
    if (!Number.isInteger(version)) errors.push(`events/${ENVELOPE_FILE}: properties.v.const wajib integer`);

    const readList = (key) => {
      const list = envelope[key] ?? [];
      if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
        errors.push(`events/${ENVELOPE_FILE}: ${key} wajib array jenis event`);
        return [];
      }
      for (const t of list) {
        if (!types.includes(t))
          errors.push(`events/${ENVELOPE_FILE}: ${key} memuat jenis tak dikenal '${t}'`);
      }
      if (new Set(list).size !== list.length) errors.push(`events/${ENVELOPE_FILE}: ${key} berisi duplikat`);
      return list;
    };
    payloadLess = readList(PAYLOAD_LESS_KEY);
    pending = readList(PAYLOAD_PENDING_KEY);
    for (const t of payloadLess) {
      if (pending.includes(t))
        errors.push(
          `events/${ENVELOPE_FILE}: '${t}' tidak boleh sekaligus di ${PAYLOAD_LESS_KEY} dan ${PAYLOAD_PENDING_KEY}`,
        );
    }
  }

  // Payload per jenis dan skema bersama.
  const payloads = new Map();
  const shared = [];
  for (const { file, schema } of files) {
    if (file === ENVELOPE_FILE || !file.endsWith(SCHEMA_SUFFIX) || !isObject(schema)) continue;
    const base = file.slice(0, -SCHEMA_SUFFIX.length);
    if (types.includes(base)) {
      const title = payloadTitle(base);
      if (schema.title !== title) errors.push(`events/${file}: title payload jenis '${base}' wajib ${title}`);
      if (schema.type !== "object" || !isObject(schema.properties))
        errors.push(`events/${file}: payload wajib \`type: object\` dengan properties`);
      if (schema.additionalProperties !== false)
        errors.push(`events/${file}: payload wajib additionalProperties: false (payload minimum, PRD 5.2)`);
      if (payloadLess.includes(base) || pending.includes(base))
        errors.push(
          `events/${file}: jenis '${base}' sudah memiliki skema payload; hapus dari ` +
            `${payloadLess.includes(base) ? PAYLOAD_LESS_KEY : PAYLOAD_PENDING_KEY} di ${ENVELOPE_FILE}`,
        );
      payloads.set(base, { file, title: schema.title, schema });
    } else {
      if (/Payload$/.test(schema.title ?? ""))
        errors.push(
          `events/${file}: berakhiran Payload tetapi '${base}' bukan jenis event di ${ENVELOPE_FILE}`,
        );
      shared.push({ file, title: schema.title, schema });
    }
    for (const { name, at } of collectPropertyNames(schema)) {
      if (!SNAKE.test(name)) errors.push(`events/${file}${at}: nama properti wajib snake_case`);
    }
  }
  for (const t of types) {
    if (!payloads.has(t) && !payloadLess.includes(t) && !pending.includes(t)) {
      errors.push(
        `jenis event '${t}' belum memiliki payload: tambahkan events/${t}${SCHEMA_SUFFIX} (title ${payloadTitle(t)}), ` +
          `atau daftarkan di ${PAYLOAD_LESS_KEY} (payload selalu {}) / ${PAYLOAD_PENDING_KEY} di ${ENVELOPE_FILE}`,
      );
    }
  }
  if (pending.length)
    warnings.push(
      `payload event belum ditulis (${PAYLOAD_PENDING_KEY}, penulis kontrak C6): ${pending.join(", ")}; ` +
        "tipe TS/Dart-nya objek bebas sampai events/<type>.schema.json ditambahkan",
    );

  // Rujukan: hanya `#` (diri sendiri) atau `$id` berkas lain secara utuh, agar dapat dipetakan generator.
  const refTargets = new Map(); // file -> Map(ref -> title)
  const referenced = new Set();
  for (const { file, schema } of files) {
    if (!isObject(schema) || typeof schema.$id !== "string" || !URL.canParse(schema.$id)) continue;
    const map = new Map();
    for (const { ref, at } of collectRefs(schema)) {
      if (ref === "#") {
        map.set(ref, schema.title);
        continue;
      }
      if (!URL.canParse(ref, schema.$id)) {
        errors.push(`events/${file}${at}: $ref '${ref}' tidak valid`);
        continue;
      }
      const url = new URL(ref, schema.$id);
      if (url.hash) {
        errors.push(
          `events/${file}${at}: $ref '${ref}' merujuk bagian skema; generator hanya mendukung rujukan ke ` +
            "$id berkas events lain secara utuh",
        );
        continue;
      }
      const target = byId.get(url.href);
      if (!target) {
        errors.push(`events/${file}${at}: $ref '${ref}' tidak ditemukan di events/*.schema.json`);
        continue;
      }
      if (target.file === ENVELOPE_FILE) {
        errors.push(`events/${file}${at}: amplop tidak boleh dirujuk`);
        continue;
      }
      referenced.add(target.file);
      map.set(ref, target.schema.title);
    }
    refTargets.set(file, map);
  }
  for (const s of shared) {
    if (!referenced.has(s.file))
      warnings.push(`events/${s.file}: skema bersama tidak dirujuk payload mana pun`);
  }

  return {
    envelope,
    envelopeFile: ENVELOPE_FILE,
    types,
    version,
    payloads,
    shared,
    payloadLess,
    pending,
    refTargets,
    byId,
    errors,
    warnings,
  };
}

/** Salinan skema dengan setiap `$ref` dipetakan lewat `map` (ref asli -> title komponen). */
function rewriteRefs(node, map) {
  if (Array.isArray(node)) return node.map((v) => rewriteRefs(v, map));
  if (!isObject(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string" && map.has(v)) out[k] = `${COMPONENT_REF}${map.get(v)}`;
    else out[k] = rewriteRefs(v, map);
  }
  return out;
}

const META_KEYS = new Set(["$schema", "$id", "examples", "title", PAYLOAD_LESS_KEY, PAYLOAD_PENDING_KEY]);

/**
 * Skema event sebagai `components.schemas` OpenAPI (kunci = title) dengan `$ref` antarberkas dipetakan ke
 * `#/components/schemas/<Title>`; dipakai openapi-typescript (TS) dan ModelRegistry (Dart).
 * @param {ReturnType<typeof analyzeEvents>} analysis
 */
export function eventComponentSchemas(analysis) {
  const out = {};
  const entries = [
    ...(analysis.envelope ? [{ file: analysis.envelopeFile, schema: analysis.envelope }] : []),
    ...[...analysis.payloads.values()],
    ...analysis.shared,
  ];
  for (const { file, schema } of entries) {
    const stripped = Object.fromEntries(Object.entries(schema).filter(([k]) => !META_KEYS.has(k)));
    out[schema.title] = rewriteRefs(stripped, analysis.refTargets.get(file) ?? new Map());
  }
  return out;
}

/** Jenis event berurutan beserta cara payload-nya dibentuk: "schema", "none" (selalu {}), atau "pending". */
export function payloadKinds(analysis) {
  return analysis.types.map((type) => {
    if (analysis.payloads.has(type))
      return { type, kind: "schema", title: analysis.payloads.get(type).title };
    if (analysis.payloadLess.includes(type)) return { type, kind: "none" };
    return { type, kind: "pending" };
  });
}
