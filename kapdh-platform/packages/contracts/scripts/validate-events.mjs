#!/usr/bin/env node
// Validasi skema event realtime packages/contracts/events/*.schema.json (PRD 5.2, ARCHITECTURE §4.9):
// - wajib JSON Schema 2020-12 dengan $id unik dan title PascalCase;
// - dikompilasi Ajv mode strict (kata kunci tak dikenal atau salah ketik gagal);
// - setiap contoh di `examples` wajib lolos skemanya;
// - amplop wajib memuat v, event_id, type, entity_id, ts, payload dengan additionalProperties false.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { PATHS } from "./lib/fs.mjs";

const addFormats = addFormatsModule.default ?? addFormatsModule;
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const ENVELOPE_FIELDS = ["v", "event_id", "type", "entity_id", "ts", "payload"];

const errors = [];
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const files = readdirSync(PATHS.eventsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const schemas = [];
for (const file of files) {
  if (!file.endsWith(".schema.json")) {
    errors.push(`events/${file}: nama berkas skema wajib berakhiran .schema.json`);
    continue;
  }
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(PATHS.eventsDir, file), "utf8"));
  } catch (error) {
    errors.push(
      `events/${file}: JSON tidak valid (${error instanceof Error ? error.message : String(error)})`,
    );
    continue;
  }
  if (schema.$schema !== DRAFT) errors.push(`events/${file}: $schema wajib ${DRAFT}`);
  if (typeof schema.$id !== "string") errors.push(`events/${file}: $id wajib ada`);
  if (typeof schema.title !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(schema.title))
    errors.push(`events/${file}: title wajib PascalCase (dipakai sebagai nama tipe TS/Dart)`);
  if (!Array.isArray(schema.examples) || schema.examples.length === 0)
    errors.push(`events/${file}: wajib memiliki minimal satu contoh di examples`);
  schemas.push({ file, schema });
}

// Daftarkan semua skema dulu agar $ref antarberkas (berdasarkan $id) dapat diselesaikan.
for (const { file, schema } of schemas) {
  try {
    ajv.addSchema(schema);
  } catch (error) {
    errors.push(`events/${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
let examples = 0;
for (const { file, schema } of schemas) {
  let validate;
  try {
    validate = ajv.getSchema(schema.$id);
  } catch (error) {
    errors.push(
      `events/${file}: gagal dikompilasi: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }
  if (!validate) continue;
  (schema.examples ?? []).forEach((example, i) => {
    examples += 1;
    if (!validate(example))
      errors.push(`events/${file}: examples[${i}] tidak valid: ${ajv.errorsText(validate.errors)}`);
  });
}

const envelope = schemas.find((s) => s.file === "envelope.schema.json")?.schema;
if (!envelope) errors.push("events/envelope.schema.json wajib ada (ARCHITECTURE §4.9)");
else {
  const required = new Set(envelope.required ?? []);
  for (const field of ENVELOPE_FIELDS) {
    if (!required.has(field)) errors.push(`events/envelope.schema.json: '${field}' wajib ada di required`);
  }
  if (envelope.additionalProperties !== false)
    errors.push("events/envelope.schema.json: additionalProperties wajib false");
  if (!Array.isArray(envelope.properties?.type?.enum) || envelope.properties.type.enum.length === 0)
    errors.push("events/envelope.schema.json: properties.type.enum wajib berisi jenis event");
}

if (errors.length) {
  console.error(`Skema event realtime tidak valid (${errors.length} galat):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`events: ${schemas.length} skema valid, ${examples} contoh lolos.`);
