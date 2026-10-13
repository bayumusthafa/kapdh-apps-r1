import "reflect-metadata";
import { type DynamicModule, type INestApplicationContext, Module, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { WorkerEnv } from "@kapdh/config";
import { createDb } from "@kapdh/database";
import { createStorageDriver, S3Driver } from "@kapdh/storage";
import type { Logger } from "pino";
import { WORKER_MODULES } from "./app.module.js";
import { systemClock } from "./core/adapters/clock.js";
import { DevLogMailer, type Mailer, SmtpMailer } from "./core/adapters/mailer.js";
import { createPushSender } from "./core/adapters/push.js";
import { createRedis } from "./core/adapters/redis.js";
import { type CoreDeps, CoreModule } from "./core/core.module.js";
import type { Db } from "./core/db/types.js";
import { JobRegistry } from "./core/jobs/job-registry.js";
import { JobRunner } from "./core/jobs/job-runner.js";
import { createRootLogger, NestPinoLogger } from "./core/logging/logger.js";

export type { JobContext, OutboxEvent, ScheduledJob, TopicHandler } from "./core/jobs/job-registry.js";
export { JobRegistry } from "./core/jobs/job-registry.js";
export { JobRunner } from "./core/jobs/job-runner.js";
export { safeError } from "./core/logging/safe-error.js";
export { createRootLogger };

/** Dependensi worker: sama dengan API tetapi env WorkerEnv (tanpa secret JWT/OTP/TOTP/QR). */
export type WorkerDeps = CoreDeps<WorkerEnv>;

export interface WorkerContext {
  app: INestApplicationContext;
  /** Eksekutor job terjadwal dan dispatcher outbox. */
  jobs: JobRunner;
  /** Job dan handler topik yang didaftarkan modul (onModuleInit). */
  registry: JobRegistry;
  logger: Logger;
  close(): Promise<void>;
}

@Module({})
class WorkerModule {
  static forRoot(deps: WorkerDeps, logger: Logger, extraModules: (Type | DynamicModule)[]): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot(deps, { mode: "worker", logger }), ...WORKER_MODULES, ...extraModules],
    };
  }
}

/**
 * Konteks Nest tanpa HTTP untuk apps/worker (ARCHITECTURE §1, §4.8), diimpor sebagai `@kapdh/api/worker`: hanya
 * modul job (`WORKER_MODULES`, `modules/<m>/<m>-jobs.module.ts`) dan CoreModule mode worker yang dimuat, sehingga
 * prosesor mendaftar ke JobRegistry; apps/worker menjadwalkan `jobs.runScheduled(name)` sesuai
 * `registry.scheduledJobs()` dan memanggil `jobs.dispatchOutbox()` setiap 2 detik (atau meneruskan ke BullMQ).
 *
 *   const env = loadWorkerEnv();
 *   const runtime = createWorkerDeps(env);
 *   const worker = await createWorkerContext(runtime.deps);
 *   // ... loop penjadwal ...
 *   await worker.close(); await runtime.close();
 *
 * Galat DI/inisialisasi (mis. provider job yang bergantung pada layanan khusus API) MENOLAK promise dengan pesan
 * UnknownDependenciesException, bukan process.abort().
 */
export async function createWorkerContext(
  deps: WorkerDeps,
  options: { logger?: Logger; extraModules?: (Type | DynamicModule)[] } = {},
): Promise<WorkerContext> {
  const logger = options.logger ?? createRootLogger({ level: deps.env.LOG_LEVEL, service: "kapdh-worker" });
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(deps, logger, options.extraModules ?? []),
    { logger: new NestPinoLogger(logger), abortOnError: false },
  );
  await app.init();
  return {
    app,
    jobs: app.get(JobRunner),
    registry: app.get(JobRegistry),
    logger,
    close: () => app.close(),
  };
}

export interface WorkerRuntime {
  deps: WorkerDeps;
  /** Menutup pool PostgreSQL, Redis, SMTP dan klien S3 (panggil SETELAH WorkerContext.close()). */
  close(): Promise<void>;
}

/**
 * Adapter production/development untuk worker dari WorkerEnv, sama dengan main.ts API (PRD 5.1, 5.4): pool
 * PostgreSQL (`application_name` kapdh-worker), Redis bila REDIS_URL diisi, SMTP (DevLogMailer hanya bila SMTP_URL
 * kosong di development; config mewajibkannya di luar development), FCM (nonaktif bila belum dikonfigurasi di luar
 * production), driver berkas dari STORAGE_DRIVER (path lokal relatif diselesaikan dari cwd), dan jam sistem.
 */
export function createWorkerDeps(env: WorkerEnv): WorkerRuntime {
  const { db, sql } = createDb(env.DATABASE_URL, {
    applicationName: "kapdh-worker",
    max: Math.max(2, env.WORKER_CONCURRENCY + 1),
  });
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL, "kapdh-worker") : null;
  const smtp = env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : null;
  const mailer: Mailer = smtp ?? new DevLogMailer();
  const storage = createStorageDriver(env);
  return {
    deps: {
      env,
      db: db as unknown as Db,
      mailer,
      clock: systemClock,
      push: createPushSender(env),
      redis,
      storage,
    },
    close: async () => {
      smtp?.close();
      if (storage instanceof S3Driver) storage.destroy();
      await redis?.quit().catch(() => undefined);
      await sql.end({ timeout: 5 });
    },
  };
}
