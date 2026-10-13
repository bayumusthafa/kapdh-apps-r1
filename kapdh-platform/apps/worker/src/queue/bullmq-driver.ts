import { safeError } from "@kapdh/api/worker";
import { type Job, type JobsOptions, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import {
  type Processor,
  type QueueDriver,
  type QueueJob,
  type QueueName,
  type RegisterOptions,
  settledWithin,
} from "./queue-driver.js";

/** Bagian Queue BullMQ yang dipakai driver (memudahkan uji tanpa Redis). */
export interface BullQueueLike {
  add(name: string, data: unknown, opts: JobsOptions): Promise<unknown>;
  getJobState(jobId: string): Promise<string>;
  getJobCounts(...types: ("waiting" | "active" | "delayed" | "prioritized" | "paused")[]): Promise<{
    [index: string]: number;
  }>;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): Promise<void>;
}

/** Bagian Worker BullMQ yang dipakai driver. */
export interface BullWorkerLike {
  on(event: "failed", listener: (job: Job | undefined, error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "stalled", listener: (jobId: string) => void): unknown;
  close(force?: boolean): Promise<void>;
}

export interface BullFactories {
  queue(name: QueueName, options: { connection: Redis; prefix: string }): BullQueueLike;
  worker(
    name: QueueName,
    processor: (job: Job) => Promise<void>,
    options: { connection: Redis; prefix: string; concurrency: number },
  ): BullWorkerLike;
}

const defaultFactories: BullFactories = {
  queue: (name, options) => new Queue(name, options),
  worker: (name, processor, options) => new Worker(name, processor, { ...options, autorun: true }),
};

/** Status BullMQ yang berarti job masih akan/sedang dijalankan. */
const PENDING_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
/** Kelipatan konkurensi job menunggu yang diizinkan per antrean sebelum dispatcher berhenti mengklaim. */
const BACKLOG_FACTOR = 2;
const PING_TIMEOUT_MS = 2_000;

export interface BullMqDriverOptions {
  /**
   * Koneksi ioredis dengan `maxRetriesPerRequest: null` (syarat BullMQ untuk koneksi blocking). Worker BullMQ membuat
   * duplikat untuk koneksi blocking; koneksi ini ditutup pemanggil setelah {@link BullMqQueueDriver.close}.
   */
  connection: Redis;
  /** Prefix key Redis (namespace per lingkungan, PRD 5.3). */
  prefix: string;
  logger: Logger;
  factories?: BullFactories;
}

/**
 * Driver BullMQ (PRD 5.1: "Dispatcher meneruskan ke BullMQ dengan dedup key"): jobId = kunci dedup sehingga job yang
 * sama tidak pernah ada dua kali di antrean, retry eksponensial untuk galat yang dilempar processor, job selesai
 * disimpan sementara sebagai catatan dedup lalu dihapus. Redis bukan sumber kebenaran: data job hanya rujukan.
 */
export class BullMqQueueDriver implements QueueDriver {
  readonly kind = "bullmq" as const;
  private readonly factories: BullFactories;
  private readonly registrations = new Map<
    QueueName,
    RegisterOptions<unknown> & { processor: Processor<unknown> }
  >();
  private readonly queues = new Map<QueueName, BullQueueLike>();
  private readonly workers = new Map<QueueName, BullWorkerLike>();
  private accepting = false;

  constructor(private readonly options: BullMqDriverOptions) {
    this.factories = options.factories ?? defaultFactories;
  }

  register<T>(queue: QueueName, processor: Processor<T>, options: RegisterOptions<T>): void {
    if (this.registrations.has(queue)) throw new Error(`Processor antrean ${queue} sudah terdaftar`);
    this.registrations.set(queue, {
      ...(options as RegisterOptions<unknown>),
      processor: processor as Processor<unknown>,
    });
  }

  async start(): Promise<void> {
    const { connection, prefix } = this.options;
    for (const [name, registration] of this.registrations) {
      const logger = this.options.logger.child({ queue: name, driver: "bullmq" });
      const queue = this.factories.queue(name, { connection, prefix });
      queue.on("error", (error) => logger.error({ error: safeError(error) }, "galat antrean BullMQ"));
      this.queues.set(name, queue);
      const worker = this.factories.worker(
        name,
        async (job) => {
          const jobId = job.id ?? "tanpa-id";
          const attempt = job.attemptsMade + 1;
          const jobLogger = logger.child({ job_id: jobId, attempt });
          const started = performance.now();
          await registration.processor(job.data, { queue: name, jobId, attempt, logger: jobLogger });
          jobLogger.debug({ duration_ms: Math.round(performance.now() - started) }, "job antrean selesai");
        },
        { connection, prefix, concurrency: registration.concurrency },
      );
      worker.on("failed", (job, error) => {
        const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
        logger[final ? "error" : "warn"](
          { job_id: job?.id, attempt: job?.attemptsMade, error: safeError(error) },
          final ? "job antrean gagal setelah percobaan maksimum" : "job antrean gagal; dicoba ulang",
        );
      });
      worker.on("error", (error) => logger.error({ error: safeError(error) }, "galat worker BullMQ"));
      worker.on("stalled", (jobId) =>
        logger.warn({ job_id: jobId }, "job BullMQ macet (worker mati?); dijalankan ulang"),
      );
      this.workers.set(name, worker);
    }
    this.accepting = true;
  }

  async enqueue<T>(queue: QueueName, job: QueueJob<T>): Promise<boolean> {
    if (!this.accepting) throw new Error("Antrean BullMQ belum dimulai atau sudah ditutup");
    const target = this.queueFor(queue);
    // BullMQ mengabaikan add dengan jobId yang sudah ada; status diperiksa dulu agar pemanggil tahu hasil dedup.
    const state = await target.getJobState(job.jobId);
    if (state !== "unknown") return false;
    await target.add(queue, job.data, {
      jobId: job.jobId,
      attempts: Math.max(1, job.attempts),
      backoff: { type: "exponential", delay: job.backoffMs },
      removeOnComplete: { age: Math.ceil((job.retainMs ?? 3600_000) / 1000) },
      // Job gagal final disimpan seminggu untuk diagnosis (data hanya rujukan id, tanpa PII).
      removeOnFail: { age: 7 * 86_400, count: 5_000 },
    });
    return true;
  }

  async capacity(queue: QueueName): Promise<number> {
    if (!this.accepting) return 0;
    const registration = this.registrations.get(queue);
    const counts = await this.queueFor(queue).getJobCounts(
      "waiting",
      "active",
      "delayed",
      "prioritized",
      "paused",
    );
    const backlog = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return Math.max(0, (registration?.concurrency ?? 1) * BACKLOG_FACTOR - backlog);
  }

  async isPending(queue: QueueName, jobId: string): Promise<boolean> {
    return PENDING_STATES.has(await this.queueFor(queue).getJobState(jobId));
  }

  async ping(): Promise<boolean> {
    try {
      const pong = await Promise.race([
        this.options.connection.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), PING_TIMEOUT_MS).unref(),
        ),
      ]);
      return pong === "PONG";
    } catch {
      return false;
    }
  }

  async close(timeoutMs: number): Promise<boolean> {
    this.accepting = false;
    const workers = [...this.workers.values()];
    // Menunggu job aktif selesai; bila batas waktu habis, tutup paksa (job dipulihkan oleh stalled check / lease).
    const graceful = await settledWithin(Promise.all(workers.map((worker) => worker.close())), timeoutMs);
    if (!graceful) await Promise.allSettled(workers.map((worker) => worker.close(true)));
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    this.workers.clear();
    this.queues.clear();
    return graceful;
  }

  private queueFor(queue: QueueName): BullQueueLike {
    const found = this.queues.get(queue);
    if (!found) throw new Error(`Antrean ${queue} tidak memiliki processor`);
    return found;
  }
}
