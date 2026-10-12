import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/** OTP 6 digit dari CSPRNG. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** HMAC dengan secret server dan terikat challenge, sehingga pencarian offline 6 digit tidak mudah (PRD 2.5). */
export function otpHmac(secret: string, challengeId: string, code: string): string {
  return createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Token acak untuk refresh/reset; yang disimpan hanya hash-nya. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------- Base32 (RFC 4648) untuk secret TOTP

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Karakter base32 tidak valid");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 detik, 6 digit)

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secretBase32: string, at: Date, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / 30), digits);
}

/**
 * Langkah TOTP (time step 30 detik) yang cocok dengan kode, atau null. Menerima langkah sebelumnya dan berikutnya
 * untuk toleransi jam perangkat. Pemanggil wajib menyimpan langkah yang dipakai (mfa_totp.last_used_step) dan
 * menolak langkah <= langkah terakhir agar kode yang sama tidak bisa diputar ulang (RFC 6238 §5.2).
 */
export function matchTotpStep(secretBase32: string, code: string, at: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(at.getTime() / 1000 / 30);
  const given = Buffer.from(code);
  let matched: number | null = null;
  // Semua kandidat diperiksa (tanpa keluar lebih awal) agar waktu tidak membocorkan langkah yang cocok.
  for (const d of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(secret, step + d));
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = step + d;
  }
  return matched;
}

/** true bila kode cocok pada jendela ±1 langkah (tanpa perlindungan replay; lihat matchTotpStep). */
export function verifyTotp(secretBase32: string, code: string, at: Date): boolean {
  return matchTotpStep(secretBase32, code, at) !== null;
}

// ---------------------------------------------------------------- Backup code sekali pakai (F-02)

/** Backup code 10 karakter base32 (50 bit), dikelompokkan XXXXX-XXXXX agar mudah disalin. */
export function newBackupCode(): string {
  const raw = base32Encode(randomBytes(8)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Normalisasi masukan backup code: huruf besar, tanpa spasi/tanda hubung. */
export function normalizeBackupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Hash backup code dengan HMAC secret server (bukan SHA-256 polos) sehingga kebocoran database tidak memungkinkan
 * pencarian offline ruang kode (audit domain). Disimpan di mfa_totp.backup_code_hashes.
 */
export function backupCodeHash(serverSecret: string, code: string): string {
  return createHmac("sha256", serverSecret).update(`backup:${normalizeBackupCode(code)}`).digest("hex");
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ---------------------------------------------------------------- AES-256-GCM untuk secret TOTP tersimpan

export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, keyHex: string): string {
  const [v, iv, tag, enc] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("Format secret terenkripsi tidak dikenal");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
}
