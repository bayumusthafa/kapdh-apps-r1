import type { Job, JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import {
  type BullFactories,
  BullMqQueueDriver,
  type BullQueueLike,
  type BullWorkerLike,
} from "../src/queue/bullmq-driver.js";
import { QueueUnavailableError } from "../src/queue/queue-driver.js";
import { createQueueDriver } from "../src/runtime.js";
import { eventually, memoryLogger } from "./support/fixtures.js";

/**
 * BullMQ tiruan di memori (tanpa Redis): cukup untuk membuktikan adapter meneruskan jobId dedup, opsi retry, data
 * rujukan, backpressure, dan urutan close. Perilaku BullMQ sendiri (Lua/Redis) tidak diuji di sini.
 */
class FakeBull {
  readonly added: { name: string; data: unknown; opts: JobsOptions }[] = [];
  readonly states = new Map<string, string>();
  readonly counts: Record<string, number> = { waiting: 0, active: 0, delayed: 0, prioritized: 0, paused: 0 };
  readonly processors = new Map<string, (job: Job) => Promise<void>>();
  readonly workerOptions: { name: string; concurrency: number; prefix: string }[] = [];
  readonly closed: string[] = [];
  readonly errorListeners: ((error: Error) => void)[] = [];
  readonly failedListeners: ((job: Job | undefined, error: Error) => void)[] = [];
  workerCloseDelayMs = 0;
  /** Inisialisasi klien Worker gagal (mis. Redis putus tepat saat koneksi blocking dibuat). */
  workerInitError: Error | null = null;
  /** Loop konsumen: diselesaikan uji untuk mensimulasikan loop yang berhenti karena galat. */
  private readonly runs = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  readonly started: string[] = [];

  factories(): BullFactories {
    return {
      queue: (name, options): BullQueueLike => ({
        add: async (jobName, data, opts) => {
          this.added.push({ name: jobName, data, opts });
          this.states.set(opts.jobId!, "waiting");
          return {};
        },
        getJobState: async (jobId) => this.states.get(jobId) ?? "unknown",
        getJobCounts: async () => ({ ...this.counts }),
        waitUntilReady: async () => undefined,
        on: (_event, listener) => this.errorListeners.push(listener),
        close: async () => void this.closed.push(`queue:${name}:${options.prefix}`),
      }),
      worker: (name, processor, options): BullWorkerLike => {
        this.processors.set(name, processor);
        this.workerOptions.push({ name, concurrency: options.concurrency, prefix: options.prefix });
        const init = this.workerInitError ? Promise.reject(this.workerInitError) : Promise.resolve();
        init.catch(() => undefined);
        return {
          on: (event: string, listener: (...args: never[]) => void) => {
            if (event === "failed") this.failedListeners.push(listener as never);
          },
          waitUntilReady: () => init,
          run: () => {
            this.started.push(name);
            return new Promise<void>((resolve, reject) => this.runs.set(name, { resolve, reject }));
          },
          close: async (force?: boolean) => {
            if (!force && this.workerCloseDelayMs > 0)
              await new Promise((resolve) => setTimeout(resolve, this.workerCloseDelayMs));
            this.closed.push(`worker:${name}${force ? ":force" : ""}`);
            this.runs.get(name)?.resolve();
          },
        } as BullWorkerLike;
      },
    };
  }

  async run(queue: string, id: string, data: unknown, attemptsMade = 0): Promise<void> {
    const processor = this.processors.get(queue)!;
    await processor({ id, data, attemptsMade, opts: {} } as unknown as Job);
  }

  /** Loop konsumen berhenti karena galat di luar shutdown. */
  crashConsumer(queue: string, error: Error): void {
    this.runs.get(queue)?.reject(error);
  }
}

/** Koneksi ioredis tiruan yang sudah `ready` (driver tidak perlu menyambung). */
const fakeConnection = (pong: () => Promise<string> = async () => "PONG") =>
  ({ ping: pong, status: "ready", on: () => undefined, off: () => undefined }) as unknown as Redis;

function fakeDriver(bull: FakeBull, logger = memoryLogger().logger, pong?: () => Promise<string>) {
  return new BullMqQueueDriver({
    connection: fakeConnection(),
    producerConnection: fakeConnection(pong),
    prefix: "kapdh:test:bull",
    logger,
    readyTimeoutMs: 1_000,
    operationTimeoutMs: 200,
    factories: bull.factories(),
  });
}

describe("Driver BullMQ (PRD 5.1: dispatcher meneruskan ke BullMQ dengan dedup key)", () => {
  it("PRD 5.1: enqueue memakai jobId = kunci dedup, retry eksponensial, dan retensi; data hanya rujukan", async () => {
    const bull = new FakeBull();
    const driver = fakeDriver(bull);
    driver.register("outbox", async () => undefined, { concurrency: 3 });
    driver.register("scheduled", async () => undefined, { concurrency: 2 });
    await driver.start();
    expect(bull.workerOptions).toEqual([
      { name: "outbox", concurrency: 3, prefix: "kapdh:test:bull" },
      { name: "scheduled", concurrency: 2, prefix: "kapdh:test:bull" },
    ]);
    // Worker dibuat tanpa autorun dan baru dijalankan setelah semua klien siap.
    expect(bull.started).toEqual(["outbox", "scheduled"]);

    const job = {
      jobId: "outbox.notification.created%3Ax.1760320800000",
      data: { outbox_id: "0190", lease: "2026-10-13T02:05:00.000Z" },
      attempts: 3,
      backoffMs: 1_000,
    };
    expect(await driver.enqueue("outbox", job)).toBe(true);
    expect(bull.added).toHaveLength(1);
    expect(bull.added[0]).toMatchObject({
      name: "outbox",
      data: job.data,
      opts: {
        jobId: job.jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 3_600 },
      },
    });
    // Dedup: job yang sama tidak ditambahkan lagi selama masih ada di Redis.
    expect(await driver.enqueue("outbox", job)).toBe(false);
    expect(bull.added).toHaveLength(1);
    expect(await driver.isPending("outbox", job.jobId)).toBe(true);
    bull.states.set(job.jobId, "completed");
    expect(await driver.isPending("outbox", job.jobId)).toBe(false);

    // Retensi catatan slot jadwal (dedup lintas leader) mengikuti retainMs.
    await driver.enqueue("scheduled", {
      jobId: "scheduled.events.reminders.1760320800000",
      data: { name: "events.reminders", slot: "2026-10-13T02:00:00.000Z", job_id: "events.reminders:x" },
      attempts: 3,
      backoffMs: 5_000,
      retainMs: 1_800_000,
    });
    expect(bull.added[1]!.opts.removeOnComplete).toEqual({ age: 1_800 });
    await driver.close(1_000);
  });

  it("PRD 5.1: slot kosong = 2 × konkurensi dikurangi backlog antrean (waiting/active/delayed)", async () => {
    const bull = new FakeBull();
    const driver = fakeDriver(bull);
    driver.register("outbox", async () => undefined, { concurrency: 4 });
    expect(await driver.capacity("outbox")).toBe(0); // belum start
    await driver.start();
    expect(await driver.capacity("outbox")).toBe(8);
    Object.assign(bull.counts, { waiting: 3, active: 4, delayed: 2 });
    expect(await driver.capacity("outbox")).toBe(0);
    Object.assign(bull.counts, { waiting: 1, active: 2, delayed: 0 });
    expect(await driver.capacity("outbox")).toBe(5);
    await driver.close(1_000);
  });

  it("N-14: log antrean memakai job_id korelasi (sama dengan JobRunner/audit) + queue_job_id + attempt; galat dilempar agar BullMQ mencoba ulang", async () => {
    const bull = new FakeBull();
    const { logger, lines } = memoryLogger();
    const seen: { jobId: string; attempt: number }[] = [];
    const driver = fakeDriver(bull, logger);
    driver.register<{ n: number; outbox_id: string }>(
      "outbox",
      async (data, meta) => {
        seen.push({ jobId: meta.jobId, attempt: meta.attempt });
        meta.logger.info({ n: data.n, token: "jangan-dicatat" }, "memproses");
        if (data.n === 2) throw new Error("gagal sementara");
      },
      { concurrency: 1, correlate: (data) => `outbox:${data.outbox_id}` },
    );
    await driver.start();
    await bull.run("outbox", "outbox.a", { n: 1, outbox_id: "e1" });
    await expect(bull.run("outbox", "outbox.b", { n: 2, outbox_id: "e2" }, 1)).rejects.toThrow(
      "gagal sementara",
    );
    expect(seen).toEqual([
      { jobId: "outbox.a", attempt: 1 },
      { jobId: "outbox.b", attempt: 2 },
    ]);
    const processing = lines.filter((line) => line.msg === "memproses");
    expect(processing[0]).toMatchObject({
      queue: "outbox",
      driver: "bullmq",
      job_id: "outbox:e1",
      queue_job_id: "outbox.a",
      attempt: 1,
    });
    // Redaksi logger root: kunci rahasia disensor.
    expect(processing[0]!.token).toBe("[REDACTED]");
    // Kegagalan final job antrean memakai job_id yang sama dengan log JobRunner.
    bull.failedListeners[0]!(
      {
        id: "outbox.b",
        data: { n: 2, outbox_id: "e2" },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as unknown as Job,
      new Error("gagal sementara"),
    );
    expect(lines.find((line) => line.msg === "job antrean gagal setelah percobaan maksimum")).toMatchObject({
      level: "error",
      job_id: "outbox:e2",
      queue_job_id: "outbox.b",
    });
    // Galat antrean dari koneksi Redis dicatat lewat logger (bukan crash).
    bull.errorListeners[0]!(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(lines.find((line) => line.msg === "galat antrean BullMQ")).toMatchObject({ level: "error" });
    await driver.close(1_000);
  });

  it("close() menunggu job aktif sampai batas waktu, lalu menutup paksa; enqueue setelah close ditolak", async () => {
    const bull = new FakeBull();
    bull.workerCloseDelayMs = 300;
    const driver = fakeDriver(bull);
    driver.register("outbox", async () => undefined, { concurrency: 1 });
    await driver.start();
    expect(await driver.close(50)).toBe(false);
    expect(bull.closed).toContain("worker:outbox:force");
    expect(bull.closed).toContain("queue:outbox:kapdh:test:bull");
    await expect(
      driver.enqueue("outbox", { jobId: "outbox.z", data: {}, attempts: 1, backoffMs: 1 }),
    ).rejects.toThrow(/ditutup/);

    const graceful = new FakeBull();
    const second = fakeDriver(graceful);
    second.register("outbox", async () => undefined, { concurrency: 1 });
    await second.start();
    expect(await second.close(1_000)).toBe(true);
    expect(graceful.closed).toEqual(["worker:outbox", "queue:outbox:kapdh:test:bull"]);
  });

  it("PRD 5.1: inisialisasi klien BullMQ gagal saat start → start ditolak (QueueUnavailableError) dan klien ditutup paksa, bukan berjalan dengan antrean rusak permanen", async () => {
    const bull = new FakeBull();
    bull.workerInitError = new Error("Connection is closed.");
    const { logger, lines } = memoryLogger();
    const driver = fakeDriver(bull, logger);
    driver.register("outbox", async () => undefined, { concurrency: 1 });
    await expect(driver.start()).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(bull.started).toEqual([]);
    expect(bull.closed).toEqual(
      expect.arrayContaining(["worker:outbox:force", "queue:outbox:kapdh:test:bull"]),
    );
    expect(await driver.ping()).toBe(false);
    expect(lines.some((line) => String(line.msg).startsWith("Redis BullMQ tidak siap saat start"))).toBe(
      true,
    );
  });

  it("PRD 5.5: ping() (health) false bila Redis tidak menjawab, klien BullMQ belum/tidak siap, atau loop konsumen berhenti di luar shutdown", async () => {
    const ok = new FakeBull();
    const healthy = fakeDriver(ok);
    healthy.register("outbox", async () => undefined, { concurrency: 1 });
    expect(await healthy.ping()).toBe(false); // belum start
    await healthy.start();
    expect(await healthy.ping()).toBe(true);
    await healthy.close(1_000);
    expect(await healthy.ping()).toBe(false);

    const down = fakeDriver(new FakeBull(), memoryLogger().logger, async () => {
      throw new Error("Stream not writeable and enableOfflineQueue options is false");
    });
    down.register("outbox", async () => undefined, { concurrency: 1 });
    await down.start();
    expect(await down.ping()).toBe(false);
    await down.close(1_000);

    const crashing = new FakeBull();
    const { logger, lines } = memoryLogger();
    const consumer = fakeDriver(crashing, logger);
    consumer.register("outbox", async () => undefined, { concurrency: 1 });
    await consumer.start();
    expect(await consumer.ping()).toBe(true);
    crashing.crashConsumer("outbox", Object.assign(new Error("NOSCRIPT"), { code: "NOSCRIPT" }));
    await eventually(async () => !(await consumer.ping()));
    expect(
      lines.find((line) => String(line.msg).startsWith("loop konsumen BullMQ berhenti di luar shutdown")),
    ).toMatchObject({ level: "error", queue: "outbox", error: { error_code: "NOSCRIPT" } });
    await consumer.close(1_000);
  });

  it("PRD 5.1: operasi produsen yang menggantung ditolak setelah batas waktu operasi (QueueUnavailableError)", async () => {
    const bull = new FakeBull();
    const driver = fakeDriver(bull);
    driver.register("outbox", async () => undefined, { concurrency: 1 });
    await driver.start();
    const hanging = new Promise<never>(() => undefined);
    const queue = (driver as unknown as { queues: Map<string, BullQueueLike> }).queues.get("outbox")!;
    queue.getJobCounts = () => hanging;
    queue.getJobState = () => hanging;
    const started = performance.now();
    await expect(driver.capacity("outbox")).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(
      driver.enqueue("outbox", { jobId: "outbox.h", data: {}, attempts: 1, backoffMs: 1 }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(driver.isPending("outbox", "outbox.h")).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(performance.now() - started).toBeLessThan(2_000);
    await driver.close(1_000);
  });

  it("pemilihan driver: inline tanpa REDIS_URL; BullMQ (koneksi lazy konsumen + produsen, prefix per lingkungan) bila REDIS_URL diisi", async () => {
    const logger = memoryLogger().logger;
    const queue = { readyTimeoutMs: 1_000, operationTimeoutMs: 500 };
    const inline = createQueueDriver(
      { REDIS_URL: undefined },
      { queuePrefix: "kapdh:test:bull", queue },
      logger,
    );
    expect(inline.driver.kind).toBe("inline");
    expect(inline.resource).toBeNull();
    const bull = createQueueDriver(
      { REDIS_URL: "redis://127.0.0.1:6399/0" },
      { queuePrefix: "kapdh:test:bull", queue },
      logger,
    );
    expect(bull.driver.kind).toBe("bullmq");
    // Koneksi lazy belum tersambung: menutup tidak mencoba menyambung ke Redis.
    await bull.resource!.close();
  });
});
