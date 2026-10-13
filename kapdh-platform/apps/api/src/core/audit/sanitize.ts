/**
 * Penyaring before/after audit (F-17, AC F17-3; ARCHITECTURE §2.3): audit bukan salinan payload. Kunci yang
 * berbau rahasia dibuang seluruhnya (sandi, hash, OTP/HMAC, token, secret TOTP, backup code, NIK/KTP, rekening
 * refund, token push), lalu ukuran dibatasi agar baris audit tetap kecil.
 */

/** Segmen nama kunci (snake_case/camelCase) yang membuat kunci dibuang. */
const SENSITIVE_SEGMENTS = new Set([
  "password",
  "passwords",
  "passwd",
  "secret",
  "secrets",
  "token",
  "tokens",
  "otp",
  "totp",
  "hmac",
  "hash",
  "hashes",
  "nik",
  "ktp",
  "cookie",
  "authorization",
  "credential",
  "credentials",
]);

/** Frasa lengkap yang dibuang walau segmennya umum. */
const SENSITIVE_KEYS = new Set([
  "code",
  "backup_code",
  "backup_codes",
  "refund_destination",
  "bank_account",
  "account_number",
  "private_key",
  "push_token",
  "device_token",
]);

export interface AuditLimits {
  readonly maxDepth: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxObjectKeys: number;
  /** Batas ukuran JSON setiap sisi before/after. */
  readonly maxBytes: number;
}

export const AUDIT_LIMITS = {
  maxDepth: 6,
  maxArrayItems: 50,
  maxStringLength: 2000,
  maxObjectKeys: 100,
  /** Batas ukuran JSON setiap sisi before/after. */
  maxBytes: 16 * 1024,
} as const satisfies AuditLimits;

/**
 * Batas untuk entri yang WAJIB menyimpan teks dokumen utuh agar versi yang pernah disetujui dapat direproduksi
 * (audit `page.published`: judul <= 200 dan body HTML tayang HASIL SANITASI <= 200.000 karakter, F-01, F-17). Kunci
 * rahasia tetap dibuang; hanya batas panjang string dan ukuran yang dilonggarkan. Jangan dipakai untuk payload biasa.
 * `maxBytes` menampung kasus terburuk JSON: setiap karakter kontrol menjadi escape 6 byte (`\u0001`), sehingga
 * 200.000 karakter body + judul + catatan perubahan (500) tetap < 1,3 MB, jauh di bawah 2 MiB.
 */
export const AUDIT_DOCUMENT_LIMITS = {
  ...AUDIT_LIMITS,
  maxStringLength: 250_000,
  maxBytes: 2 * 1024 * 1024,
} as const satisfies AuditLimits;

function segments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

export function isSensitiveAuditKey(key: string): boolean {
  const parts = segments(key);
  if (SENSITIVE_KEYS.has(parts.join("_"))) return true;
  return parts.some((part) => SENSITIVE_SEGMENTS.has(part));
}

function clean(value: unknown, depth: number, limits: AuditLimits): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string")
    return value.length > limits.maxStringLength ? `${value.slice(0, limits.maxStringLength)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return "[biner]";
  if (typeof value !== "object") return null; // fungsi, symbol
  if (depth >= limits.maxDepth) return "[terlalu dalam]";
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.maxArrayItems).map((item) => clean(item, depth + 1, limits));
    if (value.length > limits.maxArrayItems) items.push(`[+${value.length - limits.maxArrayItems} item]`);
    return items;
  }
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveAuditKey(key) || inner === undefined || typeof inner === "function") continue;
    if (++count > limits.maxObjectKeys) {
      result._truncated = true;
      break;
    }
    result[key] = clean(inner, depth + 1, limits);
  }
  return result;
}

/**
 * Nilai before/after yang aman dan berukuran terbatas, atau null. `limits` bawaan {@link AUDIT_LIMITS};
 * {@link AUDIT_DOCUMENT_LIMITS} hanya untuk entri yang wajib menyimpan teks dokumen utuh.
 */
export function sanitizeAuditValue(value: unknown, limits: AuditLimits = AUDIT_LIMITS): unknown {
  if (value === undefined || value === null) return null;
  const cleaned = clean(value, 0, limits);
  const json = JSON.stringify(cleaned);
  if (Buffer.byteLength(json, "utf8") <= limits.maxBytes) return cleaned;
  // Terlalu besar: simpan kerangka kunci tingkat atas saja agar jejak perubahan tetap terbaca.
  const keys =
    cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
      ? Object.keys(cleaned).slice(0, limits.maxObjectKeys)
      : [];
  return { _truncated: true, keys };
}
