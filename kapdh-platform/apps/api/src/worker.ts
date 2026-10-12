import "reflect-metadata";
import { type DynamicModule, type INestApplicationContext, Module, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { WorkerEnv } from "@kapdh/config";
import type { Logger } from "pino";
import { WORKER_MODULES } from "./app.module.js";
import { type CoreDeps, CoreModule } from "./core/core.module.js";
import { JobRegistry } from "./core/jobs/job-registry.js";
import { JobRunner } from "./core/jobs/job-runner.js";
import { createRootLogger, NestPinoLogger } from "./core/logging/logger.js";

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
 * Konteks Nest tanpa HTTP untuk apps/worker (ARCHITECTURE §1, §4.8): modul pemilik job dimuat sehingga prosesor
 * mendaftar ke JobRegistry; apps/worker menjadwalkan `jobs.runScheduled(name)` dan memanggil
 * `jobs.dispatchOutbox()` setiap 2 detik (atau meneruskan ke BullMQ).
 */
export async function createWorkerContext(
  deps: WorkerDeps,
  options: { logger?: Logger; extraModules?: (Type | DynamicModule)[] } = {},
): Promise<WorkerContext> {
  const logger = options.logger ?? createRootLogger({ level: deps.env.LOG_LEVEL, service: "kapdh-worker" });
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(deps, logger, options.extraModules ?? []),
    { logger: new NestPinoLogger(logger) },
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
