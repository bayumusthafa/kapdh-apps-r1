import "reflect-metadata";
import { EnvValidationError, loadApiEnv, loadDevelopmentEnvFile } from "@kapdh/config";
import { createStorageDriver, S3Driver } from "@kapdh/storage";
import { createDb } from "@kapdh/database";
import { resolve } from "node:path";
import { createApp } from "./bootstrap.js";
import { systemClock } from "./core/adapters/clock.js";
import { DevLogMailer, type Mailer, SmtpMailer } from "./core/adapters/mailer.js";
import { createPushSender } from "./core/adapters/push.js";
import { createRedis } from "./core/adapters/redis.js";
import type { Db } from "./core/db/types.js";
import { safeError } from "./core/logging/safe-error.js";

/**
 * Entry production/development API. Migrasi TIDAK dijalankan di sini (job deployment tunggal dengan lock, PRD 5.5).
 * Saat shutdown (SIGTERM dari orkestrator) Nest menutup HTTP lalu pool PostgreSQL, Redis, dan SMTP ditutup.
 */
async function main() {
  // Development: `cp .env.example .env` di kapdh-platform/ lalu `pnpm --filter @kapdh/api dev` (README).
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadApiEnv();
  if (!env.SMTP_URL && env.NODE_ENV !== "development")
    throw new EnvValidationError(
      "SMTP_URL wajib di luar development; OTP tidak boleh hanya dicetak ke log (N-14)",
    );
  const { db, sql } = createDb(env.DATABASE_URL, { applicationName: "kapdh-api" });
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL, "kapdh-api") : null;
  const smtp = env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : null;
  const mailer: Mailer = smtp ?? new DevLogMailer();
  // Storage berkas (PRD 5.4): path lokal relatif diselesaikan createStorageDriver dari folder kerja proses (sama
  // dengan worker/CLI); root di folder publik ditolak.
  const storage = createStorageDriver(env);
  const app = await createApp({
    env,
    db: db as unknown as Db,
    mailer,
    clock: systemClock,
    push: createPushSender(env),
    redis,
    storage,
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onClose", async () => {
      smtp?.close();
      if (storage instanceof S3Driver) storage.destroy();
      await redis?.quit().catch(() => undefined);
      await sql.end({ timeout: 5 });
    });
  app.enableShutdownHooks();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  // Galat konfigurasi aman dicetak (hanya nama variabel); galat lain hanya bentuk aman (N-14).
  const detail =
    error instanceof EnvValidationError ? { type: error.name, message: error.message } : safeError(error);
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", time: new Date().toISOString(), service: "kapdh-api", msg: "API gagal start", error: detail })}\n`,
  );
  process.exit(1);
});
