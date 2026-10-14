#!/usr/bin/env node
// Uji asap HTTP sesudah deploy (PRD 5.5 monitoring HTTP dan "mempromosikan image yang sama"; 8.3 smoke test).
// Mengulang sampai lulus atau habis waktu, karena kontainer baru butuh waktu untuk siap di belakang Traefik.
//
//   node infra/ci/smoke.mjs [--timeout 300] [--interval 10] [--expect-commit <sha 40 hex>]
//     api=<API_BASE_URL>/health/ready web=<WEB_URL> admin=<ADMIN_URL>
//
// Aturan per nama:
//   api    HTTP 200 dan JSON {status: "ok"} (HealthReadiness: database, redis, storage, deletion ledger)
//   web    HTTP 200, header Content-Security-Policy dan X-Content-Type-Options: nosniff (N-07, nginx-web.conf)
//   admin  sama dengan web (nginx-admin.conf)
//   lain   HTTP 200
// Dengan --expect-commit, setiap api/web/admin juga wajib melaporkan commit sumber image yang sama persis:
//   api    GET <...>/health (bukan /ready) -> {"commit": "<sha>"} (KAPDH_COMMIT, infra/Dockerfile.api)
//   web    GET <WEB_URL>/version.json -> {"commit": "<sha>"} (infra/Dockerfile.web)
//   admin  GET <ADMIN_URL>/version.json (infra/Dockerfile.admin)
// Kontainer lama yang masih melayani (Coolify tidak me-rollout) lulus readiness tetapi GAGAL di sini.
// Hanya URL https yang diterima (N-07).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

/** URL yang melaporkan commit sumber image untuk sebuah target, atau null bila nama tidak dikenal. */
export function commitUrl(target) {
  if (target.name === "api") {
    if (!/\/health\/ready\/?$/.test(new URL(target.url).pathname))
      throw new Error("target api wajib berakhir di /health/ready untuk pemeriksaan commit");
    return target.url.replace(/\/health\/ready\/?$/, "/health");
  }
  if (target.name === "web" || target.name === "admin")
    return new URL("/version.json", target.url).toString();
  return null;
}

export function parseTargets(args, { expectCommit = null } = {}) {
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
    const target = { name, url: url.toString() };
    if (expectCommit !== null) {
      const cu = commitUrl(target);
      if (cu !== null) target.commitUrl = cu;
    }
    targets.push(target);
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

/** Menilai respons commit (/health atau /version.json); null bila commit sama dengan yang diharapkan. */
export function judgeCommit(status, body, expected) {
  if (status !== 200) return `commit: HTTP ${status}`;
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return "commit: body bukan JSON";
  }
  const actual = json?.commit ?? null;
  if (actual === expected) return null;
  return `commit image ${actual === null ? "tidak dilaporkan" : String(actual).slice(0, 12)} != ${expected.slice(0, 12)} (kontainer lama masih melayani?)`;
}

async function get(url, fetchImpl, accept) {
  const res = await fetchImpl(url, {
    headers: { Accept: accept },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

export async function checkOnce(target, fetchImpl = fetch, expectCommit = null) {
  try {
    const main = await get(target.url, fetchImpl, "application/json, text/html");
    const reason = judge(target.name, main.status, main.headers, main.body);
    if (reason !== null || expectCommit === null || !target.commitUrl) return reason;
    const version = await get(target.commitUrl, fetchImpl, "application/json");
    return judgeCommit(version.status, version.body, expectCommit);
  } catch (e) {
    return `galat jaringan ${e instanceof Error ? e.name : "unknown"}`;
  }
}

export async function runSmoke({
  targets,
  expectCommit = null,
  fetchImpl = fetch,
  timeoutMs = 300_000,
  intervalMs = 10_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
}) {
  if (expectCommit !== null && !SHA_RE.test(expectCommit))
    throw new Error("--expect-commit wajib SHA commit 40 heksadesimal");
  const deadline = now() + timeoutMs;
  const failing = new Map(targets.map((t) => [t.name, "belum diperiksa"]));
  for (;;) {
    for (const t of targets) {
      if (!failing.has(t.name)) continue;
      const reason = await checkOnce(t, fetchImpl, expectCommit);
      if (reason === null) {
        failing.delete(t.name);
        log(
          `OK    ${t.name} ${t.url}${expectCommit && t.commitUrl ? ` (commit ${expectCommit.slice(0, 12)})` : ""}`,
        );
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

function valueArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function numberArg(argv, name, fallback) {
  const raw = valueArg(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} wajib angka positif`);
  return n;
}

export async function main(argv = process.argv.slice(2)) {
  const values = new Set();
  for (const flag of ["--timeout", "--interval", "--expect-commit"]) {
    const i = argv.indexOf(flag);
    if (i >= 0) values.add(i + 1);
  }
  const expectCommit = valueArg(argv, "--expect-commit") ?? null;
  const targets = parseTargets(
    argv.filter((_, i) => !values.has(i)),
    { expectCommit },
  );
  const { ok, failing } = await runSmoke({
    targets,
    expectCommit,
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
