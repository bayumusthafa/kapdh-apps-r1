import type { Job, JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import {
  type BullFactories,
  BullMqQueueDriver,
  type BullQueueLike,
  type BullWorkerLike,
} from "../src/queue/bullmq-driver.js";
import { createQueueDriver } from "../src/runtime.js";
import { memoryLogger } from "./support/fixtures.js";

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
  workerCloseDelayMs = 0;

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
        on: (_event, listener) => this.errorListeners.push(listener),
        close: async () => void this.closed.push(`queue:${name}:${options.prefix}`),
      }),
      worker: (name, processor, options): BullWorkerLike => {
        this.processors.set(name, processor);
        this.workerOptions.push({ name, concurrency: options.concurrency, prefix: options.prefix });
        return {
          on: () => undefined,
          close: async (force?: boolean) => {
            if (!force && this.workerCloseDelayMs > 0)
              await new Promise((resolve) => setTimeout(resolve, this.workerCloseDelayMs));
            this.closed.push(`worker:${name}${force ? ":force" : ""}`);
          },
        };
      },
    };
  }

  async run(queue: string, id: string, data: unknown, attemptsMade = 0): Promise<void> {
    const processor = this.processors.get(queue)!;
    await processor({ id, data, attemptsMade, opts: {} } as unknown as Job);
  }
}

const fakeConnection = (pong: () => Promise<string>) => ({ ping: pong }) as unknown as Redis;

describe("Driver BullMQ (PRD 5.1: dispatcher meneruskan ke BullMQ dengan dedup key)", () => {
  it("enqueue memakai jobId = kunci dedup, retry eksponensial, dan retensi; data hanya rujukan", async () => {
    const bull = new FakeBull();
    const driver = new BullMqQueueDriver({
      connection: fakeConnection(async () => "PONG"),
      prefix: "kapdh:test:bull",
      logger: memoryLogger().logger,
      factories: bull.factories(),
    });
    driver.register("outbox", async () => undefined, { concurrency: 3 });
    driver.register("scheduled", async () => undefined, { concurrency: 2 });
    await driver.start();
    expect(bull.workerOptions).toEqual([
      { name: "outbox", concurrency: 3, prefix: "kapdh:test:bull" },
      { name: "scheduled", concurrency: 2, prefix: "kapdh:test:bull" },
    ]);

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
      data: { name: "events.reminders", slot: "2026-10-13T02:00:00.000Z" },
      attempts: 3,
      backoffMs: 5_000,
      retainMs: 1_800_000,
    });
    expect(bull.added[1]!.opts.removeOnComplete).toEqual({ age: 1_800 });
    await driver.close(1_000);
  });

  it("slot kosong = 2 × konkurensi dikurangi backlog antrean (waiting/active/delayed)", async () => {
    const bull = new FakeBull();
    const driver = new BullMqQueueDriver({
      connection: fakeConnection(async () => "PONG"),
      prefix: "p",
      logger: memoryLogger().logger,
      factories: bull.factories(),
    });
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

  it("processor menerima meta job_id/attempt dan logger terikat (N-14); galat dilempar agar BullMQ mencoba ulang", async () => {
    const bull = new FakeBull();
    const { logger, lines } = memoryLogger();
    const seen: { jobId: string; attempt: number }[] = [];
    const driver = new BullMqQueueDriver({
      connection: fakeConnection(async () => "PONG"),
      prefix: "p",
      logger,
      factories: bull.factories(),
    });
    driver.register<{ n: number }>(
      "outbox",
      async (data, meta) => {
        seen.push({ jobId: meta.jobId, attempt: meta.attempt });
        meta.logger.info({ n: data.n, token: "jangan-dicatat" }, "memproses");
        if (data.n === 2) throw new Error("gagal sementara");
      },
      { concurrency: 1 },
    );
    await driver.start();
    await bull.run("outbox", "outbox.a", { n: 1 });
    await expect(bull.run("outbox", "outbox.b", { n: 2 }, 1)).rejects.toThrow("gagal sementara");
    expect(seen).toEqual([
      { jobId: "outbox.a", attempt: 1 },
      { jobId: "outbox.b", attempt: 2 },
    ]);
    const processing = lines.filter((line) => line.msg === "memproses");
    expect(processing[0]).toMatchObject({ queue: "outbox", driver: "bullmq", job_id: "outbox.a", attempt: 1 });
    // Redaksi logger root: kunci rahasia disensor.
    expect(processing[0]!.token).toBe("[REDACTED]");
    // Galat antrean dari koneksi Redis dicatat lewat logger (bukan crash).
    bull.errorListeners[0]!(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(lines.find((line) => line.msg === "galat antrean BullMQ")).toMatchObject({ level: "error" });
    await driver.close(1_000);
  });

  it("close() menunggu job aktif sampai batas waktu, lalu menutup paksa; enqueue setelah close ditolak", async () => {
    const bull = new FakeBull();
    bull.workerCloseDelayMs = 300;
    const driver = new BullMqQueueDriver({
      connection: fakeConnection(async () => "PONG"),
      prefix: "p",
      logger: memoryLogger().logger,
      factories: bull.factories(),
    });
    driver.register("outbox", async () => undefined, { concurrency: 1 });
    await driver.start();
    expect(await driver.close(50)).toBe(false);
    expect(bull.closed).toContain("worker:outbox:force");
    expect(bull.closed).toContain("queue:outbox:p");
    await expect(
      driver.enqueue("outbox", { jobId: "outbox.z", data: {}, attempts: 1, backoffMs: 1 }),
    ).rejects.toThrow(/ditutup/);

    const graceful = new FakeBull();
    const second = new BullMqQueueDriver({
      connection: fakeConnection(async () => "PONG"),
      prefix: "p",
      logger: memoryLogger().logger,
      factories: graceful.factories(),
    });
    second.register("outbox", async () => undefined, { concurrency: 1 });
    await second.start();
    expect(await second.close(1_000)).toBe(true);
    expect(graceful.closed).toEqual(["worker:outbox", "queue:outbox:p"]);
  });

  it("ping() → false bila Redis tidak menjawab atau galat (health queue_unreachable)", async () => {
    const ok = new BullMqQueueDriver({
      connection: fakeConnection(async () => "PONG"),
      prefix: "p",
      logger: memoryLogger().logger,
      factories: new FakeBull().factories(),
    });
    expect(await ok.ping()).toBe(true);
    const down = new BullMqQueueDriver({
      connection: fakeConnection(async () => {
        throw new Error("Connection is closed.");
      }),
      prefix: "p",
      logger: memoryLogger().logger,
      factories: new FakeBull().factories(),
    });
    expect(await down.ping()).toBe(false);
  });

  it("pemilihan driver: inline tanpa REDIS_URL; BullMQ (koneksi lazy, prefix per lingkungan) bila REDIS_URL diisi", async () => {
    const logger = memoryLogger().logger;
    const inline = createQueueDriver({ REDIS_URL: undefined }, { queuePrefix: "kapdh:test:bull" }, logger);
    expect(inline.driver.kind).toBe("inline");
    expect(inline.resource).toBeNull();
    const bull = createQueueDriver(
      { REDIS_URL: "redis://127.0.0.1:6399/0" },
      { queuePrefix: "kapdh:test:bull" },
      logger,
    );
    expect(bull.driver.kind).toBe("bullmq");
    // Koneksi lazy belum tersambung: menutup tidak mencoba menyambung ke Redis.
    await bull.resource!.close();
  });
});
