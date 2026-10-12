#!/usr/bin/env node
// Validasi skema event realtime packages/contracts/events/*.schema.json (PRD 5.2, ARCHITECTURE §4.9):
// - aturan katalog scripts/lib/events.mjs: amplop lengkap, $schema 2020-12, $id/title unik, payload per jenis
//   (`<type>.schema.json`, title `<Type>Payload`, additionalProperties false, properti snake_case), setiap jenis
//   event punya payload atau terdaftar eksplisit di x-kapdh-payload-less / x-kapdh-payload-pending, dan $ref hanya
//   ke $id berkas events lain;
// - dikompilasi Ajv mode strict (kata kunci tak dikenal atau salah ketik gagal);
// - setiap contoh di `examples` wajib lolos skemanya, dan payload contoh amplop wajib lolos skema payload jenisnya
//   (jenis tanpa payload wajib `{}`);
// - title skema event tidak boleh bentrok dengan components.schemas kontrak HTTP (berbagi models.dart SDK Dart).
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { analyzeEvents, createEventsAjv, ENVELOPE_FILE, readEventFiles } from "./lib/events.mjs";
import { PATHS } from "./lib/fs.mjs";

const { files, errors } = readEventFiles(PATHS.eventsDir);
const analysis = analyzeEvents(files);
errors.push(...analysis.errors);

const ajv = createEventsAjv();
// Daftarkan semua skema dulu agar $ref antarberkas (berdasarkan $id) dapat diselesaikan.
for (const { file, schema } of files) {
  if (typeof schema?.$id !== "string") continue;
  try {
    ajv.addSchema(schema);
  } catch (error) {
    errors.push(`events/${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const validators = new Map();
let examples = 0;
for (const { file, schema } of files) {
  if (typeof schema?.$id !== "string") continue;
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
  validators.set(file, validate);
  (schema.examples ?? []).forEach((example, i) => {
    examples += 1;
    if (!validate(example))
      errors.push(`events/${file}: examples[${i}] tidak valid: ${ajv.errorsText(validate.errors)}`);
  });
}

// Payload contoh amplop terhadap skema payload jenisnya.
for (const [i, example] of (analysis.envelope?.examples ?? []).entries()) {
  const type = example?.type;
  const payload = analysis.payloads.get(type);
  if (payload) {
    const validate = validators.get(payload.file);
    if (validate && !validate(example.payload))
      errors.push(
        `events/${ENVELOPE_FILE}: examples[${i}].payload tidak sesuai ${payload.file}: ${ajv.errorsText(validate.errors)}`,
      );
  } else if (analysis.payloadLess.includes(type)) {
    const p = example.payload;
    if (p === null || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length > 0)
      errors.push(`events/${ENVELOPE_FILE}: examples[${i}] jenis '${type}' tanpa payload wajib payload {}`);
  }
}

// Bentrok nama dengan kontrak HTTP (bundle dibangun lebih dulu oleh skrip lint).
if (existsSync(PATHS.bundle)) {
  const schemas = parse(readFileSync(PATHS.bundle, "utf8")).components?.schemas ?? {};
  for (const { file, schema } of files) {
    if (typeof schema?.title === "string" && Object.hasOwn(schemas, schema.title))
      errors.push(
        `events/${file}: title ${schema.title} bentrok dengan components.schemas kontrak HTTP; beri nama lain`,
      );
  }
}

for (const w of analysis.warnings) console.warn(`peringatan: ${w}`);
if (errors.length) {
  console.error(`Skema event realtime tidak valid (${errors.length} galat):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `events: ${files.length} skema valid, ${examples} contoh lolos; ${analysis.types.length} jenis event ` +
    `(${analysis.payloads.size} payload bertipe, ${analysis.payloadLess.length} tanpa payload, ` +
    `${analysis.pending.length} pending).`,
);
