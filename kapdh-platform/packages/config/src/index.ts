import { z } from "zod";

/**
 * Validasi environment server (API dan worker). Gagal cepat saat start bila ada nilai yang hilang.
 * Secrets tidak pernah masuk frontend, image layer, atau log (PRD 5.3).
 */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("https://api.kapdh.or.id"),
  QR_SIGNING_KEYS: z
    .string()
    .min(1)
    .describe("Daftar key_id:secret dipisah koma; kunci pertama aktif untuk menandatangani token QR"),
  OTP_HMAC_SECRET: z.string().min(32),
  TOTP_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TOTP_ENC_KEY harus 64 karakter hex (32 byte)")
    .describe("Kunci AES-256-GCM untuk mengenkripsi secret TOTP admin"),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  SMTP_URL: z
    .string()
    .url()
    .optional()
    .describe("smtp://user:pass@host:port; kosong di dev = OTP dicetak ke log"),
  PUBLIC_WEB_URL: z.string().url().default("https://kapdh.or.id"),
  ADMIN_ORIGIN: z.string().url().default("https://admin.kapdh.or.id"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_ROOT: z.string().default("/data/files"),
  MAIL_FROM: z.string().default("KAPDH <noreply@kapdh.or.id>"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Konfigurasi environment tidak valid: ${fields}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.QR_SIGNING_KEYS.includes("dev-")) {
    throw new Error("QR_SIGNING_KEYS development tidak boleh dipakai di production");
  }
  if (
    (parsed.data.NODE_ENV === "production" || parsed.data.NODE_ENV === "staging") &&
    !parsed.data.SMTP_URL
  ) {
    throw new Error("SMTP_URL wajib di staging dan production; OTP tidak boleh hanya dicetak ke log");
  }
  return parsed.data;
}

export function parseSigningKeys(raw: string): { keyId: string; secret: string }[] {
  return raw.split(",").map((pair) => {
    const [keyId, secret] = pair.split(":");
    if (!keyId || !secret || secret.length < 32)
      throw new Error("Format QR_SIGNING_KEYS harus key_id:secret (secret >= 32 karakter)");
    return { keyId, secret };
  });
}
