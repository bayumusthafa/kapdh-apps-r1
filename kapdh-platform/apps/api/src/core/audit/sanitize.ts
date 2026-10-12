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

export const AUDIT_LIMITS = {
  maxDepth: 6,
  maxArrayItems: 50,
  maxStringLength: 2000,
  maxObjectKeys: 100,
  /** Batas ukuran JSON setiap sisi before/after. */
  maxBytes: 16 * 1024,
} as const;

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

function clean(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string")
    return value.length > AUDIT_LIMITS.maxStringLength
      ? `${value.slice(0, AUDIT_LIMITS.maxStringLength)}…`
      : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return "[biner]";
  if (typeof value !== "object") return null; // fungsi, symbol
  if (depth >= AUDIT_LIMITS.maxDepth) return "[terlalu dalam]";
  if (Array.isArray(value)) {
    const items = value.slice(0, AUDIT_LIMITS.maxArrayItems).map((item) => clean(item, depth + 1));
    if (value.length > AUDIT_LIMITS.maxArrayItems)
      items.push(`[+${value.length - AUDIT_LIMITS.maxArrayItems} item]`);
    return items;
  }
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveAuditKey(key) || inner === undefined || typeof inner === "function") continue;
    if (++count > AUDIT_LIMITS.maxObjectKeys) {
      result._truncated = true;
      break;
    }
    result[key] = clean(inner, depth + 1);
  }
  return result;
}

/** Nilai before/after yang aman dan berukuran terbatas, atau null. */
export function sanitizeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const cleaned = clean(value, 0);
  const json = JSON.stringify(cleaned);
  if (Buffer.byteLength(json, "utf8") <= AUDIT_LIMITS.maxBytes) return cleaned;
  // Terlalu besar: simpan kerangka kunci tingkat atas saja agar jejak perubahan tetap terbaca.
  const keys =
    cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
      ? Object.keys(cleaned).slice(0, AUDIT_LIMITS.maxObjectKeys)
      : [];
  return { _truncated: true, keys };
}
