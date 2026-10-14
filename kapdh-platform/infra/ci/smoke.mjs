#!/usr/bin/env node
// Uji asap HTTP sesudah deploy (PRD 5.5 monitoring HTTP; 8.3 smoke test). Mengulang sampai lulus atau habis waktu,
// karena kontainer baru butuh waktu untuk siap di belakang Traefik.
//
//   node infra/ci/smoke.mjs [--timeout 300] [--interval 10] api=<url /health/ready> web=<url> admin=<url>
//
// Aturan per nama:
//   api    HTTP 200 dan JSON {status: "ok"} (HealthReadiness: database, redis, storage)
//   web    HTTP 200, header Content-Security-Policy dan X-Content-Type-Options: nosniff (N-07, nginx-web.conf)
//   admin  sama dengan web (nginx-admin.conf)
//   lain   HTTP 200
// Hanya URL https yang diterima (N-07).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseTargets(args) {
  const targets = [];
  for (const a of args) {
    if (a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq <= 0) throw new Error(`target harus berbentuk nama=url: ${a}`);
    const name = a.slice(0, eq);
    let url;
    try {
      url = new URL(a.slice(eq + 1));
    } catch {
      throw new Error(`URL target ${name} tidak valid`);
    }
    if (url.protocol !== "https:") throw new Error(`URL target ${name} wajib https (N-07)`);
    targets.push({ name, url: url.toString() });
  }
  if (targets.length === 0) throw new Error("tidak ada target uji asap");
  return targets;
}

/** Menilai satu respons; mengembalikan null bila lulus atau alasan gagal. */
export function judge(name, status, headers, body) {
  if (status !== 200) return `HTTP ${status}`;
  if (name === "api") {
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return "body bukan JSON HealthReadiness";
    }
    if (json?.status !== "ok")
      return `status readiness ${json?.status} (checks ${JSON.stringify(json?.checks)})`;
    return null;
  }
  if (name === "web" || name === "admin") {
    if (!headers.get("content-security-policy")) return "header Content-Security-Policy tidak ada";
    if ((headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff")
      return "header X-Content-Type-Options: nosniff tidak ada";
  }
  return null;
}

export async function checkOnce(target, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(target.url, {
      headers: { Accept: "application/json, text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return judge(target.name, res.status, res.headers, body);
  } catch (e) {
    return `galat jaringan ${e instanceof Error ? e.name : "unknown"}`;
  }
}

export async function runSmoke({
  targets,
  fetchImpl = fetch,
  timeoutMs = 300_000,
  intervalMs = 10_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
}) {
  const deadline = now() + timeoutMs;
  const failing = new Map(targets.map((t) => [t.name, "belum diperiksa"]));
  for (;;) {
    for (const t of targets) {
      if (!failing.has(t.name)) continue;
      const reason = await checkOnce(t, fetchImpl);
      if (reason === null) {
        failing.delete(t.name);
        log(`OK    ${t.name} ${t.url}`);
      } else if (failing.get(t.name) !== reason) {
        failing.set(t.name, reason);
        log(`tunggu ${t.name}: ${reason}`);
      }
    }
    if (failing.size === 0) return { ok: true, failing };
    if (now() >= deadline) return { ok: false, failing };
    await sleep(intervalMs);
  }
}

function numberArg(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} wajib angka positif`);
  return n;
}

export async function main(argv = process.argv.slice(2)) {
  const values = new Set();
  for (const flag of ["--timeout", "--interval"]) {
    const i = argv.indexOf(flag);
    if (i >= 0) values.add(i + 1);
  }
  const targets = parseTargets(argv.filter((_, i) => !values.has(i)));
  const { ok, failing } = await runSmoke({
    targets,
    timeoutMs: numberArg(argv, "--timeout", 300) * 1000,
    intervalMs: numberArg(argv, "--interval", 10) * 1000,
  });
  for (const [name, reason] of failing) console.log(`::error title=Uji asap ${name} gagal::${reason}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`::error title=smoke::${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
