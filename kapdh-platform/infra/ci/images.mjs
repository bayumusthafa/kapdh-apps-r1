#!/usr/bin/env node
// Katalog image CI/CD (PRD 5.3 build di CI, 5.5 promosi image yang sama, 7.1 image dari CI).
// Membaca infra/ci/images.json dan menghasilkan:
//   matrix --mode ci|publish          JSON {"include":[...]} untuk strategy.matrix GitHub Actions
//   refs --env <env> --sha <sha> --registry <ghcr.io/owner> [--format tsv]
//                                     JSON [{name, repository, source}] (atau baris TSV) sumber promosi/retag per image
//   validate                          memeriksa katalog (Dockerfile ada, lingkungan lengkap, URL https)
//   count                             jumlah image (workflow memastikan setiap loop memproses semua image)
//   api-base-url --env <env>          URL API yang dibakar ke web/admin lingkungan itu
// Tanpa dependensi; diuji oleh infra/ci/test/images.test.mjs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Akar kapdh-platform (konteks build Docker). */
export const PLATFORM_ROOT = resolve(HERE, "../..");
export const CATALOG_PATH = join(HERE, "images.json");
export const ENVIRONMENTS = ["staging", "production"];

const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const REGISTRY_RE = /^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/;

export function loadCatalog(path = CATALOG_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Tag image hasil build sebuah commit: `sha-<40 hex>` plus akhiran varian lingkungan bila ada. */
export function shaTag(sha, suffix = "") {
  if (!SHA_RE.test(sha)) throw new Error(`SHA commit harus 40 heksadesimal huruf kecil: ${sha}`);
  return `sha-${sha}${suffix}`;
}

/** Namespace registry dinormalisasi: huruf kecil (GHCR menolak huruf besar), tanpa garis miring akhir. */
export function normalizeRegistry(registry) {
  const value = String(registry ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
  if (!REGISTRY_RE.test(value))
    throw new Error(`registry tidak valid (contoh: ghcr.io/pemilik): ${registry}`);
  return value;
}

function buildArgsFor(catalog, image, env) {
  return Object.entries(image.build_args ?? {}).map(([arg, key]) => {
    const value = catalog.environments?.[env]?.[key];
    if (typeof value !== "string" || value === "")
      throw new Error(`build arg ${arg} image ${image.name}: environments.${env}.${key} kosong`);
    return `${arg}=${value}`;
  });
}

function entry(catalog, image, env) {
  const suffix = image.per_environment ? `-${env}` : "";
  return {
    id: image.per_environment ? `${image.name}-${env}` : image.name,
    name: image.name,
    image: `${catalog.name_prefix}${image.name}`,
    dockerfile: image.dockerfile,
    environment: image.per_environment ? env : "any",
    tag_suffix: suffix,
    build_args: buildArgsFor(catalog, image, env).join("\n"),
    smoke: image.smoke,
  };
}

/**
 * Matriks build.
 * - ci: satu build per image tanpa push; image per lingkungan memakai varian production (yang kelak dipromosikan).
 * - publish: api/worker sekali, web/admin untuk setiap lingkungan (staging dan production) dari commit yang sama.
 */
export function buildMatrix(catalog, mode) {
  if (mode !== "ci" && mode !== "publish") throw new Error(`mode matrix tidak dikenal: ${mode}`);
  const include = [];
  for (const image of catalog.images) {
    if (!image.per_environment) include.push(entry(catalog, image, "production"));
    else if (mode === "ci") include.push(entry(catalog, image, "production"));
    else for (const env of ENVIRONMENTS) include.push(entry(catalog, image, env));
  }
  return { include };
}

/** Referensi sumber per image untuk lingkungan tertentu (dipakai retag kanal dan promosi rilis). */
export function sourceRefs(catalog, { env, sha, registry }) {
  if (!ENVIRONMENTS.includes(env)) throw new Error(`lingkungan tidak dikenal: ${env}`);
  const reg = normalizeRegistry(registry);
  return catalog.images.map((image) => {
    const repository = `${reg}/${catalog.name_prefix}${image.name}`;
    return {
      name: image.name,
      repository,
      source: `${repository}:${shaTag(sha, image.per_environment ? `-${env}` : "")}`,
    };
  });
}

/** Memeriksa katalog; mengembalikan daftar galat (kosong = valid). */
export function validateCatalog(catalog, { exists = (p) => existsSync(join(PLATFORM_ROOT, p)) } = {}) {
  const errors = [];
  if (typeof catalog.name_prefix !== "string" || !/^[a-z][a-z0-9-]*-$/.test(catalog.name_prefix))
    errors.push("name_prefix wajib huruf kecil dan diakhiri '-'");
  const seen = new Set();
  for (const env of ENVIRONMENTS) {
    const url = catalog.environments?.[env]?.api_base_url;
    if (typeof url !== "string" || !/^https:\/\/[^/]+\/api\/v1$/.test(url))
      errors.push(`environments.${env}.api_base_url wajib https://<host>/api/v1 (N-07)`);
  }
  for (const image of catalog.images ?? []) {
    if (!NAME_RE.test(image.name ?? "")) errors.push(`nama image tidak valid: ${image.name}`);
    if (seen.has(image.name)) errors.push(`nama image ganda: ${image.name}`);
    seen.add(image.name);
    if (typeof image.dockerfile !== "string" || !exists(image.dockerfile))
      errors.push(`image ${image.name}: Dockerfile ${image.dockerfile} tidak ditemukan`);
    if (typeof image.smoke !== "string" || image.smoke.trim() === "")
      errors.push(`image ${image.name}: smoke wajib diisi (perintah sh di dalam image)`);
    if (!image.per_environment && Object.keys(image.build_args ?? {}).length > 0)
      errors.push(`image ${image.name}: build_args lingkungan hanya untuk image per_environment`);
    for (const env of ENVIRONMENTS) {
      try {
        buildArgsFor(catalog, image, env);
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  if (seen.size === 0) errors.push("katalog tanpa image");
  return errors;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), out = console.log) {
  const [command] = argv;
  const catalog = loadCatalog();
  if (command === "matrix") {
    out(JSON.stringify(buildMatrix(catalog, arg(argv, "--mode") ?? "ci")));
    return 0;
  }
  if (command === "refs") {
    const refs = sourceRefs(catalog, {
      env: arg(argv, "--env"),
      sha: arg(argv, "--sha"),
      registry: arg(argv, "--registry"),
    });
    // tsv: satu baris `nama<TAB>repositori<TAB>sumber` per image, untuk loop `read` di bash.
    if (arg(argv, "--format") === "tsv") for (const r of refs) out(`${r.name}\t${r.repository}\t${r.source}`);
    else out(JSON.stringify(refs));
    return 0;
  }
  if (command === "count") {
    out(String(catalog.images.length));
    return 0;
  }
  if (command === "api-base-url") {
    // URL API yang dibakar ke image web/admin lingkungan itu; _deploy.yml membandingkannya dengan vars.API_BASE_URL.
    const env = arg(argv, "--env");
    if (!ENVIRONMENTS.includes(env)) throw new Error(`lingkungan tidak dikenal: ${env}`);
    out(catalog.environments[env].api_base_url);
    return 0;
  }
  if (command === "validate") {
    const errors = validateCatalog(catalog);
    for (const e of errors) console.error(`::error title=infra/ci/images.json::${e}`);
    if (errors.length === 0) out(`Katalog image valid: ${catalog.images.map((i) => i.name).join(", ")}.`);
    return errors.length === 0 ? 0 : 1;
  }
  console.error(
    "Pemakaian: images.mjs matrix --mode ci|publish | refs --env E --sha S --registry R [--format tsv] | count | api-base-url --env E | validate",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`images.mjs: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
