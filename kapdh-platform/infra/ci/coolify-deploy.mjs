#!/usr/bin/env node
// Memicu deployment Coolify lewat URL rahasia lalu menunggu hasil setiap deployment (PRD 5.5, ARCHITECTURE §10).
//
// Lingkungan (GitHub Environment secrets, tidak pernah dicetak):
//   COOLIFY_DEPLOY_URL  https://<coolify>/api/v1/deploy?uuid=<api>,<worker>,<web>,<admin>&force=false
//   COOLIFY_API_TOKEN   token API Coolify (Bearer) dengan izin deploy
// Argumen: --timeout <detik> (bawaan 900), --interval <detik> (bawaan 10), --dry-run (validasi saja, tanpa jaringan).
//
// Keluar 0 bila semua deployment `finished`, 1 bila ada yang gagal/dibatalkan/habis waktu. URL dan token tidak pernah
// ditulis ke log; UUID hanya ditampilkan 8 karakter pertama.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DONE_OK = new Set(["finished"]);
export const DONE_FAIL = new Set(["failed", "cancelled", "cancelled-by-user", "error"]);

export const short = (uuid) => String(uuid ?? "?").slice(0, 8);

/** Memvalidasi URL deploy Coolify. Galat tidak pernah memuat URL utuh. */
export function parseDeployUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("COOLIFY_DEPLOY_URL bukan URL yang valid");
  }
  if (url.protocol !== "https:") throw new Error("COOLIFY_DEPLOY_URL wajib https (N-07)");
  if (url.username || url.password)
    throw new Error("COOLIFY_DEPLOY_URL tidak boleh memuat kredensial; pakai COOLIFY_API_TOKEN");
  if (!/\/api\/v1\/deploy\/?$/.test(url.pathname))
    throw new Error("COOLIFY_DEPLOY_URL wajib berakhir di /api/v1/deploy (endpoint deploy API Coolify)");
  const list = (key) =>
    (url.searchParams.get(key) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const resources = list("uuid");
  const tags = list("tag");
  if (resources.length === 0 && tags.length === 0)
    throw new Error("COOLIFY_DEPLOY_URL wajib memuat parameter uuid=<resource,...> atau tag=<tag>");
  const apiBase = `${url.origin}${url.pathname.replace(/\/deploy\/?$/, "")}`;
  return { url, apiBase, resources, tags };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** Memicu deploy; mengembalikan daftar {resource_uuid, deployment_uuid, message}. */
export async function triggerDeploy({ url, token, fetchImpl = fetch }) {
  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(res);
  if (!res.ok)
    throw new Error(
      `Coolify menolak permintaan deploy: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
    );
  if (!Array.isArray(body?.deployments) || body.deployments.length === 0)
    throw new Error(`jawaban deploy Coolify tanpa daftar deployments: ${JSON.stringify(body).slice(0, 200)}`);
  return body.deployments;
}

/**
 * Menunggu setiap deployment selesai. Deployment tanpa deployment_uuid (mis. resource jenis service) tidak dapat
 * dipantau; dilaporkan sebagai peringatan dan kebenarannya dibuktikan uji asap sesudahnya.
 */
export async function waitForDeployments({
  apiBase,
  token,
  deployments,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  timeoutMs = 900_000,
  intervalMs = 10_000,
  log = console.log,
}) {
  const pending = new Map();
  const results = [];
  for (const d of deployments) {
    if (d?.deployment_uuid) pending.set(d.deployment_uuid, d);
    else {
      log(
        `::warning::resource ${short(d?.resource_uuid)} tidak mengembalikan deployment_uuid; tidak dapat dipantau`,
      );
      results.push({ resource: short(d?.resource_uuid), status: "unmonitored", ok: true });
    }
  }
  const deadline = now() + timeoutMs;
  const last = new Map();
  while (pending.size > 0) {
    for (const [uuid, d] of [...pending]) {
      let status = "unknown";
      try {
        const res = await fetchImpl(`${apiBase}/deployments/${encodeURIComponent(uuid)}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        const body = await readJson(res);
        status = res.ok ? String(body?.status ?? "unknown").toLowerCase() : `http_${res.status}`;
      } catch (e) {
        status = `network_error:${e instanceof Error ? e.name : "unknown"}`;
      }
      if (last.get(uuid) !== status) {
        log(`deployment ${short(uuid)} (resource ${short(d.resource_uuid)}): ${status}`);
        last.set(uuid, status);
      }
      if (DONE_OK.has(status) || DONE_FAIL.has(status)) {
        pending.delete(uuid);
        results.push({
          resource: short(d.resource_uuid),
          deployment: short(uuid),
          status,
          ok: DONE_OK.has(status),
        });
      }
    }
    if (pending.size === 0) break;
    if (now() >= deadline) {
      for (const [uuid, d] of pending)
        results.push({
          resource: short(d.resource_uuid),
          deployment: short(uuid),
          status: `timeout (${last.get(uuid)})`,
          ok: false,
        });
      break;
    }
    await sleep(intervalMs);
  }
  return { ok: results.every((r) => r.ok), results };
}

function numberArg(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} wajib angka positif`);
  return n;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const { url, apiBase, resources, tags } = parseDeployUrl(env.COOLIFY_DEPLOY_URL);
  const token = env.COOLIFY_API_TOKEN ?? "";
  if (token.trim() === "") throw new Error("COOLIFY_API_TOKEN kosong");
  const timeoutMs = numberArg(argv, "--timeout", 900) * 1000;
  const intervalMs = numberArg(argv, "--interval", 10) * 1000;
  const target = resources.length > 0 ? `${resources.length} resource` : `tag ${tags.join(",")}`;
  log(`Deploy Coolify di ${url.host}: ${target}.`);
  if (argv.includes("--dry-run")) {
    log("--dry-run: URL dan token valid; tidak ada permintaan yang dikirim.");
    return 0;
  }
  const deployments = await triggerDeploy({ url, token, fetchImpl });
  log(`${deployments.length} deployment diantrekan; menunggu selesai (batas ${timeoutMs / 1000} detik).`);
  const { ok, results } = await waitForDeployments({
    apiBase,
    token,
    deployments,
    fetchImpl,
    timeoutMs,
    intervalMs,
    log,
  });
  for (const r of results) log(`${r.ok ? "OK   " : "GAGAL"} resource ${r.resource}: ${r.status}`);
  if (!ok)
    log("::error title=Deploy Coolify gagal::Periksa log deployment di panel Coolify (runbook ci-cd.md).");
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`::error title=coolify-deploy::${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
