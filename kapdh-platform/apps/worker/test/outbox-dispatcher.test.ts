import { type JobRunner, OUTBOX_LOCK_MS, OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "@kapdh/api/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxDispatcher } from "../src/outbox/dispatcher.js";
import { InlineQueueDriver } from "../src/queue/inline-driver.js";
import type { QueueDriver } from "../src/queue/queue-driver.js";
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

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.close();
});
beforeEach(async () => {
  await clearOutbox(tdb.db);
});

interface Harness {
  clock: TestClock;
  fake: ReturnType<typeof fakeRegistry>;
  jobs: JobRunner;
  queue: InlineQueueDriver;
  dispatcher: OutboxDispatcher;
  logs: ReturnType<typeof memoryLogger>;
}

async function harness(options: { concurrency?: number; leaseMs?: number; queue?: QueueDriver } = {}) {
  const clock = new TestClock();
  const fake = fakeRegistry();
  const logs = memoryLogger();
  const jobs = createJobRunner(fake.registry, tdb.db, clock, logs.logger);
  const queue = new InlineQueueDriver(logs.logger);
  const dispatcher = new OutboxDispatcher(
    { jobs, queue: options.queue ?? queue, clock, logger: logs.logger },
    {
      pollIntervalMs: 250,
      batchSize: 50,
      leaseMs: options.leaseMs ?? OUTBOX_LOCK_MS,
      concurrency: options.concurrency ?? 4,
      attempts: 3,
      backoffMs: 10,
    },
  );
  dispatcher.attach();
  await queue.start();
  return { clock, fake, jobs, queue, dispatcher, logs } satisfies Harness;
}

describe("Dispatcher outbox (PRD 5.1, ARCHITECTURE §4.8)", () => {
  it("PRD 5.1: event jatuh tempo diklaim, diteruskan ke antrean, dirutekan ke handler topiknya, lalu dispatched", async () => {
    const h = await harness();
    const cancelled = await insertOutboxEvent(tdb.db, h.clock, {
      topic: "event.cancelled",
      requestId: "req-api-1",
    });
    const exported = await insertOutboxEvent(tdb.db, h.clock, {
      topic: "audit.export.requested",
      payload: {
        export_id: "0190a6f2-0000-7000-8000-000000000001",
        admin_id: "0190a6f2-0000-7000-8000-000000000002",
      },
    });
    expect(await h.dispatcher.pollOnce()).toEqual({ claimed: 2, limit: 4 });
    await h.queue.drained();

    expect(h.fake.calls.map((call) => [call.id, call.topic]).sort()).toEqual(
      [
        [cancelled, "event.cancelled"],
        [exported, "audit.export.requested"],
      ].sort(),
    );
    // N-14: job_id dan request_id asal (request HTTP yang mempublikasikan event) diteruskan ke handler.
    expect(h.fake.calls.find((call) => call.id === cancelled)).toMatchObject({
      jobId: `outbox:${cancelled}`,
      requestId: "req-api-1",
      attempts: 1,
    });
    for (const id of [cancelled, exported])
      expect(await outboxRow(tdb.db, id)).toMatchObject({
        status: "dispatched",
        attempts: 1,
        lockedUntil: null,
        lastError: null,
        dispatchedAt: h.clock.now(),
      });
    // Sudah terkirim: tidak pernah diklaim lagi.
    expect(await h.dispatcher.pollOnce()).toEqual({ claimed: 0, limit: 4 });
    expect(h.dispatcher.status().totals).toMatchObject({ claimed: 2, dispatched: 2, failed: 0, dead: 0 });
    await h.queue.close(1_000);
  });

  it("PRD 5.1: handler gagal → failed + attempts + backoff eksponensial + last_error aman; dicoba ulang saat jatuh tempo", async () => {
    const h = await harness();
    h.fake.control.failNext = 2;
    const id = await insertOutboxEvent(tdb.db, h.clock);

    await h.dispatcher.pollOnce();
    await h.queue.drained();
    const first = await outboxRow(tdb.db, id);
    expect(first).toMatchObject({
      status: "failed",
      attempts: 1,
      lockedUntil: null,
      lastError: "Error:ECONNRESET",
    });
    expect(first.nextAttemptAt.getTime()).toBe(h.clock.now().getTime() + outboxBackoffMs(1));
    // N-14: pesan galat (berisi alamat email) tidak tersimpan maupun tercatat.
    expect(first.lastError).not.toContain("rahasia");
    expect(JSON.stringify(h.logs.lines)).not.toContain("rahasia@contoh.id");

    // Belum jatuh tempo: tidak diklaim.
    h.clock.advance(outboxBackoffMs(1) - 1);
    expect((await h.dispatcher.pollOnce()).claimed).toBe(0);
    h.clock.advance(1);
    expect((await h.dispatcher.pollOnce()).claimed).toBe(1);
    await h.queue.drained();
    const second = await outboxRow(tdb.db, id);
    expect(second).toMatchObject({ status: "failed", attempts: 2 });
    // Backoff berlipat: 10 s, 20 s, 40 s, ...
    expect(second.nextAttemptAt.getTime()).toBe(h.clock.now().getTime() + outboxBackoffMs(2));
    expect(outboxBackoffMs(2)).toBe(2 * outboxBackoffMs(1));

    h.clock.advance(outboxBackoffMs(2));
    await h.dispatcher.pollOnce();
    await h.queue.drained();
    expect(await outboxRow(tdb.db, id)).toMatchObject({ status: "dispatched", attempts: 3, lastError: null });
    expect(h.fake.calls.map((call) => call.attempts)).toEqual([1, 2, 3]);
    await h.queue.close(1_000);
  });

  it("PRD 5.5: setelah percobaan maksimum event menjadi dead (butuh tindakan operator) dan tidak diklaim lagi", async () => {
    const h = await harness();
    h.fake.control.failAlways = true;
    const id = await insertOutboxEvent(tdb.db, h.clock);
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      expect((await h.dispatcher.pollOnce()).claimed).toBe(1);
      await h.queue.drained();
      h.clock.advance(outboxBackoffMs(attempt));
    }
    expect(await outboxRow(tdb.db, id)).toMatchObject({
      status: "dead",
      attempts: OUTBOX_MAX_ATTEMPTS,
      lockedUntil: null,
      lastError: "Error:ECONNRESET",
    });
    h.clock.advance(24 * 3600_000);
    expect((await h.dispatcher.pollOnce()).claimed).toBe(0);
    expect(h.fake.calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(h.dispatcher.status().totals).toMatchObject({ failed: OUTBOX_MAX_ATTEMPTS - 1, dead: 1 });
    const deadLog = h.logs.lines.find((line) => line.msg === "event outbox mati setelah percobaan maksimum");
    expect(deadLog).toMatchObject({ level: "error", job_id: `outbox:${id}`, attempts: OUTBOX_MAX_ATTEMPTS });
    await h.queue.close(1_000);
  });

  it("PRD 5.1: klaim dari dispatcher yang mati (lease) diklaim ulang setelah lease habis; klaim lama tidak pernah menjalankan handler", async () => {
    const h = await harness({ leaseMs: 60_000 });
    const id = await insertOutboxEvent(tdb.db, h.clock);
    // Proses lain mengklaim lalu mati sebelum memproses (mis. kill -9 setelah klaim, job hilang dari Redis).
    const [stale] = await h.jobs.claimOutbox({ limit: 10, lockMs: 60_000 });
    expect(stale).toMatchObject({ id, attempts: 1 });

    // Lease masih berlaku: tidak ada yang mengklaim (tidak diproses ganda).
    expect((await h.dispatcher.pollOnce()).claimed).toBe(0);
    h.clock.advance(60_000);
    expect((await h.dispatcher.pollOnce()).claimed).toBe(0);
    // Lease habis: event diklaim ulang dan diproses sekali.
    h.clock.advance(1);
    expect((await h.dispatcher.pollOnce()).claimed).toBe(1);
    await h.queue.drained();
    expect(await outboxRow(tdb.db, id)).toMatchObject({ status: "dispatched", attempts: 2 });
    expect(h.fake.calls).toHaveLength(1);

    // Job lama yang muncul terlambat (mis. BullMQ setelah Redis pulih) ditolak oleh token lease (fencing).
    expect(await h.jobs.processOutboxClaim(stale!, { lockMs: 60_000 })).toBe("lost");
    expect(h.fake.calls).toHaveLength(1);
    await h.queue.close(1_000);
  });

  it("PRD 5.1: lease diperpanjang (heartbeat) selama handler panjang berjalan sehingga dispatcher lain tidak mengklaimnya", async () => {
    const h = await harness({ leaseMs: 1_500 });
    const id = await insertOutboxEvent(tdb.db, h.clock);
    const claimedAt = h.clock.now().getTime();
    let observedLease = 0;
    h.fake.control.onHandle = async () => {
      // Waktu berjalan 1 s di jam aplikasi, lalu tunggu detak heartbeat (setiap max(1 s, lease/3)).
      h.clock.advance(1_000);
      await eventually(async () => {
        observedLease = (await outboxRow(tdb.db, id)).lockedUntil?.getTime() ?? 0;
        return observedLease === claimedAt + 1_000 + 1_500;
      }, 5_000);
      // Lease lama (T+1.5 s) sudah lewat di jam aplikasi, tetapi event tetap milik klaim ini.
      h.clock.advance(1_000);
      expect((await h.jobs.claimOutbox({ limit: 10, lockMs: 1_500 })).length).toBe(0);
    };
    await h.dispatcher.pollOnce();
    await h.queue.drained();
    expect(observedLease).toBe(claimedAt + 2_500);
    expect(await outboxRow(tdb.db, id)).toMatchObject({
      status: "dispatched",
      lockedUntil: null,
      attempts: 1,
    });
    await h.queue.close(1_000);
  });

  it("PRD 5.1: backpressure — klaim dibatasi slot antrean yang kosong; sisanya tetap pending tanpa lease", async () => {
    const h = await harness({ concurrency: 2 });
    h.fake.hold();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertOutboxEvent(tdb.db, h.clock));
    expect(await h.dispatcher.pollOnce()).toEqual({ claimed: 2, limit: 2 });
    expect(await h.dispatcher.pollOnce()).toEqual({ claimed: 0, limit: 0 });
    const rows = await Promise.all(ids.map((id) => outboxRow(tdb.db, id)));
    expect(rows.filter((row) => row.lockedUntil !== null)).toHaveLength(2);
    h.fake.release();
    await h.queue.drained();
    while ((await h.dispatcher.pollOnce()).claimed > 0) await h.queue.drained();
    for (const id of ids) expect((await outboxRow(tdb.db, id)).status).toBe("dispatched");
    expect(h.fake.calls).toHaveLength(5);
    await h.queue.close(1_000);
  });

  it("PRD 5.1: antrean menolak enqueue (Redis putus) → klaim dilepas segera tanpa menunggu lease dan tanpa menambah percobaan", async () => {
    const base = await harness();
    const broken: QueueDriver = {
      kind: "bullmq",
      register: () => undefined,
      start: async () => undefined,
      enqueue: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:6379"), { code: "ECONNREFUSED" });
      },
      capacity: async () => 10,
      isPending: async () => false,
      ping: async () => false,
      close: async () => true,
    };
    const dispatcher = new OutboxDispatcher(
      { jobs: base.jobs, queue: broken, clock: base.clock, logger: base.logs.logger },
      {
        pollIntervalMs: 250,
        batchSize: 50,
        leaseMs: OUTBOX_LOCK_MS,
        concurrency: 4,
        attempts: 3,
        backoffMs: 10,
      },
    );
    const ids = [await insertOutboxEvent(tdb.db, base.clock), await insertOutboxEvent(tdb.db, base.clock)];
    await expect(dispatcher.pollOnce()).rejects.toThrow(/ECONNREFUSED/);
    for (const id of ids)
      expect(await outboxRow(tdb.db, id)).toMatchObject({
        status: "pending",
        lockedUntil: null,
        attempts: 0,
      });
    expect(dispatcher.status().totals).toMatchObject({ claimed: 2, released: 2 });
    // Dispatcher yang sehat langsung mengambilnya (tidak menunggu lease 5 menit).
    expect((await base.dispatcher.pollOnce()).claimed).toBe(2);
    await base.queue.drained();
    for (const id of ids) expect((await outboxRow(tdb.db, id)).status).toBe("dispatched");
    await base.queue.close(1_000);
  });

  it("ARCHITECTURE §4.8: loop poll berjalan otomatis setiap interval dan berhenti saat stop()", async () => {
    const h = await harness();
    h.dispatcher.start();
    const first = await insertOutboxEvent(tdb.db, h.clock);
    await eventually(async () => (await outboxRow(tdb.db, first)).status === "dispatched");
    expect(h.dispatcher.status()).toMatchObject({ running: true, consecutiveFailures: 0 });
    expect(h.dispatcher.status().lastPollOkAt).not.toBeNull();

    await h.dispatcher.stop();
    expect(h.dispatcher.status().running).toBe(false);
    const late = await insertOutboxEvent(tdb.db, h.clock);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await outboxRow(tdb.db, late)).status).toBe("pending");
    await h.queue.close(1_000);
  });

  it("ARCHITECTURE §4.8: galat poll (database putus) dicatat aman, dihitung, dan loop tetap hidup", async () => {
    const h = await harness();
    const failing = {
      claimOutbox: async () => {
        throw Object.assign(new Error("password authentication failed for user kapdh_worker"), {
          code: "28P01",
        });
      },
      processOutboxClaim: h.jobs.processOutboxClaim.bind(h.jobs),
      releaseOutboxClaim: h.jobs.releaseOutboxClaim.bind(h.jobs),
    };
    const queue = new InlineQueueDriver(h.logs.logger);
    const dispatcher = new OutboxDispatcher(
      { jobs: failing, queue, clock: h.clock, logger: h.logs.logger },
      {
        pollIntervalMs: 250,
        batchSize: 50,
        leaseMs: OUTBOX_LOCK_MS,
        concurrency: 2,
        attempts: 1,
        backoffMs: 10,
      },
    );
    dispatcher.attach();
    await queue.start();
    dispatcher.start();
    await eventually(() => dispatcher.status().consecutiveFailures >= 2);
    await dispatcher.stop();
    expect(dispatcher.status().lastLoopAt).not.toBeNull();
    expect(dispatcher.status().lastPollOkAt).toBeNull();
    const logged = h.logs.lines.filter((line) => line.msg === "poll outbox gagal");
    // Log dibatasi (galat pertama), tanpa pesan galat mentah.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "error", error: { type: "Error", error_code: "28P01" } });
    expect(JSON.stringify(h.logs.lines)).not.toContain("password authentication");
    await queue.close(1_000);
    await h.queue.close(1_000);
  });
});
