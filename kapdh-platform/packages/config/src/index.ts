import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * Validasi environment server KAPDH (PRD 5.3, 7.2; ARCHITECTURE §1). Gagal cepat saat start bila ada nilai yang
 * hilang atau tidak aman. Secrets tidak pernah masuk frontend, image layer, atau log (PRD 5.3, N-14).
 *
 * Skema dipisah tiga:
 *   - `baseEnvSchema`   : dipakai API dan worker (database, Redis, email, storage, push, URL publik, log).
 *   - `apiEnvSchema`    : base + HTTP dan secrets autentikasi (JWT, OTP, TOTP, QR, bcrypt, proxy, HSTS).
 *   - `workerEnvSchema` : base + konkurensi worker. Worker tidak memegang secret penandatanganan token (least
 *                         privilege, PRD 5.1).
 */

const NODE_ENVS = ["development", "test", "staging", "production"] as const;
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Placeholder dari .env.example; ditolak di staging/production agar contoh tidak pernah menjadi secret nyata. */
const PLACEHOLDER = "ganti-dengan";

/** URL tanpa garis miring penutup, misalnya https://kapdh.or.id (dipakai menyusun tautan KTA, PRD 3.5). */
const baseUrl = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ""));

/** Origin (skema + host + port) yang dinormalisasi; browser tidak pernah mengirim garis miring penutup (PRD 5.2). */
const origin = z
  .string()
  .url()
  .transform((v) => new URL(v).origin);

/** Kunci QR: `key_id:secret` dipisah koma; kunci pertama menandatangani, semua kunci memverifikasi (ARCHITECTURE §3.2). */
export interface SigningKey {
  keyId: string;
  secret: string;
}

/**
 * Mengurai QR_SIGNING_KEYS. Pemisah id dan secret adalah titik dua PERTAMA (secret boleh mengandung `:`), key id
 * unik, dan secret minimal 32 karakter. Galat tidak pernah memuat isi secret.
 */
export function parseSigningKeys(raw: string): SigningKey[] {
  const entries = raw
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
  if (entries.length === 0) throw new Error("QR_SIGNING_KEYS kosong; format key_id:secret dipisah koma");
  const seen = new Set<string>();
  return entries.map((pair, index) => {
    const separator = pair.indexOf(":");
    const keyId = separator > 0 ? pair.slice(0, separator).trim() : "";
    const secret = separator > 0 ? pair.slice(separator + 1) : "";
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId))
      throw new Error(`QR_SIGNING_KEYS entri ke-${index + 1}: key_id wajib 1-32 karakter [A-Za-z0-9_-]`);
    if (secret.length < 32)
      throw new Error(`QR_SIGNING_KEYS entri ke-${index + 1} (${keyId}): secret minimal 32 karakter`);
    if (seen.has(keyId)) throw new Error(`QR_SIGNING_KEYS: key_id ${keyId} ganda`);
    seen.add(keyId);
    return { keyId, secret };
  });
}

/** Isi FCM_SERVICE_ACCOUNT_JSON minimum yang dibutuhkan untuk OAuth FCM HTTP v1 (ARCHITECTURE §4.7). */
export interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export function parseFcmServiceAccount(raw: string): FcmServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Pesan sengaja tidak memuat potongan isi (berisi private key).
    throw new Error("FCM_SERVICE_ACCOUNT_JSON bukan JSON yang valid");
  }
  const account = parsed as Partial<FcmServiceAccount> | null;
  if (
    !account ||
    typeof account !== "object" ||
    typeof account.client_email !== "string" ||
    typeof account.private_key !== "string"
  )
    throw new Error("FCM_SERVICE_ACCOUNT_JSON wajib memuat client_email dan private_key");
  return account as FcmServiceAccount;
}

// ---------------------------------------------------------------------------------------------------- skema base

const baseShape = {
  NODE_ENV: z.enum(NODE_ENVS).default("development"),
  DATABASE_URL: z.string().url(),
  /** Wajib di production (rate limit lintas replica, BullMQ, adapter realtime; PRD 5.1). Opsional di luar itu. */
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  PUBLIC_WEB_URL: baseUrl.default("https://kapdh.or.id"),
  /**
   * URL publik API tanpa garis miring penutup (mis. https://api.kapdh.or.id). Dipakai menyusun URL absolut berkas:
   * gambar publik `/api/v1/files/public/<id>` dan URL bertanda tangan `/api/v1/files/content/<token>` (PRD 5.4).
   */
  API_PUBLIC_URL: baseUrl.default("https://api.kapdh.or.id"),
  ADMIN_ORIGIN: origin.default("https://admin.kapdh.or.id"),
  SMTP_URL: z
    .string()
    .url()
    .optional()
    .describe("smtp://user:pass@host:port; kosong di development = OTP dicetak ke log"),
  MAIL_FROM: z.string().min(3).default("KAPDH <noreply@kapdh.or.id>"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_ROOT: z.string().min(1).default("/data/files"),
  S3_ENDPOINT: z.string().url().optional().describe("Endpoint S3-compatible; kosong = AWS S3 standar"),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(3).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  /**
   * Baca-cadangan selama perpindahan local -> S3 (PRD 5.4, docs/runbooks/storage-migration.md): folder disk lama yang
   * dibaca bila objek belum ada di bucket; tulisan ke S3, penghapusan ke keduanya. Hanya bersama STORAGE_DRIVER=s3.
   */
  STORAGE_FALLBACK_LOCAL_ROOT: z.string().min(1).optional(),
  /**
   * Deletion ledger DI LUAR VPS (AC F14-6, D2, D9, PRD 5.5; audit D5-07): bucket S3-compatible KHUSUS (versioning +
   * object lock/retensi), terpisah dari bucket berkas STORAGE_DRIVER dan dari repositori backup, dengan kredensial
   * sendiri (cukup hak tulis objek). Job penghapusan akun menambahkan setiap entri ledger ke sini secara sinkron dan
   * gagal bila penulisan gagal, sehingga hilangnya VPS tidak menghidupkan kembali akun yang sudah dihapus. Wajib untuk
   * worker di production; API tidak memakainya (least privilege, PRD 5.1).
   */
  DELETION_LEDGER_S3_ENDPOINT: z.string().url().optional(),
  DELETION_LEDGER_S3_REGION: z.string().min(1).optional(),
  DELETION_LEDGER_S3_BUCKET: z.string().min(3).optional(),
  DELETION_LEDGER_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  DELETION_LEDGER_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  DELETION_LEDGER_S3_FORCE_PATH_STYLE: z.stringbool().optional(),
  /**
   * Pelacakan galat GlitchTip/Sentry (PRD 7.1, 5.5; docs/runbooks/monitoring.md bagian 5). Kosong = nonaktif. Event hanya
   * berisi field log yang sudah aman (tipe galat, kode, frame stack, request_id/job_id; N-14).
   */
  SENTRY_DSN: z
    .string()
    .regex(
      /^https?:\/\/[^/@\s]+@[^/\s]+(\/[^\s]*)?\/\d+\/?$/,
      "SENTRY_DSN harus berbentuk https://<kunci>@<host>/<id-proyek>",
    )
    .optional(),
  /** Nama lingkungan di GlitchTip (bawaan NODE_ENV). */
  SENTRY_ENVIRONMENT: z.string().min(1).max(64).optional(),
  /** Rilis (tag image) untuk mengelompokkan galat per deploy. */
  SENTRY_RELEASE: z.string().min(1).max(200).optional(),
  /** Kunci HMAC token URL berkas privat (maksimal 10 menit, terikat berkas dan tujuan; PRD 5.4). */
  FILE_URL_SECRET: z.string().min(32),
  /** Proyek FCM untuk push (Firebase hanya untuk FCM, ARCHITECTURE §2.4). Tanpa nilai: push nonaktif di luar production. */
  FCM_PROJECT_ID: z.string().min(1).optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().min(2).optional(),
};

type Issue = { path: string; message: string };

const DELETION_LEDGER_REQUIRED = [
  "DELETION_LEDGER_S3_REGION",
  "DELETION_LEDGER_S3_BUCKET",
  "DELETION_LEDGER_S3_ACCESS_KEY_ID",
  "DELETION_LEDGER_S3_SECRET_ACCESS_KEY",
] as const;

/** true bila deletion ledger luar VPS dikonfigurasi (minimal bucket diisi). */
export function deletionLedgerConfigured(env: Partial<Record<string, unknown>>): boolean {
  return typeof env.DELETION_LEDGER_S3_BUCKET === "string" && env.DELETION_LEDGER_S3_BUCKET.length > 0;
}

/**
 * Deletion ledger luar VPS (AC F14-6, D5-07): bila salah satu variabel diisi, semuanya wajib lengkap; bucket tidak
 * boleh sama dengan bucket berkas pada endpoint yang sama (kehilangan atau penghapusan bucket berkas tidak boleh ikut
 * menghapus ledger).
 */
function deletionLedgerRules(env: z.infer<z.ZodObject<typeof baseShape>>): Issue[] {
  const issues: Issue[] = [];
  const any =
    DELETION_LEDGER_REQUIRED.some((key) => env[key] !== undefined) ||
    env.DELETION_LEDGER_S3_ENDPOINT !== undefined;
  if (!any) return issues;
  for (const key of DELETION_LEDGER_REQUIRED)
    if (!env[key]) issues.push({ path: key, message: "wajib bila deletion ledger luar VPS dikonfigurasi" });
  if (
    env.STORAGE_DRIVER === "s3" &&
    env.S3_BUCKET !== undefined &&
    env.S3_BUCKET === env.DELETION_LEDGER_S3_BUCKET &&
    (env.S3_ENDPOINT ?? "") === (env.DELETION_LEDGER_S3_ENDPOINT ?? "")
  )
    issues.push({
      path: "DELETION_LEDGER_S3_BUCKET",
      message: "wajib bucket terpisah dari bucket berkas S3_BUCKET (AC F14-6)",
    });
  return issues;
}

/** Aturan lintas field yang berlaku untuk API dan worker. */
function baseRules(env: z.infer<z.ZodObject<typeof baseShape>>): Issue[] {
  const issues: Issue[] = [];
  const production = env.NODE_ENV === "production";
  const deployed = production || env.NODE_ENV === "staging";
  if (production && !env.REDIS_URL)
    issues.push({
      path: "REDIS_URL",
      message: "wajib di production (rate limit lintas replica dan antrean)",
    });
  if (deployed && !env.SMTP_URL)
    issues.push({
      path: "SMTP_URL",
      message: "wajib di staging dan production; OTP tidak boleh hanya dicetak ke log",
    });
  if (env.STORAGE_DRIVER === "s3") {
    for (const key of ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const)
      if (!env[key]) issues.push({ path: key, message: "wajib bila STORAGE_DRIVER=s3" });
  } else if (env.STORAGE_FALLBACK_LOCAL_ROOT)
    issues.push({
      path: "STORAGE_FALLBACK_LOCAL_ROOT",
      message: "hanya berlaku bersama STORAGE_DRIVER=s3 (perpindahan storage, PRD 5.4)",
    });
  issues.push(...deletionLedgerRules(env));
  if (Boolean(env.FCM_PROJECT_ID) !== Boolean(env.FCM_SERVICE_ACCOUNT_JSON))
    issues.push({
      path: "FCM_SERVICE_ACCOUNT_JSON",
      message: "FCM_PROJECT_ID dan FCM_SERVICE_ACCOUNT_JSON diisi bersamaan",
    });
  if (production && !env.FCM_PROJECT_ID)
    issues.push({ path: "FCM_PROJECT_ID", message: "wajib di production (push notifikasi, F-13)" });
  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    try {
      parseFcmServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      issues.push({ path: "FCM_SERVICE_ACCOUNT_JSON", message: (e as Error).message });
    }
  }
  if (deployed && !env.API_PUBLIC_URL.startsWith("https://"))
    issues.push({ path: "API_PUBLIC_URL", message: "wajib https di staging dan production (N-07)" });
  if (deployed && env.FILE_URL_SECRET.includes(PLACEHOLDER))
    issues.push({ path: "FILE_URL_SECRET", message: "masih placeholder .env.example" });
  return issues;
}

// ---------------------------------------------------------------------------------------------------- skema API

const apiShape = {
  ...baseShape,
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Jumlah hop proxy tepercaya (Traefik) untuk req.ip. 0 = abaikan X-Forwarded-For. Bawaan 1 di staging/production,
   * 0 di development/test, sehingga klien tidak bisa memalsukan IP untuk lolos rate limit (PRD 2.5).
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  /** HSTS baru diaktifkan setelah seluruh subdomain yang dicakup siap HTTPS (N-07). */
  HSTS_ENABLED: z.stringbool().default(false),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default("https://api.kapdh.or.id"),
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
};

function apiRules(env: z.infer<z.ZodObject<typeof apiShape>>): Issue[] {
  const issues = baseRules(env);
  const production = env.NODE_ENV === "production";
  const deployed = production || env.NODE_ENV === "staging";
  try {
    const keys = parseSigningKeys(env.QR_SIGNING_KEYS);
    if (production && keys.some((k) => /^dev/i.test(k.keyId) || k.secret.includes(PLACEHOLDER)))
      issues.push({
        path: "QR_SIGNING_KEYS",
        message: "kunci development tidak boleh dipakai di production",
      });
  } catch (e) {
    issues.push({ path: "QR_SIGNING_KEYS", message: (e as Error).message });
  }
  if (deployed) {
    for (const key of ["JWT_ACCESS_SECRET", "OTP_HMAC_SECRET"] as const)
      if (env[key].includes(PLACEHOLDER))
        issues.push({ path: key, message: "masih placeholder .env.example" });
    if (/^0+$/.test(env.TOTP_ENC_KEY))
      issues.push({ path: "TOTP_ENC_KEY", message: "tidak boleh nol semua" });
  }
  if (production && env.BCRYPT_COST < 10)
    issues.push({ path: "BCRYPT_COST", message: "minimal 10 di production (PRD 2.5)" });
  return issues;
}

// ------------------------------------------------------------------------------------------------- skema worker

const workerShape = {
  ...baseShape,
  /** Jumlah job paralel per proses worker (BullMQ concurrency). */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * Port endpoint health worker `GET /healthz` (PRD 5.5). Kosong = 3001 (bawaan apps/worker); 0 = port acak dari OS
   * (uji). Endpoint tidak pernah dirutekan publik oleh Traefik.
   */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  /** Alamat bind endpoint health. Kosong = 0.0.0.0 (dapat dijangkau healthcheck container dan Uptime Kuma). */
  WORKER_HEALTH_HOST: z.string().min(1).max(255).optional(),
  /** Interval poll dispatcher outbox dalam ms. Kosong = 2000 (ARCHITECTURE §4.8). */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).optional(),
  /**
   * Batas waktu shutdown halus dalam ms: menunggu job yang sedang berjalan sebelum keluar. Kosong = 25000; set
   * stop_grace_period container lebih besar dari nilai ini.
   */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).optional(),
};

export const baseEnvSchema = z.object(baseShape).superRefine((env, ctx) => {
  for (const issue of baseRules(env))
    ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Env API setelah default turunan: TRUST_PROXY_HOPS selalu terisi. */
export type ApiEnv = Omit<z.infer<z.ZodObject<typeof apiShape>>, "TRUST_PROXY_HOPS"> & {
  TRUST_PROXY_HOPS: number;
};
export const apiEnvSchema = z
  .object(apiShape)
  .superRefine((env, ctx) => {
    for (const issue of apiRules(env))
      ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  })
  .transform((env): ApiEnv => ({
    ...env,
    TRUST_PROXY_HOPS:
      env.TRUST_PROXY_HOPS ?? (env.NODE_ENV === "production" || env.NODE_ENV === "staging" ? 1 : 0),
  }));

/**
 * Aturan khusus worker: job penghapusan akun berjalan di worker, sehingga deletion ledger luar VPS wajib di production
 * (AC F14-6, D5-07). Staging sebaiknya juga mengisinya agar gladi restore (PRD 8.2 langkah 7) setara production.
 */
function workerRules(env: z.infer<z.ZodObject<typeof workerShape>>): Issue[] {
  const issues = baseRules(env);
  if (env.NODE_ENV === "production" && !deletionLedgerConfigured(env))
    issues.push({
      path: "DELETION_LEDGER_S3_BUCKET",
      message: "wajib di production untuk worker (deletion ledger di luar VPS, AC F14-6)",
    });
  return issues;
}

export const workerEnvSchema = z.object(workerShape).superRefine((env, ctx) => {
  for (const issue of workerRules(env))
    ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Nama lama untuk env API (dipakai luas di apps/api). */
export type ServerEnv = ApiEnv;
export const serverEnvSchema = apiEnvSchema;

/** Galat konfigurasi; pesannya aman dicetak (hanya nama variabel dan aturan, tanpa nilai). */
export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Nilai kosong (`S3_ENDPOINT=` di .env atau variabel Coolify yang dikosongkan) diperlakukan sama dengan tidak diisi,
 * sehingga variabel opsional tidak gagal validasi format dan default tetap berlaku.
 */
function withoutEmptyValues(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && value.trim() !== "") result[key] = value;
  return result;
}

function parseOrThrow<T>(schema: z.ZodType<T>, source: Record<string, string | undefined>, label: string): T {
  const parsed = schema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    // Hanya path dan pesan aturan; nilai env (bisa berisi secret) tidak pernah dicetak.
    const fields = parsed.error.issues.map((i) => `${i.path.join(".") || "_"}: ${i.message}`).join("; ");
    throw new EnvValidationError(`Konfigurasi environment ${label} tidak valid: ${fields}`);
  }
  return parsed.data;
}

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseOrThrow(apiEnvSchema, source, "API");
}

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parseOrThrow(workerEnvSchema, source, "worker");
}

/** Alias {@link loadApiEnv} (nama lama). */
export const loadServerEnv = loadApiEnv;

/**
 * Memuat berkas `.env` lokal HANYA untuk development (README: `cp .env.example .env`). Variabel yang sudah ada di
 * process.env tidak ditimpa. Staging/production tidak pernah membaca berkas: secrets berasal dari Coolify (PRD 5.3).
 * Mengembalikan path yang dimuat, atau null.
 */
export function loadDevelopmentEnvFile(
  candidates: string[],
  source: Record<string, string | undefined> = process.env,
): string | null {
  const nodeEnv = source.NODE_ENV;
  if (nodeEnv !== undefined && nodeEnv !== "development") return null;
  for (const path of candidates) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return path;
    }
  }
  return null;
}
