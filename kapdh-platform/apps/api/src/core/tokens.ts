/**
 * Token DI adapter eksternal (ARCHITECTURE §4.2). Nilainya berasal dari AppDeps sehingga uji memasang tiruan
 * (PGlite, TestClock, MemoryMailer, FakePush, MemoryStorage) tanpa mock.
 */

/** Database Drizzle (`Db`). */
export const DB = Symbol("DB");
/** Environment tervalidasi: `ApiEnv` di API, `WorkerEnv` di worker (packages/config). */
export const ENV = Symbol("ENV");
/** Sumber waktu (`Clock`); jangan memakai `new Date()` untuk logika bisnis (ARCHITECTURE §2.6). */
export const CLOCK = Symbol("CLOCK");
/** Pengirim email (`Mailer`). */
export const MAILER = Symbol("MAILER");
/** Driver penyimpanan berkas (`StorageDriver`, PRD 5.4). */
export const STORAGE = Symbol("STORAGE");
/** Pengirim push FCM (`PushSender`); nonaktif bila FCM belum dikonfigurasi di luar production. */
export const PUSH = Symbol("PUSH");
/** Klien Redis (ioredis) atau `null` bila REDIS_URL tidak diisi (dev/test memakai implementasi memori). */
export const REDIS = Symbol("REDIS");
/** Logger pino akar (JSON, redaksi, LOG_LEVEL; N-14). */
export const ROOT_LOGGER = Symbol("ROOT_LOGGER");
/** Penyimpanan rate limit (`RateLimitStore`): memori atau Redis. */
export const RATE_LIMIT_STORE = Symbol("RATE_LIMIT_STORE");
/** Mode runtime CoreModule: "api" (HTTP) atau "worker". */
export const RUNTIME_MODE = Symbol("RUNTIME_MODE");
