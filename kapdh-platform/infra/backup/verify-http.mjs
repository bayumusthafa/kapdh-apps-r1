// Pemeriksaan HTTP lingkungan hasil restore (PRD 5.5 "memeriksa login/MFA ... berkas", PRD 8.3 smoke test, N-06).
// Dijalankan verify-restore.sh lewat `node --input-type=module - < verify-http.mjs` (Node >= 20, tanpa dependensi),
// di host atau di dalam image API (NODE_CMD="docker run --rm -i -e ... <image-api> node").
//
// Env:
//   VERIFY_API_URL                 URL dasar API pulihan, mis. http://127.0.0.1:3000 (tanpa /api/v1)
//   DRILL_ADMIN_EMAIL              akun admin khusus drill (bukan Super Admin; izin minimum), opsional
//   DRILL_ADMIN_PASSWORD[_FILE]    sandi admin drill (env atau berkas 0600)
//   DRILL_ADMIN_TOTP_SECRET[_FILE] secret TOTP base32 admin drill, ATAU DRILL_ADMIN_TOTP_CODE (kode 6 digit saat ini)
//   VERIFY_PUBLIC_FILE_ID          id berkas publik untuk uji akses berkas (diisi verify-restore.sh)
//
// Keluaran: satu baris per pemeriksaan `PASS|WARN|FAIL <nama> <detail>`; tidak pernah mencetak sandi, kode, token
// atau isi respons. Keluar 1 bila ada FAIL.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 15_000;
let failed = false;

function report(status, name, detail) {
  if (status === "FAIL") failed = true;
  process.stdout.write(`${status} ${name} ${String(detail).replace(/\s+/g, " ").slice(0, 200)}\n`);
}

function secretFrom(name) {
  const direct = process.env[name];
  if (direct) return direct.trim();
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() : "";
}

/** RFC 4648 base32 (tanpa padding, huruf besar/kecil) -> Buffer. */
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
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

/** RFC 6238 TOTP SHA-1, 6 digit, langkah 30 detik (sama dengan core/identity/crypto.ts). */
function totp(secretBase32, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

async function call(base, method, path, { body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, bytes: Buffer.byteLength(text) };
}

async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    report("FAIL", name, `galat ${error?.name ?? "tidak dikenal"}`);
  }
}

async function main() {
  const base = (process.env.VERIFY_API_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    report("FAIL", "konfigurasi", "VERIFY_API_URL wajib http(s)://host[:port]");
    return;
  }

  await check("health", async () => {
    const res = await call(base, "GET", "/health");
    if (res.status === 200 && res.json?.status === "ok") report("PASS", "health", "200 ok");
    else report("FAIL", "health", `HTTP ${res.status}`);
  });

  await check("ready", async () => {
    const res = await call(base, "GET", "/health/ready");
    const checks = res.json?.checks ?? {};
    // deletion_ledger: database pulihan sudah mengenal permintaan penghapusan terbaru di kepala ledger (AC F14-6).
    const detail = `HTTP ${res.status} database=${checks.database} redis=${checks.redis} storage=${checks.storage} deletion_ledger=${checks.deletion_ledger}`;
    report(res.status === 200 && res.json?.status === "ok" ? "PASS" : "FAIL", "ready", detail);
  });

  const email = process.env.DRILL_ADMIN_EMAIL ?? "";
  if (!email) {
    report("WARN", "admin.login", "DRILL_ADMIN_EMAIL kosong; login/MFA admin drill tidak diuji");
  } else {
    await check("admin.login", async () => {
      const password = secretFrom("DRILL_ADMIN_PASSWORD");
      const login = await call(base, "POST", "/admin/auth/login", { body: { email, password } });
      if (login.status !== 200 || typeof login.json?.mfa_token !== "string") {
        report("FAIL", "admin.login", `HTTP ${login.status} ${login.json?.code ?? ""}`);
        return;
      }
      report("PASS", "admin.login", "sandi diterima, tantangan MFA diterbitkan");
      const code = process.env.DRILL_ADMIN_TOTP_CODE?.trim() || totp(secretFrom("DRILL_ADMIN_TOTP_SECRET"));
      const mfa = await call(base, "POST", "/admin/auth/mfa", {
        body: { mfa_token: login.json.mfa_token, totp_code: code },
      });
      if (mfa.status !== 200 || typeof mfa.json?.access_token !== "string") {
        report("FAIL", "admin.mfa", `HTTP ${mfa.status} ${mfa.json?.code ?? ""}`);
        return;
      }
      report("PASS", "admin.mfa", "TOTP diterima, sesi admin level 2");
      const me = await call(base, "GET", "/admin/me", { token: mfa.json.access_token });
      if (me.status === 200 && typeof me.json?.admin_id === "string")
        report("PASS", "admin.me", `peran ${me.json.role}`);
      else report("FAIL", "admin.me", `HTTP ${me.status}`);
    });
  }

  const fileId = process.env.VERIFY_PUBLIC_FILE_ID ?? "";
  if (!fileId) {
    report("WARN", "berkas.publik", "tidak ada berkas publik ready untuk diuji");
  } else {
    await check("berkas.publik", async () => {
      if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new Error("id berkas tidak valid");
      const res = await fetch(`${base}/api/v1/files/public/${fileId}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && body.byteLength > 0)
        report("PASS", "berkas.publik", `${body.byteLength} byte`);
      else report("FAIL", "berkas.publik", `HTTP ${res.status}`);
    });
  }
}

await main();
process.exitCode = failed ? 1 : 0;
