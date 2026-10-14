#!/usr/bin/env node
// Validasi statis artefak deployment KAPDH tanpa Docker (PRD 5.3, 5.5, 7.1; N-07; D7, D12). Dijalankan CI dan lokal
// dari kapdh-platform/ setelah `pnpm install` dan `pnpm --filter @kapdh/config build`:
//
//   node infra/scripts/validate-infra.mjs
//
// Memeriksa: YAML compose/CI/Traefik valid; image dipin digest; DB/Redis tanpa port host dan hanya di jaringan
// internal; healthcheck, batas sumber daya dan hardening; worker tanpa secret API (least privilege); setiap variabel
// packages/config tercantum di contoh env dan diteruskan compose; contoh env ditolak validasi apa adanya (placeholder)
// tetapi lolos setelah secret diisi; Dockerfile non-root dengan HEALTHCHECK. Keluar 1 bila ada pelanggaran.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const infra = join(root, "infra");
// Paket `yaml` dipasang sebagai devDependency apps/api (tidak di-hoist ke root oleh pnpm).
const requireFromApi = createRequire(join(root, "apps", "api", "package.json"));
const YAML = requireFromApi("yaml");
const config = await import(pathToFileURL(join(root, "packages", "config", "dist", "index.js")).href);

const problems = [];
const ok = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);
const read = (path) => readFileSync(join(root, path), "utf8");

function parseYaml(path, text = read(path)) {
  const doc = YAML.parseDocument(text, { merge: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) fail(path, `YAML tidak valid: ${e.message}`);
    return null;
  }
  return doc.toJS({ maxAliasCount: 100 });
}

// ------------------------------------------------------------------------------- variabel packages/config
/** Kunci skema env dari sumber packages/config (baseShape, apiShape, workerShape). */
function configKeys() {
  const source = read("packages/config/src/index.ts");
  const section = (name) => {
    const start = source.indexOf(`const ${name} = {`);
    const end = source.indexOf("\n};", start);
    if (start < 0 || end < 0) throw new Error(`${name} tidak ditemukan di packages/config`);
    return [...source.slice(start, end).matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  };
  return { base: section("baseShape"), api: section("apiShape"), worker: section("workerShape") };
}
const keys = configKeys();
const apiKeys = new Set([...keys.base, ...keys.api]);
const workerKeys = new Set([...keys.base, ...keys.worker]);
const API_ONLY_SECRETS = [
  "JWT_ACCESS_SECRET",
  "OTP_HMAC_SECRET",
  "TOTP_ENC_KEY",
  "QR_SIGNING_KEYS",
  "BCRYPT_COST",
];

// ------------------------------------------------------------------------------------------ contoh env
function parseEnvFile(path) {
  const values = new Map();
  for (const line of read(path).split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    values.set(m[1], value);
  }
  return values;
}

for (const [path, nodeEnv] of [
  ["infra/.env.production.example", "production"],
  ["infra/.env.staging.example", "staging"],
]) {
  const env = parseEnvFile(path);
  const text = read(path);
  for (const key of new Set([...apiKeys, ...workerKeys])) {
    // DATABASE_URL/REDIS_URL berbeda per layanan: didokumentasikan di bagian B sebagai komentar.
    if (key === "DATABASE_URL" || key === "REDIS_URL") {
      if (!text.includes(`${key}=postgres://`) && !text.includes(`${key}=redis://`))
        fail(path, `${key} tidak didokumentasikan`);
      continue;
    }
    if (!env.has(key)) fail(path, `variabel packages/config ${key} tidak tercantum`);
  }
  if (env.get("NODE_ENV") !== nodeEnv) fail(path, `NODE_ENV harus ${nodeEnv}`);
  for (const [key, value] of env)
    if (/^(?!ganti-dengan)[A-Za-z0-9+/_-]{40,}$/.test(value) && !key.endsWith("_URL"))
      fail(path, `${key} tampak seperti secret nyata; contoh env tidak boleh memuat secret`);

  const withUrls = (source) => ({
    ...Object.fromEntries(source),
    DATABASE_URL: "postgres://kapdh_app:x@postgres:5432/kapdh",
    REDIS_URL: "redis://:x@redis:6379/0",
  });
  // Apa adanya: placeholder harus ditolak validasi (aplikasi gagal start, bukan berjalan dengan secret contoh).
  try {
    config.loadApiEnv(withUrls(env));
    fail(path, "contoh env apa adanya LOLOS validasi API; placeholder harus ditolak");
  } catch (e) {
    if (!(e instanceof config.EnvValidationError)) throw e;
  }
  // Placeholder diganti nilai acak: contoh env lengkap dan konsisten dengan aturan production/staging.
  const filled = new Map(env);
  const hex = "a1b2c3d4".repeat(8);
  for (const [key, value] of filled) if (value.includes("ganti-dengan")) filled.set(key, hex);
  filled.set("TOTP_ENC_KEY", hex);
  filled.set("QR_SIGNING_KEYS", `${nodeEnv === "production" ? "prod" : "stg"}-1:${hex}`);
  filled.set("SMTP_URL", "smtps://user:pass@smtp.provider.example:465");
  if (nodeEnv === "production")
    filled.set("FCM_SERVICE_ACCOUNT_JSON", JSON.stringify({ client_email: "fcm@x.iam", private_key: "k" }));
  try {
    config.loadApiEnv(withUrls(filled));
    config.loadWorkerEnv(withUrls(filled));
    ok.push(`${path}: lengkap dan valid untuk NODE_ENV=${nodeEnv} setelah secret diisi`);
  } catch (e) {
    fail(path, `setelah secret diisi tetap ditolak: ${e.message}`);
  }
}

// -------------------------------------------------------------------------------------------- compose
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const OWN_IMAGE = /^\$\{KAPDH_REGISTRY:\?[^}]*\}\/kapdh-(api|worker|web|admin|release):/;

function checkImages(path, services) {
  for (const [name, svc] of Object.entries(services)) {
    if (!svc.image) continue;
    if (!DIGEST.test(svc.image) && !OWN_IMAGE.test(svc.image))
      fail(path, `${name}: image tidak dipin digest (${svc.image})`);
  }
}

const prod = parseYaml("infra/compose.production.yml");
const staging = parseYaml("infra/compose.staging.yml");
const proxy = parseYaml("infra/compose.proxy.yml");
const dev = parseYaml("infra/docker-compose.yml");
if (prod) {
  const s = prod.services;
  const path = "infra/compose.production.yml";
  if (prod.name !== "kapdh-production") fail(path, "nama project harus kapdh-production");
  checkImages(path, s);
  for (const name of ["postgres", "redis", "api", "worker", "web", "admin", "release"])
    if (!s[name]) fail(path, `layanan ${name} tidak ada`);
  for (const name of ["postgres", "redis"]) {
    if (s[name].ports) fail(path, `${name} tidak boleh mempublikasikan port (N-07)`);
    if (JSON.stringify(s[name].networks) !== JSON.stringify(["data"]))
      fail(path, `${name} hanya boleh di jaringan data`);
  }
  if (prod.networks?.data?.internal !== true)
    fail(path, "jaringan data harus internal: true (DB/Redis privat)");
  for (const [name, svc] of Object.entries(s)) {
    if (name !== "release" && svc.restart !== "unless-stopped")
      fail(path, `${name}: restart harus unless-stopped`);
    if (!svc.deploy?.resources?.limits?.memory || !svc.deploy?.resources?.limits?.cpus)
      fail(path, `${name}: batas cpus/memory wajib (VPS 4 vCPU/8 GB, D7)`);
    if (!svc.logging) fail(path, `${name}: rotasi log wajib`);
    if (!(svc.security_opt ?? []).includes("no-new-privileges:true"))
      fail(path, `${name}: no-new-privileges wajib`);
    if (["api", "worker", "web", "admin", "release"].includes(name) && !(svc.cap_drop ?? []).includes("ALL"))
      fail(path, `${name}: cap_drop ALL wajib`);
    if (svc.ports) fail(path, `${name}: tidak boleh mempublikasikan port; lalu lintas masuk lewat Traefik`);
  }
  for (const name of ["postgres", "redis"])
    if (!s[name].healthcheck) fail(path, `${name}: healthcheck wajib`);
  if (JSON.stringify(s.release.profiles) !== JSON.stringify(["release"]))
    fail(path, "release harus profile release");
  const apiEnv = Object.keys(s.api.environment);
  const workerEnv = Object.keys(s.worker.environment);
  for (const key of apiKeys) if (!apiEnv.includes(key)) fail(path, `api tidak menerima ${key}`);
  for (const key of workerKeys) if (!workerEnv.includes(key)) fail(path, `worker tidak menerima ${key}`);
  for (const key of API_ONLY_SECRETS)
    if (workerEnv.includes(key)) fail(path, `worker menerima ${key} (least privilege PRD 5.1)`);
  for (const key of apiEnv)
    if (!apiKeys.has(key) && key !== "NODE_OPTIONS") fail(path, `api menerima variabel tak dikenal ${key}`);
  for (const key of workerEnv)
    if (!workerKeys.has(key) && key !== "NODE_OPTIONS")
      fail(path, `worker menerima variabel tak dikenal ${key}`);
  if (!String(s.api.environment.DATABASE_URL).startsWith("postgres://kapdh_app:"))
    fail(path, "api harus login kapdh_app");
  if (!String(s.worker.environment.DATABASE_URL).startsWith("postgres://kapdh_worker:"))
    fail(path, "worker harus login kapdh_worker");
  if (!String(s.release.environment.MIGRATOR_DATABASE_URL).startsWith("postgres://kapdh_migrator:"))
    fail(path, "release harus memigrasi sebagai kapdh_migrator");
  if (s.api.environment.NODE_ENV !== "production") fail(path, "NODE_ENV api harus dipatok production");
  if (parseInt(String(s.worker.stop_grace_period), 10) < 35)
    fail(path, "worker stop_grace_period >= timeout + 10 s");
  // D12: jaringan edge dipatok per lingkungan (tanpa interpolasi env) agar staging tidak menjangkau API production.
  if (prod.networks?.edge?.name !== "kapdh-edge" || prod.networks?.edge?.external !== true)
    fail(path, "jaringan edge production harus external dengan nama tetap kapdh-edge");
  for (const key of ["RELEASE_GATE", "RELEASE_GATE_REASON", "RELEASE_GATE_APPROVER"])
    if (!(key in (s.release.environment ?? {}))) fail(path, `release tidak meneruskan ${key}`);
  if (problems.length === 0) ok.push(`${path}: struktur, isolasi jaringan, batas sumber daya dan env lulus`);
}
if (staging) {
  const path = "infra/compose.staging.yml";
  if (staging.name !== "kapdh-staging") fail(path, "nama project harus kapdh-staging");
  for (const vol of ["pgdata", "redisdata", "files"])
    if (!/^kapdh-staging-/.test(staging.volumes?.[vol]?.name ?? ""))
      fail(path, `volume ${vol} harus dipatok kapdh-staging-*`);
  for (const name of ["api", "worker"])
    if (staging.services[name]?.environment?.NODE_ENV !== "staging")
      fail(path, `${name}: NODE_ENV staging wajib`);
  if (staging.services.release?.environment?.KAPDH_ENV !== "staging")
    fail(path, "release KAPDH_ENV staging wajib");
  if (staging.networks?.edge?.name !== "kapdh-edge-staging" || staging.networks?.edge?.external !== true)
    fail(path, "jaringan edge staging harus dipatok kapdh-edge-staging (terpisah dari production, D12)");
}
if (proxy) {
  const path = "infra/compose.proxy.yml";
  checkImages(path, proxy.services);
  const t = proxy.services.traefik;
  if ((t.volumes ?? []).some((v) => String(v).includes("docker.sock")))
    fail(path, "Traefik tidak boleh memasang socket Docker");
  if (!t.read_only) fail(path, "Traefik read_only wajib");
  const cmd = t.entrypoint.join(" ");
  for (const flag of ["--api.dashboard=false", "redirections.entrypoint.scheme=https", "tlschallenge=true"])
    if (!cmd.includes(flag)) fail(path, `Traefik tanpa ${flag}`);
  const joined = (t.networks ?? []).map((n) => proxy.networks?.[n]?.name).sort();
  if (JSON.stringify(joined) !== JSON.stringify(["kapdh-edge", "kapdh-edge-staging"]))
    fail(
      path,
      `Traefik harus tersambung ke kapdh-edge dan kapdh-edge-staging (ditemukan ${joined.join(", ")})`,
    );
}
if (dev) {
  const path = "infra/docker-compose.yml";
  checkImages(path, dev.services);
  for (const [name, svc] of Object.entries(dev.services))
    for (const port of svc.ports ?? [])
      if (!String(port).startsWith("127.0.0.1:")) fail(path, `${name}: port dev harus terikat 127.0.0.1`);
}
for (const path of ["infra/ci/github-actions-ci.yml", "infra/ci/github-actions-images.yml"]) parseYaml(path);

// ------------------------------------------------------------------------------------- Traefik dinamis
try {
  const rendered = execFileSync("sh", [join(infra, "traefik", "render-dynamic.sh")], {
    env: {
      PATH: process.env.PATH,
      KAPDH_PRODUCTION_DOMAIN_WEB: "kapdh.or.id",
      KAPDH_PRODUCTION_DOMAIN_ADMIN: "admin.kapdh.or.id",
      KAPDH_PRODUCTION_DOMAIN_API: "api.kapdh.or.id",
      KAPDH_STAGING_DOMAIN_WEB: "staging.kapdh.or.id",
      KAPDH_STAGING_DOMAIN_ADMIN: "staging-admin.kapdh.or.id",
      KAPDH_STAGING_DOMAIN_API: "staging-api.kapdh.or.id",
      KAPDH_HSTS: "true",
    },
    encoding: "utf8",
  });
  const dyn = parseYaml("infra/traefik/render-dynamic.sh (keluaran)", rendered);
  if (dyn) {
    const routers = dyn.http.routers;
    const services = dyn.http.services;
    for (const env of ["production", "staging"])
      for (const svc of ["web", "admin", "api"]) {
        const name = `${env}-${svc}`;
        if (!routers[name]?.tls?.certResolver) fail("traefik", `${name} tanpa TLS`);
        const url = services[name]?.loadBalancer?.servers?.[0]?.url ?? "";
        if (!url.startsWith(`http://kapdh-${env}-${svc}-1:`)) fail("traefik", `${name} menunjuk ${url}`);
      }
    if (dyn.tls?.options?.default?.minVersion !== "VersionTLS12") fail("traefik", "TLS minimal 1.2 (N-07)");
    if (
      dyn.http.middlewares["kapdh-www-to-apex"].redirectRegex.regex !== "^https?://www\\.kapdh\\.or\\.id(.*)"
    )
      fail("traefik", "regex pengalihan www salah");
    ok.push(
      "infra/traefik/render-dynamic.sh: YAML valid, rute production+staging ber-TLS ke kontainer yang benar",
    );
  }
  let rejected = false;
  try {
    execFileSync("sh", [join(infra, "traefik", "render-dynamic.sh")], {
      env: {
        PATH: process.env.PATH,
        KAPDH_PRODUCTION_DOMAIN_WEB: "kapdh.or.id`) || Host(`evil",
        KAPDH_PRODUCTION_DOMAIN_ADMIN: "a.b",
        KAPDH_PRODUCTION_DOMAIN_API: "c.d",
      },
      stdio: "ignore",
    });
  } catch {
    rejected = true;
  }
  if (!rejected) fail("traefik", "domain berbahaya tidak ditolak render-dynamic.sh");
} catch (e) {
  fail("traefik", `render-dynamic.sh gagal: ${e.message}`);
}

// ------------------------------------------------------------------------------------------ Dockerfile
for (const [file, expectHealth] of [
  ["infra/Dockerfile.api", true],
  ["infra/Dockerfile.worker", true],
  ["infra/Dockerfile.web", true],
  ["infra/Dockerfile.admin", true],
]) {
  const text = read(file);
  for (const m of text.matchAll(/^ARG [A-Z_]*IMAGE=(\S+)$/gm))
    if (!DIGEST.test(m[1])) fail(file, `base image tidak dipin digest: ${m[1]}`);
  for (const m of text.matchAll(/^FROM (\S+)/gm))
    if (!m[1].startsWith("${") && !/^[a-z]+$/.test(m[1]) && !DIGEST.test(m[1]))
      fail(file, `FROM tanpa digest: ${m[1]}`);
  if (!/^# syntax=docker\/dockerfile:[0-9.]+@sha256:[0-9a-f]{64}$/m.test(text))
    fail(file, "frontend Dockerfile tidak dipin");
  const finalStage = text.slice(text.lastIndexOf("\nFROM "));
  // Pengguna efektif tahap akhir = USER terakhir di berkas (tahap akhir mewarisi tahap runtime) dan tanpa USER root.
  const lastUser = [...text.matchAll(/^USER (\S+)$/gm)].map((m) => m[1]).at(-1);
  if (!["node", "101"].includes(lastUser ?? "") || /^USER root$/m.test(finalStage))
    fail(file, "tahap akhir harus berjalan non-root");
  if (expectHealth && !/^HEALTHCHECK /m.test(finalStage)) fail(file, "tahap akhir tanpa HEALTHCHECK");
  if (/^(ENV|ARG) .*(SECRET|PASSWORD|TOKEN)/m.test(text)) fail(file, "secret tidak boleh di layer image");
}
if (!read("infra/Dockerfile.api").includes("deploy --prod --legacy"))
  fail("infra/Dockerfile.api", "pnpm deploy tanpa --legacy");

// ---------------------------------------------------------------------------------------------- hasil
for (const line of ok) console.log(`lulus  ${line}`);
if (problems.length > 0) {
  console.error(`\nValidasi infra GAGAL (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nValidasi infra lulus.");
