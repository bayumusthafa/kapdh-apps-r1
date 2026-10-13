import {
  type Clock,
  createRootLogger,
  createWorkerContext,
  createWorkerDeps,
  safeError,
} from "@kapdh/api/worker";
import type { WorkerEnv } from "@kapdh/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { Redis } from "ioredis";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import postgres from "postgres";
import {
  buildHealthReport,
  createDbHealthProbes,
  type HealthProbes,
  type HealthReport,
} from "./health/health.js";
import { HealthServer } from "./health/health-server.js";
import { OutboxDispatcher, type OutboxJobs } from "./outbox/dispatcher.js";
import { BullMqQueueDriver } from "./queue/bullmq-driver.js";
import { InlineQueueDriver } from "./queue/inline-driver.js";
import { type QueueDriver, settledWithin } from "./queue/queue-driver.js";
import { connectLeaderLock, type LeaderLock } from "./scheduler/leader-lock.js";
import { type ScheduledJobRunner, type ScheduledJobSource, Scheduler } from "./scheduler/scheduler.js";
import { resolveWorkerSettings, type WorkerSettings } from "./settings.js";

/** Sumber daya yang ditutup saat shutdown (pool, koneksi, konteks Nest). */
export interface NamedResource {
  name: string;
  close(): Promise<void>;
}

/** Komponen runtime worker; {@link bootWorker} merakitnya dari env, uji memasang tiruan. */
export interface WorkerParts {
  settings: WorkerSettings;
  logger: Logger;
  clock: Clock;
  /** JobRunner dari `@kapdh/api/worker` (klaim/proses outbox dan job terjadwal). */
  jobs: OutboxJobs & ScheduledJobRunner;
  /** JobRegistry dari `@kapdh/api/worker`: job terjadwal dan topik outbox yang didaftarkan modul. */
  registry: ScheduledJobSource & { topics(): readonly string[] };
  queue: QueueDriver;
  leader: LeaderLock;
  probes: HealthProbes;
  /** Ditutup BERURUTAN sesuai urutan array setelah antrean berhenti dan kunci leader dilepas. */
  resources: NamedResource[];
}

export interface ShutdownResult {
  /** True bila semua job yang sedang berjalan selesai sebelum batas waktu shutdown. */
  graceful: boolean;
  reason: string;
}

type State = "created" | "running" | "stopping" | "stopped";

/**
 * Runtime worker (ARCHITECTURE §4.8, PRD 5.1, 5.5): dispatcher outbox (poll ~2 s, klaim lease, antrean dengan dedup
 * key), penjadwal job terdaftar dengan leader tunggal (kunci advisory PostgreSQL), endpoint health, dan shutdown halus:
 *   1. berhenti poll outbox dan tick penjadwal (tidak ada klaim/jadwal baru), health melaporkan `stopping`;
 *   2. menunggu job yang sedang berjalan sampai WORKER_SHUTDOWN_TIMEOUT_MS (job inline yang belum mulai dilepas
 *      klaimnya; job BullMQ yang belum mulai tetap di Redis untuk instance lain);
 *   3. melepas kunci leader (instance lain segera mengambil alih), lalu menutup koneksi, konteks Nest dan pool.
 * Event yang tidak selesai tidak pernah hilang: lease outbox habis lalu diklaim ulang (PRD 5.1).
 */
export class WorkerService {
  readonly dispatcher: OutboxDispatcher;
  readonly scheduler: Scheduler;
  private readonly healthServer: HealthServer;
  private state: State = "created";
  private startedAt: Date | null = null;
  private stopPromise: Promise<ShutdownResult> | null = null;

  constructor(private readonly parts: WorkerParts) {
    const { settings, logger, clock, jobs, registry, queue, leader } = parts;
    this.dispatcher = new OutboxDispatcher(
      { jobs, queue, clock, logger: logger.child({ component: "outbox-dispatcher" }) },
      { ...settings.outbox, concurrency: settings.concurrency },
    );
    this.scheduler = new Scheduler(
      { registry, jobs, queue, leader, clock, logger: logger.child({ component: "scheduler" }) },
      { ...settings.scheduler, concurrency: settings.scheduledConcurrency },
    );
    // Konsumen antrean didaftarkan sebelum queue.start() (syarat driver BullMQ).
    this.dispatcher.attach();
    this.scheduler.attach();
    this.healthServer = new HealthServer(() => this.health(), logger.child({ component: "health" }));
  }

  get running(): boolean {
    return this.state === "running";
  }

  /** Memulai antrean, dispatcher, penjadwal, lalu endpoint health. Gagal start → semua yang sudah jalan dihentikan. */
  async start(): Promise<AddressInfo> {
    if (this.state !== "created") throw new Error("Worker sudah dimulai");
    const { settings, logger, clock, queue, registry } = this.parts;
    this.state = "running";
    this.startedAt = clock.now();
    try {
      await queue.start();
      this.dispatcher.start();
      this.scheduler.start();
      const address = await this.healthServer.listen(settings.health.port, settings.health.host);
      logger.info(
        {
          queue_driver: queue.kind,
          concurrency: settings.concurrency,
          scheduled_concurrency: settings.scheduledConcurrency,
          poll_interval_ms: settings.outbox.pollIntervalMs,
          scheduled_jobs: registry.scheduledJobs().map((job) => job.name),
          topics: registry.topics(),
          health_port: address.port,
        },
        "worker berjalan",
      );
      return address;
    } catch (error) {
      logger.error(
        { error: safeError(error) },
        "worker gagal start; menghentikan komponen yang sudah berjalan",
      );
      await this.stop("start_failed");
      throw error;
    }
  }

  /** Alamat endpoint health (null sebelum start/sesudah stop). */
  healthAddress(): AddressInfo | null {
    return this.healthServer.address();
  }

  /** Laporan health saat ini (juga dilayani `GET /healthz`). */
  health(): Promise<HealthReport> {
    const { settings, clock, probes, queue, logger } = this.parts;
    return buildHealthReport({
      clock,
      startedAt: this.startedAt ?? clock.now(),
      stopping: this.state === "stopping" || this.state === "stopped",
      probes,
      queue,
      dispatcher: this.dispatcher.status(),
      scheduler: this.scheduler.status(),
      pollIntervalMs: settings.outbox.pollIntervalMs,
      tickMs: settings.scheduler.tickMs,
      outboxLagDegradedSeconds: settings.health.outboxLagDegradedSeconds,
      onProbeError: (probe, error) => logger.warn({ probe, error }, "pemeriksaan health gagal"),
    });
  }

  /** Shutdown halus; idempoten (panggilan berikutnya mengembalikan hasil yang sama). */
  stop(reason = "shutdown"): Promise<ShutdownResult> {
    this.stopPromise ??= this.shutdown(reason);
    return this.stopPromise;
  }

  private async shutdown(reason: string): Promise<ShutdownResult> {
    const { settings, logger, queue, resources } = this.parts;
    this.state = "stopping";
    logger.info(
      { reason, timeout_ms: settings.shutdownTimeoutMs },
      "worker berhenti: tidak menerima pekerjaan baru",
    );
    // Satu tenggat untuk seluruh penghentian (waktu operasional, bukan logika bisnis). Poll/tick yang menggantung
    // (mis. Redis hilang) tidak boleh menahan shutdown melewati batas waktunya.
    const deadline = performance.now() + settings.shutdownTimeoutMs;
    const loopsStopped = await settledWithin(
      Promise.all([this.dispatcher.stop(), this.scheduler.stop()]),
      settings.shutdownTimeoutMs,
    );
    if (!loopsStopped) logger.warn("poll outbox/tick penjadwal tidak selesai sebelum batas waktu shutdown");
    let graceful = false;
    try {
      graceful = await queue.close(Math.max(0, deadline - performance.now()));
    } catch (error) {
      logger.error({ error: safeError(error) }, "gagal menutup antrean");
    }
    graceful &&= loopsStopped;
    if (!graceful)
      logger.warn(
        { timeout_ms: settings.shutdownTimeoutMs },
        "batas waktu shutdown habis; job yang belum selesai dipulihkan lewat lease outbox / stalled check",
      );
    // Setelah job terjadwal selesai: lepas kunci agar instance lain segera menjadi leader.
    await this.scheduler.resign();
    for (const resource of resources) {
      try {
        await resource.close();
      } catch (error) {
        logger.warn({ resource: resource.name, error: safeError(error) }, "gagal menutup sumber daya");
      }
    }
    await this.healthServer.close();
    this.state = "stopped";
    logger.info({ reason, graceful }, "worker berhenti");
    return { graceful, reason };
  }
}

/**
 * Driver antrean dari env: BullMQ + ioredis bila REDIS_URL diisi (wajib di production; dedup jobId, retry, lintas
 * instance), atau inline dalam proses (development/uji tanpa Redis, ARCHITECTURE §1). Koneksi BullMQ terpisah dari klien
 * Redis core (rate limit) karena BullMQ mewajibkan `maxRetriesPerRequest: null` untuk koneksi blocking.
 */
export function createQueueDriver(
  env: Pick<WorkerEnv, "REDIS_URL">,
  settings: Pick<WorkerSettings, "queuePrefix">,
  logger: Logger,
): { driver: QueueDriver; resource: NamedResource | null } {
  if (!env.REDIS_URL)
    return { driver: new InlineQueueDriver(logger.child({ driver: "inline" })), resource: null };
  const connection = new Redis(env.REDIS_URL, {
    connectionName: "kapdh-worker-bullmq",
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  let errors = 0;
  connection.on("error", (error) => {
    errors++;
    // Redis putus: dibatasi agar log tidak banjir; health melaporkan queue_unreachable.
    if (errors === 1 || errors % 60 === 0)
      logger.error({ error: safeError(error), consecutive_errors: errors }, "koneksi Redis BullMQ galat");
  });
  connection.on("ready", () => {
    if (errors > 0) logger.info("koneksi Redis BullMQ pulih");
    errors = 0;
  });
  const driver = new BullMqQueueDriver({
    connection,
    prefix: settings.queuePrefix,
    logger: logger.child({ driver: "bullmq" }),
  });
  return {
    driver,
    resource: {
      name: "koneksi Redis BullMQ",
      close: async () => {
        // Koneksi lazy yang belum pernah tersambung cukup diputus (quit akan mencoba menyambung dulu).
        if (connection.status === "wait" || connection.status === "end") connection.disconnect();
        else await connection.quit().catch(() => connection.disconnect());
      },
    },
  };
}

export interface BootOptions {
  logger?: Logger;
  /** Modul Nest tambahan untuk konteks worker (uji). */
  extraModules?: NonNullable<Parameters<typeof createWorkerContext>[1]>["extraModules"];
}

/**
 * Merakit dan memulai worker production dari WorkerEnv tervalidasi (tanpa secret JWT/OTP/TOTP/QR, least privilege
 * PRD 5.1): adapter `createWorkerDeps`, konteks Nest `createWorkerContext` (hanya modul job), driver antrean, koneksi
 * kunci leader, dan koneksi health khusus. Bila salah satu langkah gagal, sumber daya yang sudah dibuat ditutup.
 */
export async function bootWorker(env: WorkerEnv, options: BootOptions = {}): Promise<WorkerService> {
  const settings = resolveWorkerSettings(env);
  const logger = options.logger ?? createRootLogger({ level: env.LOG_LEVEL, service: "kapdh-worker" });
  const created: NamedResource[] = [];
  try {
    const runtime = createWorkerDeps(env);
    created.push({ name: "adapter (pool PostgreSQL, Redis, SMTP, storage)", close: () => runtime.close() });
    const context = await createWorkerContext(runtime.deps, {
      logger,
      ...(options.extraModules ? { extraModules: options.extraModules } : {}),
    });
    created.push({ name: "konteks Nest worker", close: () => context.close() });
    const healthSql = postgres(env.DATABASE_URL, {
      max: 1,
      idle_timeout: 60,
      connect_timeout: 5,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: "kapdh-worker-health", statement_timeout: 2_000 },
    });
    created.push({ name: "koneksi health", close: () => healthSql.end({ timeout: 5 }) });
    const leader = connectLeaderLock(env.DATABASE_URL);
    created.push({ name: "koneksi kunci leader", close: () => leader.close() });
    const queue = createQueueDriver(env, settings, logger);
    if (queue.resource) created.push(queue.resource);

    const service = new WorkerService({
      settings,
      logger,
      clock: runtime.deps.clock,
      jobs: context.jobs,
      registry: context.registry,
      queue: queue.driver,
      leader,
      probes: createDbHealthProbes(drizzle(healthSql)),
      // Urutan tutup: kebalikan urutan pembuatan (Redis antrean → kunci leader → health → konteks Nest → pool).
      resources: [...created].reverse(),
    });
    created.length = 0; // Kepemilikan pindah ke WorkerService (start gagal → service.stop menutupnya).
    await service.start();
    return service;
  } catch (error) {
    for (const resource of created.reverse()) {
      try {
        await resource.close();
      } catch (closeError) {
        logger.warn({ resource: resource.name, error: safeError(closeError) }, "gagal menutup sumber daya");
      }
    }
    throw error;
  }
}
