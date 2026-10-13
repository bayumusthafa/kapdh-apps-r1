import { safeError } from "@kapdh/api/worker";
import { type Job, type JobsOptions, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import {
  type Processor,
  type QueueDriver,
  type QueueJob,
  type QueueName,
  QueueUnavailableError,
  type RegisterOptions,
  settledWithin,
  withinTimeout,
} from "./queue-driver.js";

/** Bagian Queue BullMQ yang dipakai driver (memudahkan uji tanpa Redis). */
export interface BullQueueLike {
  add(name: string, data: unknown, opts: JobsOptions): Promise<unknown>;
  getJobState(jobId: string): Promise<string>;
  getJobCounts(...types: ("waiting" | "active" | "delayed" | "prioritized" | "paused")[]): Promise<{
    [index: string]: number;
  }>;
  /** Selesai saat klien BullMQ terinisialisasi; menolak (permanen) bila inisialisasinya gagal. */
  waitUntilReady(): Promise<unknown>;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): Promise<void>;
}

/** Bagian Worker BullMQ yang dipakai driver. */
export interface BullWorkerLike {
  on(event: "failed", listener: (job: Job | undefined, error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "stalled", listener: (jobId: string) => void): unknown;
  /** Selesai saat koneksi utama dan koneksi blocking terinisialisasi. */
  waitUntilReady(): Promise<unknown>;
  /** Loop konsumen; selesai saat worker ditutup, menolak bila loop berhenti karena galat. */
  run(): Promise<unknown>;
  close(force?: boolean): Promise<void>;
}

export interface BullFactories {
  queue(name: QueueName, options: { connection: Redis; prefix: string }): BullQueueLike;
  /** Worker dibuat TANPA autorun: driver menjalankannya setelah semua klien terbukti siap. */
  worker(
    name: QueueName,
    processor: (job: Job) => Promise<void>,
    options: { connection: Redis; prefix: string; concurrency: number },
  ): BullWorkerLike;
}

const defaultFactories: BullFactories = {
  queue: (name, options) => new Queue(name, options),
  worker: (name, processor, options) => new Worker(name, processor, { ...options, autorun: false }),
};

/** Status BullMQ yang berarti job masih akan/sedang dijalankan. */
const PENDING_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
/** Kelipatan konkurensi job menunggu yang diizinkan per antrean sebelum dispatcher berhenti mengklaim. */
const BACKLOG_FACTOR = 2;
const PING_TIMEOUT_MS = 2_000;

export interface BullMqDriverOptions {
  /**
   * Koneksi konsumen (Worker BullMQ) dengan `maxRetriesPerRequest: null` (syarat BullMQ untuk koneksi blocking):
   * perintah menunggu Redis tersambung ulang alih-alih gagal. Worker BullMQ membuat duplikat untuk koneksi blocking.
   */
  connection: Redis;
  /**
   * Koneksi produsen (Queue: add, status job, hitungan slot) yang GAGAL CEPAT saat Redis putus
   * (`enableOfflineQueue: false`, tanpa pengiriman ulang), sehingga poll outbox melepas klaimnya dan tick penjadwal
   * mencoba lagi, bukan menggantung sampai Redis kembali.
   */
  producerConnection: Redis;
  /** Prefix key Redis (namespace per lingkungan, PRD 5.3). */
  prefix: string;
  logger: Logger;
  /** Batas tunggu Redis siap dan klien BullMQ terinisialisasi saat {@link BullMqQueueDriver.start}. */
  readyTimeoutMs: number;
  /** Batas waktu setiap operasi produsen (enqueue, capacity, isPending). */
  operationTimeoutMs: number;
  factories?: BullFactories;
}

type DriverState = "created" | "running" | "closed";

/**
 * Driver BullMQ (PRD 5.1: "Dispatcher meneruskan ke BullMQ dengan dedup key"): jobId = kunci dedup sehingga job yang
 * sama tidak pernah ada dua kali di antrean, retry eksponensial untuk galat yang dilempar processor, job selesai
 * disimpan sementara sebagai catatan dedup lalu dihapus. Redis bukan sumber kebenaran: data job hanya rujukan.
 *
 * Ketahanan Redis (PRD 5.1 "Jika Redis/job hilang … outbox tetap dapat diproses ulang", PRD 5.5):
 *   - start menunggu kedua koneksi siap dan SEMUA klien BullMQ terinisialisasi (BullMQ menyimpan hasil inisialisasi
 *     pertama selamanya; klien yang dibuat saat Redis mati tidak pernah pulih). Lewat `readyTimeoutMs` start gagal →
 *     proses keluar non-zero → orkestrator menjalankannya ulang. Setelah siap, ioredis menyambung ulang sendiri;
 *   - operasi produsen memakai koneksi gagal-cepat + batas waktu per operasi, tidak pernah menggantung;
 *   - `ping()` (health) memeriksa Redis menjawab, koneksi konsumen tersambung, klien BullMQ terinisialisasi, dan loop
 *     konsumen masih berjalan.
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
  /** Antrean yang loop konsumennya berhenti di luar shutdown (health melaporkan antrean tidak sehat). */
  private readonly stoppedConsumers = new Set<QueueName>();
  private state: DriverState = "created";

  constructor(private readonly options: BullMqDriverOptions) {
    this.factories = options.factories ?? defaultFactories;
  }

  register<T>(queue: QueueName, processor: Processor<T>, options: RegisterOptions<T>): void {
    if (this.state !== "created") throw new Error("Processor harus didaftarkan sebelum antrean dimulai");
    if (this.registrations.has(queue)) throw new Error(`Processor antrean ${queue} sudah terdaftar`);
    this.registrations.set(queue, {
      ...(options as RegisterOptions<unknown>),
      processor: processor as Processor<unknown>,
    });
  }

  async start(): Promise<void> {
    if (this.state !== "created") throw new Error("Antrean BullMQ sudah dimulai atau sudah ditutup");
    const { connection, producerConnection, readyTimeoutMs } = this.options;
    const deadline = performance.now() + readyTimeoutMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    try {
      await Promise.all([
        waitForRedis(connection, remaining(), "koneksi konsumen"),
        waitForRedis(producerConnection, remaining(), "koneksi produsen"),
      ]);
      for (const [name, registration] of this.registrations) this.createClients(name, registration);
      // Termasuk koneksi blocking duplikat milik setiap Worker. Inisialisasi yang gagal tidak pernah dicoba ulang
      // BullMQ, jadi start gagal di sini daripada berjalan dengan antrean yang rusak permanen.
      await withinTimeout(
        Promise.all([...this.queues.values(), ...this.workers.values()].map((client) => client.waitUntilReady())),
        remaining(),
        "inisialisasi klien BullMQ",
      );
    } catch (error) {
      // Belum ada job yang diproses (loop konsumen belum dijalankan): klien ditutup paksa.
      await this.teardown(0, true);
      this.state = "closed";
      this.options.logger.error(
        { error: safeError(error), ready_timeout_ms: readyTimeoutMs },
        "Redis BullMQ tidak siap saat start; worker berhenti agar dijalankan ulang",
      );
      throw error instanceof QueueUnavailableError
        ? error
        : new QueueUnavailableError("Klien BullMQ gagal diinisialisasi", { cause: error });
    }
    this.state = "running";
    for (const [name, worker] of this.workers) {
      worker.run().then(
        () => this.consumerStopped(name, null),
        (error: unknown) => this.consumerStopped(name, error),
      );
    }
  }

  async enqueue<T>(queue: QueueName, job: QueueJob<T>): Promise<boolean> {
    if (this.state !== "running") throw new Error("Antrean BullMQ belum dimulai atau sudah ditutup");
    const target = this.queueFor(queue);
    return withinTimeout(
      (async () => {
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
      })(),
      this.options.operationTimeoutMs,
      `enqueue antrean ${queue}`,
    );
  }

  async capacity(queue: QueueName): Promise<number> {
    if (this.state !== "running") return 0;
    const registration = this.registrations.get(queue);
    const counts = await withinTimeout(
      this.queueFor(queue).getJobCounts("waiting", "active", "delayed", "prioritized", "paused"),
      this.options.operationTimeoutMs,
      `slot antrean ${queue}`,
    );
    const backlog = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return Math.max(0, (registration?.concurrency ?? 1) * BACKLOG_FACTOR - backlog);
  }

  async isPending(queue: QueueName, jobId: string): Promise<boolean> {
    const state = await withinTimeout(
      this.queueFor(queue).getJobState(jobId),
      this.options.operationTimeoutMs,
      `status job antrean ${queue}`,
    );
    return PENDING_STATES.has(state);
  }

  async ping(): Promise<boolean> {
    if (this.state !== "running" || this.stoppedConsumers.size > 0) return false;
    if (this.options.connection.status !== "ready") return false;
    try {
      const [pong] = await withinTimeout(
        Promise.all([
          this.options.producerConnection.ping(),
          // Promise inisialisasi yang ditolak = klien BullMQ rusak permanen (tidak pernah pulih tanpa restart).
          ...[...this.queues.values(), ...this.workers.values()].map((client) => client.waitUntilReady()),
        ]),
        PING_TIMEOUT_MS,
        "ping Redis",
      );
      return pong === "PONG";
    } catch {
      return false;
    }
  }

  async close(timeoutMs: number): Promise<boolean> {
    this.state = "closed";
    return this.teardown(timeoutMs);
  }

  /** Menutup worker (menunggu job aktif sampai batas waktu, lalu paksa; `force` = langsung paksa) dan queue. */
  private async teardown(timeoutMs: number, force = false): Promise<boolean> {
    const workers = [...this.workers.values()];
    // Menunggu job aktif selesai; bila batas waktu habis, tutup paksa (job dipulihkan oleh stalled check / lease).
    const graceful =
      !force && (await settledWithin(Promise.all(workers.map((worker) => worker.close())), timeoutMs));
    if (!graceful) await Promise.allSettled(workers.map((worker) => worker.close(true)));
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    this.workers.clear();
    this.queues.clear();
    return graceful;
  }

  private createClients(
    name: QueueName,
    registration: RegisterOptions<unknown> & { processor: Processor<unknown> },
  ): void {
    const { connection, producerConnection, prefix } = this.options;
    const logger = this.options.logger.child({ queue: name, driver: "bullmq" });
    const correlate = (data: unknown, queueJobId: string): string => {
      try {
        return registration.correlate?.(data) ?? queueJobId;
      } catch {
        return queueJobId;
      }
    };
    const queue = this.factories.queue(name, { connection: producerConnection, prefix });
    queue.on("error", (error) => logger.error({ error: safeError(error) }, "galat antrean BullMQ"));
    this.queues.set(name, queue);
    const worker = this.factories.worker(
      name,
      async (job) => {
        const queueJobId = job.id ?? "tanpa-id";
        const attempt = job.attemptsMade + 1;
        const jobLogger = logger.child({
          job_id: correlate(job.data, queueJobId),
          queue_job_id: queueJobId,
          attempt,
        });
        const started = performance.now();
        await registration.processor(job.data, { queue: name, jobId: queueJobId, attempt, logger: jobLogger });
        jobLogger.debug({ duration_ms: Math.round(performance.now() - started) }, "job antrean selesai");
      },
      { connection, prefix, concurrency: registration.concurrency },
    );
    worker.on("failed", (job, error) => {
      const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
      logger[final ? "error" : "warn"](
        {
          job_id: job ? correlate(job.data, job.id ?? "tanpa-id") : undefined,
          queue_job_id: job?.id,
          attempt: job?.attemptsMade,
          error: safeError(error),
        },
        final ? "job antrean gagal setelah percobaan maksimum" : "job antrean gagal; dicoba ulang",
      );
    });
    worker.on("error", (error) => logger.error({ error: safeError(error) }, "galat worker BullMQ"));
    worker.on("stalled", (jobId) =>
      logger.warn({ queue_job_id: jobId }, "job BullMQ macet (worker mati?); dijalankan ulang"),
    );
    this.workers.set(name, worker);
  }

  private consumerStopped(name: QueueName, error: unknown): void {
    if (this.state !== "running") return;
    this.stoppedConsumers.add(name);
    this.options.logger.error(
      { queue: name, ...(error ? { error: safeError(error) } : {}) },
      "loop konsumen BullMQ berhenti di luar shutdown; health melaporkan antrean tidak sehat",
    );
  }

  private queueFor(queue: QueueName): BullQueueLike {
    const found = this.queues.get(queue);
    if (!found) throw new Error(`Antrean ${queue} tidak memiliki processor`);
    return found;
  }
}

/**
 * Menunggu koneksi ioredis `ready` sampai batas waktu. Koneksi lazy disambungkan; kegagalan sambung pertama tidak
 * menghentikan apa pun karena ioredis terus mencoba ulang (retryStrategy), sehingga Redis yang menyala selama masa
 * tunggu tetap terpakai.
 */
export async function waitForRedis(connection: Redis, timeoutMs: number, what: string): Promise<void> {
  if (connection.status === "ready") return;
  if (connection.status === "end") throw new QueueUnavailableError(`${what} Redis sudah ditutup`);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      connection.off("ready", onReady);
      connection.off("end", onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new QueueUnavailableError(`${what} Redis berakhir sebelum siap`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new QueueUnavailableError(`${what} Redis tidak siap dalam ${timeoutMs} ms`));
    }, timeoutMs);
    connection.on("ready", onReady);
    connection.on("end", onEnd);
    if (connection.status === "wait") connection.connect().catch(() => undefined);
  });
}
