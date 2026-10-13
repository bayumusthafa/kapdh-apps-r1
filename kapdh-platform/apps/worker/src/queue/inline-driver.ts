import { safeError } from "@kapdh/api/worker";
import type { Logger } from "pino";
import {
  backoffDelay,
  type Processor,
  type QueueDriver,
  type QueueJob,
  type QueueName,
  type RegisterOptions,
  settledWithin,
} from "./queue-driver.js";

interface Entry {
  job: QueueJob<unknown>;
  attempt: number;
  retryTimer: NodeJS.Timeout | null;
}

/**
 * Antrean inline (tanpa Redis: development, uji, instance tunggal; ARCHITECTURE §1 "Redis-dependent code must have an
 * in-memory implementation"). Job dijalankan di proses ini dengan batas paralel per antrean, dedup jobId selama job
 * menunggu/berjalan/menunggu retry, dan retry backoff eksponensial. Tidak durable: job yang belum selesai saat proses
 * mati dipulihkan dari PostgreSQL (lease outbox habis lalu diklaim ulang; job terjadwal berjalan lagi di tick berikut).
 */
export class InlineQueueDriver implements QueueDriver {
  readonly kind = "inline" as const;
  private readonly queues = new Map<QueueName, InlineQueue>();
  private started = false;

  constructor(private readonly logger: Logger) {}

  register<T>(queue: QueueName, processor: Processor<T>, options: RegisterOptions<T>): void {
    if (this.queues.has(queue)) throw new Error(`Processor antrean ${queue} sudah terdaftar`);
    this.queues.set(
      queue,
      new InlineQueue(
        queue,
        processor as Processor<unknown>,
        options as RegisterOptions<unknown>,
        this.logger.child({ queue }),
      ),
    );
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async enqueue<T>(queue: QueueName, job: QueueJob<T>): Promise<boolean> {
    if (!this.started) throw new Error("Antrean inline belum dimulai atau sudah ditutup");
    return this.queueFor(queue).add(job as QueueJob<unknown>);
  }

  async capacity(queue: QueueName): Promise<number> {
    return this.started ? this.queueFor(queue).capacity() : 0;
  }

  async isPending(queue: QueueName, jobId: string): Promise<boolean> {
    return this.queueFor(queue).has(jobId);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /**
   * Selesai saat antrean tidak memiliki job menunggu, berjalan, maupun menunggu retry (uji dan diagnosis). Tidak
   * menunggu job yang ditambahkan setelah promise selesai.
   */
  async drained(queue?: QueueName): Promise<void> {
    const targets = queue ? [this.queueFor(queue)] : [...this.queues.values()];
    await Promise.all(targets.map((target) => target.drained()));
  }

  async close(timeoutMs: number): Promise<boolean> {
    this.started = false;
    const queues = [...this.queues.values()];
    await Promise.all(queues.map((queue) => queue.discardPending()));
    return settledWithin(Promise.all(queues.map((queue) => queue.idle())), timeoutMs);
  }

  private queueFor(queue: QueueName): InlineQueue {
    const found = this.queues.get(queue);
    if (!found) throw new Error(`Antrean ${queue} tidak memiliki processor`);
    return found;
  }
}

class InlineQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: Entry[] = [];
  private active = 0;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  private drainWaiters: (() => void)[] = [];

  constructor(
    private readonly name: QueueName,
    private readonly processor: Processor<unknown>,
    private readonly options: RegisterOptions<unknown>,
    private readonly logger: Logger,
  ) {}

  add(job: QueueJob<unknown>): boolean {
    if (this.closed) throw new Error(`Antrean ${this.name} sudah ditutup`);
    if (this.entries.has(job.jobId)) return false;
    const entry: Entry = { job, attempt: 1, retryTimer: null };
    this.entries.set(job.jobId, entry);
    this.waiting.push(entry);
    this.pump();
    return true;
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  /** Slot kosong: konkurensi dikurangi job berjalan, menunggu, dan menunggu retry. */
  capacity(): number {
    if (this.closed) return 0;
    return Math.max(0, this.options.concurrency - this.entries.size);
  }

  /** Membuang job yang belum berjalan dan retry yang tertunda (shutdown); processor `discard` dipanggil untuk masing-masing. */
  async discardPending(): Promise<void> {
    this.closed = true;
    const dropped: Entry[] = [];
    for (const entry of this.waiting.splice(0)) dropped.push(entry);
    for (const entry of this.entries.values()) {
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
        dropped.push(entry);
      }
    }
    for (const entry of dropped) {
      this.entries.delete(entry.job.jobId);
      if (!this.options.discard) continue;
      try {
        await this.options.discard(entry.job.data);
      } catch (error) {
        this.logger.warn({ job_id: entry.job.jobId, error: safeError(error) }, "job dibuang tanpa pelepasan");
      }
    }
    this.notifyIdle();
  }

  /** Selesai saat tidak ada job menunggu, berjalan, atau menunggu retry. */
  drained(): Promise<void> {
    if (this.entries.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Selesai saat tidak ada job yang berjalan. */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (!this.closed && this.active < this.options.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.active++;
      void this.run(entry);
    }
  }

  private async run(entry: Entry): Promise<void> {
    const { job } = entry;
    const logger = this.logger.child({ job_id: job.jobId, attempt: entry.attempt });
    const started = performance.now();
    try {
      await this.processor(job.data, { queue: this.name, jobId: job.jobId, attempt: entry.attempt, logger });
      this.entries.delete(job.jobId);
      logger.debug({ duration_ms: Math.round(performance.now() - started) }, "job antrean selesai");
    } catch (error) {
      const safe = safeError(error);
      if (entry.attempt < job.attempts && !this.closed) {
        const delay = backoffDelay(job.backoffMs, entry.attempt);
        entry.attempt++;
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null;
          if (this.closed) return;
          this.waiting.push(entry);
          this.pump();
        }, delay);
        entry.retryTimer.unref();
        logger.warn({ error: safe, retry_in_ms: delay }, "job antrean gagal; dicoba ulang");
      } else {
        this.entries.delete(job.jobId);
        logger.error({ error: safe }, "job antrean gagal setelah percobaan maksimum");
      }
    } finally {
      this.active--;
      this.pump();
      this.notifyIdle();
    }
  }

  private notifyIdle(): void {
    if (this.entries.size === 0) for (const resolve of this.drainWaiters.splice(0)) resolve();
    if (this.active !== 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
