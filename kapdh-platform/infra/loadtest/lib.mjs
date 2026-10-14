// Pustaka bersama alat uji beban KAPDH (PRD 2.4 N-01, N-02, N-04; docs/runbooks/load-test.md). Node >= 22, tanpa
// dependensi (fetch dan WebSocket bawaan). Tidak pernah mencetak sandi, token, kode TOTP atau isi respons.
//
// Model beban TERBUKA (open model): kedatangan dijadwalkan pada laju tetap tanpa menunggu respons sebelumnya, sehingga
// API yang melambat tidak menurunkan beban (menghindari coordinated omission). Kedatangan yang tidak dapat dijalankan
// karena batas in-flight dicatat `dropped` (generator jenuh); lebih dari 1 % membuat hasil TIDAK SAH.
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const uuid = () => randomUUID();
export const nowMs = () => performance.now();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Opsi baris perintah: `--nama nilai`; nilai bawaan dari env KAPDH_LOAD_<NAMA> lalu `defaults`. */
export function cliOptions(names, defaults, argv = process.argv.slice(2)) {
  const options = {};
  for (const name of names) options[name] = { type: "string" };
  options.help = { type: "boolean", short: "h" };
  const { values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  const out = { help: Boolean(values.help) };
  for (const name of names) {
    const env = process.env[`KAPDH_LOAD_${name.toUpperCase().replace(/-/g, "_")}`];
    out[name] = values[name] ?? env ?? defaults[name];
  }
  return out;
}

export function numArg(value, name, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} harus angka >= ${min}`);
  return n;
}

/** Berkas kredensial dari `loadtest:seed` (apps/api/src/cli/loadtest-seed.ts). */
export function loadCredentials(path) {
  if (!path) throw new Error("--credentials wajib (berkas dari pnpm --filter @kapdh/api loadtest:seed)");
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (data?.kind !== "kapdh.loadtest_credentials" || data?.version !== 1)
    throw new Error("berkas kredensial bukan kapdh.loadtest_credentials v1");
  if (!Array.isArray(data.members) || data.members.length === 0) throw new Error("kredensial tanpa anggota");
  return data;
}

/** URL dasar API tanpa /api/v1 (mis. https://api-staging.kapdh.or.id). */
export function baseUrl(value) {
  const base = String(value ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base))
    throw new Error("--base-url wajib http(s)://host[:port] (tanpa /api/v1)");
  return base;
}

// ------------------------------------------------------------------------------------------------- statistik

/** Persentil nearest-rank dari larik terurut naik (Infinity diperbolehkan untuk pengiriman yang hilang). */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const finite = sorted.filter(Number.isFinite);
  const round = (v) => (v === null ? null : Number.isFinite(v) ? Math.round(v * 10) / 10 : "Infinity");
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.length ? sorted[sorted.length - 1] : null),
    mean: finite.length ? round(finite.reduce((s, v) => s + v, 0) / finite.length) : null,
  };
}

/** Nilai persentil sebagai angka (Infinity bila "Infinity"); null bila tidak ada sampel. */
export const asNumber = (v) => (v === "Infinity" ? Infinity : v);

/**
 * Pencatat hasil per fase (warmup, measure, step-<laju>) dan per operasi. Outcome: ok, conflict (409 bisnis yang
 * diharapkan, mis. keputusan bersamaan), rate_limited (429), error (5xx, 4xx tak terduga, jaringan, timeout).
 */
export class Recorder {
  constructor() {
    this.phase = "setup";
    this.phases = new Map();
  }

  setPhase(name) {
    this.phase = name;
  }

  bucket(phase = this.phase) {
    let b = this.phases.get(phase);
    if (!b) {
      b = { ops: new Map(), arrivals: 0, dropped: 0, substituted: {}, startedAt: Date.now(), endedAt: null };
      this.phases.set(phase, b);
    }
    return b;
  }

  record(op, cls, ms, outcome, status, code) {
    const ops = this.bucket().ops;
    let o = ops.get(op);
    if (!o) {
      o = { cls, latencies: [], ok: 0, conflict: 0, rate_limited: 0, error: 0, statuses: {}, codes: {} };
      ops.set(op, o);
    }
    o.latencies.push(ms);
    o[outcome] += 1;
    o.statuses[status] = (o.statuses[status] ?? 0) + 1;
    if (outcome !== "ok" && code) o.codes[code] = (o.codes[code] ?? 0) + 1;
  }

  substitute(op) {
    const s = this.bucket().substituted;
    s[op] = (s[op] ?? 0) + 1;
  }

  /** Ringkasan satu fase: per operasi, per kelas (read/decision/...), total. */
  report(phase) {
    const b = this.phases.get(phase);
    if (!b) return null;
    const ops = {};
    const classes = {};
    const total = { requests: 0, ok: 0, conflict: 0, rate_limited: 0, error: 0 };
    for (const [name, o] of [...b.ops.entries()].sort(([a], [z]) => a.localeCompare(z))) {
      ops[name] = {
        cls: o.cls,
        ...summarize(o.latencies),
        ok: o.ok,
        conflict: o.conflict,
        rate_limited: o.rate_limited,
        error: o.error,
        statuses: o.statuses,
        error_codes: o.codes,
      };
      const c = (classes[o.cls] ??= { latencies: [], ok: 0, conflict: 0, rate_limited: 0, error: 0 });
      c.latencies.push(...o.latencies);
      for (const k of ["ok", "conflict", "rate_limited", "error"]) {
        c[k] += o[k];
        total[k] += o[k];
      }
      total.requests += o.latencies.length;
    }
    const classSummary = {};
    for (const [name, c] of Object.entries(classes))
      classSummary[name] = {
        ...summarize(c.latencies),
        ok: c.ok,
        conflict: c.conflict,
        rate_limited: c.rate_limited,
        error: c.error,
      };
    const seconds = Math.max(0.001, ((b.endedAt ?? Date.now()) - b.startedAt) / 1000);
    return {
      phase,
      started_at: new Date(b.startedAt).toISOString(),
      ended_at: new Date(b.endedAt ?? Date.now()).toISOString(),
      seconds: Math.round(seconds),
      arrivals: b.arrivals,
      dropped: b.dropped,
      substituted: b.substituted,
      achieved_rps: Math.round((total.requests / seconds) * 100) / 100,
      total: {
        ...total,
        error_rate: total.requests ? total.error / total.requests : 0,
        rate_limited_rate: total.requests ? total.rate_limited / total.requests : 0,
      },
      classes: classSummary,
      ops,
    };
  }
}

// ------------------------------------------------------------------------------------------------------ HTTP

/**
 * Klien HTTP pencatat. `expect` = status sukses; `conflict` = status bisnis yang diharapkan pada beban bersamaan
 * (dicatat terpisah, bukan galat tak terduga). Tidak ada retry otomatis: setiap permintaan tercatat apa adanya.
 */
export class Api {
  constructor(base, recorder, { timeoutMs = 30_000, appVersion = "1.0.0" } = {}) {
    this.base = base;
    this.recorder = recorder;
    this.timeoutMs = timeoutMs;
    this.appVersion = appVersion;
  }

  async call(method, path, opts = {}) {
    const { token, body, headers = {}, op = `${method} ${path}`, cls = "read" } = opts;
    const expect = opts.expect ?? [200];
    const conflict = opts.conflict ?? [];
    const h = {
      accept: "application/json",
      "user-agent": "kapdh-loadtest/1",
      "x-app-platform": "android",
      "x-app-version": this.appVersion,
      ...headers,
    };
    if (body !== undefined) h["content-type"] = "application/json";
    if (token) h.authorization = `Bearer ${token}`;
    const started = nowMs();
    let status = 0;
    let json = null;
    let code = null;
    try {
      const res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      code = typeof json?.code === "string" ? json.code : null;
    } catch (error) {
      code = error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK";
    }
    const ms = nowMs() - started;
    const outcome = expect.includes(status)
      ? "ok"
      : conflict.includes(status)
        ? "conflict"
        : status === 429
          ? "rate_limited"
          : "error";
    if (opts.record !== false) this.recorder.record(op, cls, ms, outcome, status, code);
    return { status, json, ms, outcome, code };
  }
}

// --------------------------------------------------------------------------------------------- autentikasi

/** RFC 4648 base32 -> Buffer (sama dengan apps/api core/identity/crypto.ts). */
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of input.replace(/[\s=-]/g, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("secret TOTP bukan base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP SHA-1, 6 digit, langkah 30 detik. */
export function totp(secretBase32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

const expiresIn = (iso) => (iso ? Date.parse(iso) - Date.now() : 15 * 60_000);

/**
 * Sesi anggota: login sekali, lalu refresh terkoordinasi (satu refresh per sesi; refresh ganda bersamaan akan
 * dianggap reuse dan mencabut keluarga sesi, AC F02-3) saat access token tersisa < 2 menit.
 */
export class MemberSession {
  constructor(api, email, password, userId) {
    this.api = api;
    this.email = email;
    this.password = password;
    this.userId = userId;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.refreshing = null;
  }

  async login() {
    const res = await this.api.call("POST", "/auth/login", {
      body: { email: this.email, password: this.password, device_name: "uji-beban" },
      op: "auth.login",
      cls: "auth",
    });
    if (res.status !== 200 || res.json?.next !== "home" || !res.json?.session?.access_token)
      throw new Error(`login anggota gagal: HTTP ${res.status} ${res.code ?? res.json?.next ?? ""}`);
    this.accept(res.json.session);
  }

  accept(pair) {
    this.accessToken = pair.access_token;
    this.refreshToken = pair.refresh_token ?? this.refreshToken;
    this.expiresAt = Date.now() + expiresIn(pair.access_expires_at);
  }

  async token() {
    if (this.expiresAt - Date.now() > 120_000) return this.accessToken;
    this.refreshing ??= (async () => {
      const res = await this.api.call("POST", "/auth/refresh", {
        body: { refresh_token: this.refreshToken },
        op: "auth.refresh",
        cls: "auth",
      });
      if (res.status === 200 && res.json?.access_token) this.accept(res.json);
      else await this.login();
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this.accessToken;
  }
}

/** Sesi admin: sandi + TOTP (langkah waktu tidak dipakai ulang per admin; server menolak replay). */
export class AdminSession {
  constructor(api, admin) {
    this.api = api;
    this.admin = admin;
    this.accessToken = null;
    this.expiresAt = 0;
    this.lastStep = -1;
    this.refreshing = null;
  }

  async login() {
    const res = await this.api.call("POST", "/admin/auth/login", {
      body: { email: this.admin.email, password: this.admin.password },
      op: "admin.auth.login",
      cls: "auth",
    });
    if (res.status !== 200 || typeof res.json?.mfa_token !== "string")
      throw new Error(`login admin gagal: HTTP ${res.status} ${res.code ?? ""}`);
    let mfa = null;
    let step = this.lastStep;
    // Server menolak langkah TOTP yang sudah dipakai akun ini (anti replay), termasuk oleh proses alat lain yang
    // baru saja login dengan admin yang sama: kode 400 -> tunggu langkah berikutnya lalu coba sekali lagi.
    for (let attempt = 0; attempt < 2; attempt++) {
      step = Math.floor(Date.now() / 30_000);
      if (step <= this.lastStep) {
        await sleep((this.lastStep + 1) * 30_000 - Date.now() + 50);
        step = Math.floor(Date.now() / 30_000);
      }
      mfa = await this.api.call("POST", "/admin/auth/mfa", {
        body: { mfa_token: res.json.mfa_token, totp_code: totp(this.admin.totp_secret, step) },
        op: "admin.auth.mfa",
        cls: "auth",
        conflict: [400],
      });
      if (mfa.status !== 400) break;
      this.lastStep = step;
    }
    if (mfa.status !== 200 || typeof mfa.json?.access_token !== "string")
      throw new Error(`MFA admin gagal: HTTP ${mfa.status} ${mfa.code ?? ""}`);
    this.lastStep = step;
    this.accessToken = mfa.json.access_token;
    this.expiresAt = Date.now() + expiresIn(mfa.json.access_expires_at);
  }

  async token() {
    if (this.expiresAt - Date.now() > 120_000) return this.accessToken;
    this.refreshing ??= this.login().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this.accessToken;
  }
}

/** Menjalankan `fn` atas item dengan konkurensi terbatas (login awal tidak membanjiri bcrypt server). */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------------------- penjadwal beban

/**
 * Kedatangan laju tetap `rate`/detik selama `durationMs` (model terbuka, seperti constant-arrival-rate k6).
 * `onArrival()` dijalankan tanpa menunggu; bila in-flight >= `maxInFlight` kedatangan dicatat dropped.
 */
export async function runArrivals({ rate, durationMs, maxInFlight, onArrival, recorder }) {
  const interval = 1000 / rate;
  const start = nowMs();
  const pending = new Set();
  let issued = 0;
  let inFlight = 0;
  for (;;) {
    const elapsed = nowMs() - start;
    if (elapsed >= durationMs) break;
    const due = Math.min(Math.floor(elapsed / interval) + 1, Math.ceil(durationMs / interval));
    while (issued < due) {
      issued += 1;
      const b = recorder.bucket();
      b.arrivals += 1;
      if (inFlight >= maxInFlight) {
        b.dropped += 1;
        continue;
      }
      inFlight += 1;
      const p = Promise.resolve()
        .then(onArrival)
        .catch(() => recorder.record("internal", "internal", 0, "error", 0, "GENERATOR"))
        .finally(() => {
          inFlight -= 1;
          pending.delete(p);
        });
      pending.add(p);
    }
    await sleep(Math.min(50, issued * interval - (nowMs() - start)));
  }
  await Promise.allSettled([...pending]);
  recorder.bucket().endedAt = Date.now();
}

// --------------------------------------------------------------------------------------------- Socket.IO

/**
 * Klien Socket.IO minimal (Engine.IO v4, transport websocket saja, seperti gateway ARCHITECTURE §4.9) ke namespace
 * /realtime dengan auth handshake {token}. Event server tiba sebagai paket `42/realtime,[nama, amplop]`.
 */
export class RealtimeClient {
  constructor(base, namespace = "/realtime") {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/socket.io/";
    url.search = "?EIO=4&transport=websocket";
    this.url = url.toString();
    this.namespace = namespace;
    this.socket = null;
    this.connected = false;
    this.handlers = new Map();
    this.onClose = null;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  connect(token, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const ns = this.namespace;
      const timer = setTimeout(() => {
        try {
          this.socket?.close();
        } catch {
          // abaikan
        }
        reject(new Error("CONNECT realtime timeout"));
      }, timeoutMs);
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data.startsWith("0{")) {
          socket.send(`40${ns},${JSON.stringify({ token })}`);
        } else if (data === "2") {
          socket.send("3");
        } else if (data.startsWith(`40${ns},`)) {
          this.connected = true;
          clearTimeout(timer);
          resolve();
        } else if (data.startsWith(`44${ns},`)) {
          clearTimeout(timer);
          reject(new Error("CONNECT_ERROR realtime"));
        } else if (data.startsWith(`42${ns},`)) {
          const at = nowMs();
          const rest = data.slice(`42${ns},`.length).replace(/^\d+/, "");
          let packet;
          try {
            packet = JSON.parse(rest);
          } catch {
            return;
          }
          const handler = this.handlers.get(packet[0]);
          if (handler) handler(packet[1], at);
        } else if (data.startsWith(`41${ns}`)) {
          // Server memutus namespace (mis. sesi dicabut): putus tak terduga bagi alat beban.
          const was = this.connected;
          this.close();
          if (was && this.onClose) this.onClose();
        }
      });
      socket.addEventListener("close", () => {
        const was = this.connected;
        this.connected = false;
        clearTimeout(timer);
        if (was && this.onClose) this.onClose();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket galat"));
      });
    });
  }

  /** Penutupan sengaja: `connected` false lebih dahulu sehingga onClose (putus tak terduga) tidak dipanggil. */
  close() {
    this.connected = false;
    try {
      this.socket?.close();
    } catch {
      // abaikan
    }
  }
}

// ------------------------------------------------------------------------------------------------ laporan

export function writeReport(dir, name, report, text) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const json = join(dir, `${name}-${stamp}.json`);
  const txt = join(dir, `${name}-${stamp}.txt`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(txt, text);
  return { json, txt };
}

export const fmtMs = (v) => (v === null || v === undefined ? "-" : v === "Infinity" ? "∞" : `${v} ms`);
export const pct = (v) => `${(v * 100).toFixed(2)} %`;
