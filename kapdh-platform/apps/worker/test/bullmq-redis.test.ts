import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxDispatcher } from "../src/outbox/dispatcher.js";
import { QueueUnavailableError } from "../src/queue/queue-driver.js";
import { createQueueDriver } from "../src/runtime.js";
import { defaultReply, FakeRedis } from "./support/fake-redis.js";
import {
  clearOutbox,
  createJobRunner,
  createTestDatabase,
  eventually,
  fakeRegistry,
  insertOutboxEvent,
  memoryLogger,
  outboxRow,
  type TestDatabase,
  TestClock,
} from "./support/fixtures.js";

/**
 * Ketahanan Redis dengan ioredis + BullMQ SUNGGUHAN (bukan tiruan driver) terhadap server RESP minimal: Redis mati
 * saat boot, Redis putus setelah boot, dan Redis menggantung. Pemrosesan job BullMQ sendiri (skrip Lua) tidak diuji di
 * sini; yang dibuktikan adalah driver tidak pernah berjalan dengan klien rusak permanen dan tidak pernah menggantung.
 */

let tdb: TestDatabase;
let fake: FakeRedis;
let cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.close();
});
beforeEach(async () => {
  await clearOutbox(tdb.db);
  fake = new FakeRedis();
  cleanup = [];
});
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  await fake.stop();
});

function driver(options: { readyTimeoutMs?: number; operationTimeoutMs?: number } = {}) {
  const logs = memoryLogger();
  const created = createQueueDriver(
    { REDIS_URL: fake.url },
    {
      queuePrefix: "kapdh:test:bull",
      queue: {
        readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
        operationTimeoutMs: options.operationTimeoutMs ?? 300,
      },
    },
    logs.logger,
  );
  cleanup.push(async () => {
    await created.driver.close(500);
    await created.resource!.close();
  });
  return { ...created, logs };
}

function registerNoop(queue: ReturnType<typeof driver>["driver"]) {
  queue.register("outbox", async () => undefined, { concurrency: 2 });
  queue.register("scheduled", async () => undefined, { concurrency: 1 });
}

async function timed<T>(promise: Promise<T>): Promise<{ ms: number; result: PromiseSettledResult<T> }> {
  const started = performance.now();
  const [result] = await Promise.allSettled([promise]);
  return { ms: performance.now() - started, result: result! };
}

describe("Antrean BullMQ dengan Redis yang putus (PRD 5.1, 5.5)", () => {
  it("PRD 5.1: Redis mati saat boot dan tidak kembali → start gagal setelah batas tunggu (proses keluar lalu dijalankan ulang), bukan berjalan dengan klien BullMQ rusak", async () => {
    await fake.reservePort();
    const { driver: queue, logs } = driver({ readyTimeoutMs: 700 });
    registerNoop(queue);
    const { ms, result } = await timed(queue.start());
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(QueueUnavailableError);
    expect(ms).toBeGreaterThanOrEqual(650);
    expect(ms).toBeLessThan(5_000);
    expect(await queue.ping()).toBe(false);
    await expect(
      queue.enqueue("outbox", { jobId: "outbox.a.1", data: {}, attempts: 1, backoffMs: 1 }),
    ).rejects.toThrow(/belum dimulai atau sudah ditutup/);
    expect(
      logs.lines.find((line) => String(line.msg).startsWith("Redis BullMQ tidak siap saat start")),
    ).toMatchObject({ level: "error", error: { type: "QueueUnavailableError" } });
  });

  it("PRD 5.1: Redis mati saat boot lalu menyala dalam masa tunggu → start berhasil; antrean berfungsi dan health ping true", async () => {
    await fake.reservePort();
    const { driver: queue } = driver({ readyTimeoutMs: 10_000 });
    registerNoop(queue);
    const starting = queue.start();
    // Klien BullMQ belum dibuat selama Redis mati: tidak ada inisialisasi yang gagal permanen.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fake.start();
    await starting;
    expect(await queue.capacity("outbox")).toBe(4);
    expect(await queue.ping()).toBe(true);
    // Klien BullMQ terinisialisasi setelah Redis menyala dan loop konsumen (koneksi blocking) berjalan.
    expect(fake.received.some((command) => command[0] === "HSET")).toBe(true);
    await eventually(() => fake.count("BZPOPMIN") >= 2);
  });

  it("PRD 5.1: Redis putus setelah boot → enqueue/slot/status job ditolak cepat (tidak menggantung), ping false; Redis kembali → pulih tanpa restart", async () => {
    await fake.start();
    const { driver: queue } = driver({ operationTimeoutMs: 1_000 });
    registerNoop(queue);
    await queue.start();
    expect(await queue.capacity("outbox")).toBe(4);
    expect(await queue.ping()).toBe(true);

    await fake.stop();
    for (const operation of [
      (): Promise<unknown> => queue.capacity("outbox"),
      () => queue.enqueue("outbox", { jobId: "outbox.b.1", data: {}, attempts: 1, backoffMs: 1 }),
      () => queue.isPending("scheduled", "scheduled.x.1"),
    ]) {
      const { ms, result } = await timed(operation());
      expect(result.status).toBe("rejected");
      // Koneksi produsen gagal cepat; paling lambat batas waktu operasi.
      expect(ms).toBeLessThanOrEqual(1_200);
    }
    expect(await queue.ping()).toBe(false);

    await fake.start();
    await eventually(async () => queue.ping(), 10_000);
    expect(await queue.capacity("outbox")).toBe(4);
  });

  it("PRD 5.1: Redis menggantung saat enqueue (koneksi setengah terbuka) → batas waktu operasi; poll outbox melepas klaim segera tanpa menambah percobaan", async () => {
    await fake.start();
    const { driver: queue, logs } = driver({ operationTimeoutMs: 300 });
    const clock = new TestClock();
    const handlers = fakeRegistry();
    const jobs = createJobRunner(handlers.registry, tdb.db, clock, logs.logger);
    const dispatcher = new OutboxDispatcher(
      { jobs, queue, clock, logger: logs.logger },
      { pollIntervalMs: 250, batchSize: 50, leaseMs: 300_000, concurrency: 2, attempts: 3, backoffMs: 10 },
    );
    dispatcher.attach();
    queue.register("scheduled", async () => undefined, { concurrency: 1 });
    await queue.start();
    const ids = [await insertOutboxEvent(tdb.db, clock), await insertOutboxEvent(tdb.db, clock)];
    // Hitungan slot dijawab; perintah yang membawa id job outbox tidak pernah dijawab (Redis menggantung).
    fake.reply = (command) =>
      command.some((part) => part.startsWith("outbox.event.cancelled")) ? null : defaultReply(command);

    const { ms, result } = await timed(dispatcher.pollOnce());
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(QueueUnavailableError);
    expect(ms).toBeLessThan(2_000);
    for (const id of ids)
      expect(await outboxRow(tdb.db, id)).toMatchObject({ status: "pending", lockedUntil: null, attempts: 0 });
    expect(dispatcher.status().totals).toMatchObject({ claimed: 2, released: 2 });
    expect(logs.lines.find((line) => line.msg === "antrean menolak klaim outbox; klaim dilepas")).toMatchObject({
      level: "warn",
      unqueued: 2,
      released: 2,
      error: { type: "QueueUnavailableError", error_code: "QUEUE_UNAVAILABLE" },
    });
    expect(handlers.calls).toHaveLength(0);
  });
});
