// Masukan fixture generator SDK Dart (scripts/test/fixtures/sdk): kontrak nyata (dist/openapi.yaml dan
// events/*.schema.json) ditambah operasi, skema dan payload event fixture yang menguji konstruksi yang belum dipakai
// kontrak produk (respons 200 | 204, enum inline nullable, multipart daftar berkas, payload event bertipe dengan $ref
// antarberkas). Dipakai scripts/check-dart.mjs (dart analyze + dart test) dan uji generator Node.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  analyzeEvents,
  ENVELOPE_FILE,
  PAYLOAD_LESS_KEY,
  PAYLOAD_PENDING_KEY,
  readEventFiles,
} from "../events.mjs";
import { PACKAGE_ROOT, PATHS } from "../fs.mjs";

export const FIXTURE_DIR = join(PACKAGE_ROOT, "scripts", "test", "fixtures", "sdk");
/** Jenis event fixture yang payload-nya selalu {} (menguji x-kapdh-payload-less). */
const FIXTURE_PAYLOAD_LESS = ["session.revoked"];

/** Menggabungkan fixture OpenAPI ke bundle; gagal bila ada nama ganda. */
export function mergeFixtureBundle(bundle, fixture) {
  const merged = structuredClone(bundle);
  merged.tags = [...(merged.tags ?? []), ...(fixture.tags ?? [])];
  merged.paths = { ...(merged.paths ?? {}) };
  for (const [path, item] of Object.entries(fixture.paths ?? {})) {
    if (merged.paths[path]) throw new Error(`fixture: path ${path} sudah ada di kontrak`);
    merged.paths[path] = item;
  }
  merged.components = { ...(merged.components ?? {}) };
  merged.components.schemas = { ...(merged.components.schemas ?? {}) };
  for (const [name, schema] of Object.entries(fixture.components?.schemas ?? {})) {
    if (merged.components.schemas[name]) throw new Error(`fixture: skema ${name} sudah ada di kontrak`);
    merged.components.schemas[name] = schema;
  }
  return merged;
}

/**
 * Katalog event fixture: berkas events nyata + payload fixture; amplop disalin dengan jenis yang punya payload
 * fixture dikeluarkan dari x-kapdh-payload-pending dan `session.revoked` dijadikan tanpa payload.
 */
export function fixtureEvents(eventsDir = PATHS.eventsDir) {
  const real = readEventFiles(eventsDir);
  const extra = readEventFiles(join(FIXTURE_DIR, "events"));
  const errors = [...real.errors, ...extra.errors];
  const extraNames = new Set(extra.files.map((f) => f.file));
  const files = real.files
    .filter((f) => !extraNames.has(f.file))
    .map((f) => (f.file === ENVELOPE_FILE ? { ...f, schema: structuredClone(f.schema) } : f));
  files.push(...extra.files);
  const envelope = files.find((f) => f.file === ENVELOPE_FILE)?.schema;
  if (envelope) {
    const withSchema = new Set(extra.files.map((f) => f.file.replace(/\.schema\.json$/, "")));
    envelope[PAYLOAD_PENDING_KEY] = (envelope[PAYLOAD_PENDING_KEY] ?? []).filter(
      (t) => !withSchema.has(t) && !FIXTURE_PAYLOAD_LESS.includes(t),
    );
    envelope[PAYLOAD_LESS_KEY] = [
      ...new Set([...(envelope[PAYLOAD_LESS_KEY] ?? []), ...FIXTURE_PAYLOAD_LESS]),
    ].filter((t) => !withSchema.has(t));
  }
  const analysis = analyzeEvents(files);
  analysis.errors.unshift(...errors);
  return analysis;
}

/** Bundle dan katalog event fixture. */
export function fixtureInputs(bundle) {
  const fixture = parse(readFileSync(join(FIXTURE_DIR, "openapi.fixture.yaml"), "utf8"));
  return { bundle: mergeFixtureBundle(bundle, fixture), events: fixtureEvents() };
}
