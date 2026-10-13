import { JobRegistry, JobRunner, OUTBOX_LOCK_MS } from "@kapdh/api/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxDispatcher } from "../../src/outbox/dispatcher.js";
import { InlineQueueDriver } from "../../src/queue/inline-driver.js";
import { eventually, insertOutboxEvent, silentLogger, T0, TestClock } from "../support/fixtures.js";
import { connectWorker, createWorkerPgDatabase, type Sql, sleep, type WorkerPgDatabase } from "./support.js";

let tdb: WorkerPgDatabase;
const pools: Sql[] = [];

beforeAll(async () => {
  tdb = await createWorkerPgDatabase("outbox");
});
beforeEach(async () => {
  await tdb.admin`delete from app.outbox_events`;
});
afterAll(async () => {
  for (const pool of pools) await pool.end({ timeout: 5 });
  await tdb.drop();
});

/** Satu instance worker dengan pool kapdh_worker sendiri; handler mencatat ke peta bersama (deteksi duplikasi). */
function instance(name: string, clock: TestClock, handled: Map<string, string[]>, lockMs = OUTBOX_LOCK_MS) {
  const { db, sql } = connectWorker(tdb, `kapdh-worker-${name}`);
  pools.push(sql);
  const logger = silentLogger();
  const registry = new JobRegistry();
  registry.registerTopicHandler({
    topic: "event.cancelled",
    handle: async (event) => {
      handled.set(event.id, [...(handled.get(event.id) ?? []), name]);
      // Sedikit kerja agar kedua instance benar-benar saling bersaing mengklaim.
      await sleep(2);
    },
  });
  const jobs = new JobRunner(registry, db, clock, logger);
  const queue = new InlineQueueDriver(logger);
  const dispatcher = new OutboxDispatcher(
    { jobs, queue, clock, logger },
    { pollIntervalMs: 250, batchSize: 50, leaseMs: lockMs, concurrency: 4, attempts: 3, backoffMs: 10 },
  );
  dispatcher.attach();
  return { db, jobs, queue, dispatcher };
}

describe("Dispatcher outbox di PostgreSQL 17 nyata (FOR UPDATE SKIP LOCKED + lease, PRD 5.1)", () => {
  it("PRD 5.1: dua worker mem-poll bersamaan dengan koneksi nyata — setiap event diproses tepat sekali, tidak ada yang hilang", async () => {
    const clock = new TestClock(T0);
    const handled = new Map<string, string[]>();
    const a = instance("a", clock, handled);
    const b = instance("b", clock, handled);
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push(await insertOutboxEvent(a.db, clock));
    await Promise.all([a.queue.start(), b.queue.start()]);
    a.dispatcher.start();
    b.dispatcher.start();
    try {
      await eventually(async () => {
        const [row] = await tdb.admin<{ n: number }[]>`
          select count(*)::int as n from app.outbox_events where status = 'dispatched'`;
        return row!.n === 300;
      }, 60_000);
    } finally {
      await Promise.all([a.dispatcher.stop(), b.dispatcher.stop()]);
      await Promise.all([a.queue.close(5_000), b.queue.close(5_000)]);
    }
    expect(handled.size).toBe(300);
    const duplicates = [...handled.entries()].filter(([, by]) => by.length !== 1);
    expect(duplicates).toEqual([]);
    expect(ids.every((id) => handled.has(id))).toBe(true);
    // Keduanya ikut mengklaim (beban terbagi), total klaim = jumlah event.
    const claimedA = a.dispatcher.status().totals.claimed;
    const claimedB = b.dispatcher.status().totals.claimed;
    expect(claimedA + claimedB).toBe(300);
    expect(claimedA).toBeGreaterThan(0);
    expect(claimedB).toBeGreaterThan(0);
    const [left] = await tdb.admin<{ n: number }[]>`
      select count(*)::int as n from app.outbox_events where locked_until is not null or attempts <> 1`;
    expect(left!.n).toBe(0);
  });

  it("PRD 5.1: klaim paralel batch besar dari dua koneksi tidak pernah tumpang tindih (SKIP LOCKED)", async () => {
    const clock = new TestClock(new Date(T0.getTime() + 3600_000));
    const handled = new Map<string, string[]>();
    const a = instance("c", clock, handled);
    const b = instance("d", clock, handled);
    for (let i = 0; i < 100; i++) await insertOutboxEvent(a.db, clock);
    const [left, right] = await Promise.all([
      a.jobs.claimOutbox({ limit: 80, lockMs: 60_000 }),
      b.jobs.claimOutbox({ limit: 80, lockMs: 60_000 }),
    ]);
    const leftIds = new Set(left.map((claim) => claim.id));
    expect(right.filter((claim) => leftIds.has(claim.id))).toEqual([]);
    expect(left.length + right.length).toBe(100);
  });

  it("PRD 5.1: job antrean dengan lease kedaluwarsa mulai diproses BERSAMAAN dengan klaim ulang dispatcher lain (dua koneksi nyata) → setiap event ditangani tepat sekali dan tidak pernah berjalan bersamaan", async () => {
    const clock = new TestClock(new Date(T0.getTime() + 10_800_000));
    const inFlight = new Set<string>();
    const overlaps: string[] = [];
    const handled = new Map<string, string[]>();
    const racer = (name: string) => {
      const { db, sql } = connectWorker(tdb, `kapdh-worker-race-${name}`, 8);
      pools.push(sql);
      const registry = new JobRegistry();
      registry.registerTopicHandler({
        topic: "event.cancelled",
        handle: async (event) => {
          if (inFlight.has(event.id)) overlaps.push(event.id);
          inFlight.add(event.id);
          handled.set(event.id, [...(handled.get(event.id) ?? []), name]);
          // Handler "mengirim notifikasi" cukup lama agar jendela balapan terbuka lebar.
          await sleep(15);
          inFlight.delete(event.id);
        },
      });
      return { db, jobs: new JobRunner(registry, db, clock, silentLogger()) };
    };
    const stale = racer("stale");
    const fresh = racer("fresh");
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await insertOutboxEvent(stale.db, clock));
    // Job antrean diklaim lalu menunggu melewati lease (mis. semua worker mati > 5 menit, Redis menyimpan job).
    const waiting = await stale.jobs.claimOutbox({ limit: 40, lockMs: 60_000 });
    expect(waiting).toHaveLength(40);
    clock.advance(60_001);

    const outcomes = await Promise.all([
      Promise.all(waiting.map((claim) => stale.jobs.processOutboxClaim(claim, { lockMs: 60_000 }))),
      (async () => {
        const results: string[] = [];
        for (let round = 0; round < 6; round++) {
          const claims = await fresh.jobs.claimOutbox({ limit: 40, lockMs: 60_000 });
          results.push(
            ...(await Promise.all(
              claims.map((claim) => fresh.jobs.processOutboxClaim(claim, { lockMs: 60_000 })),
            )),
          );
          await sleep(5);
        }
        return results;
      })(),
    ]);

    expect(overlaps).toEqual([]);
    expect(ids.every((id) => handled.get(id)?.length === 1)).toBe(true);
    const all = outcomes.flat();
    expect(all.filter((outcome) => outcome === "dispatched")).toHaveLength(40);
    const [left] = await tdb.admin<{ n: number }[]>`
      select count(*)::int as n from app.outbox_events where status <> 'dispatched' or locked_until is not null`;
    expect(left!.n).toBe(0);
  });

  it("PRD 5.1: worker mati setelah klaim → lease habis → worker lain mengklaim ulang dan memproses sekali; klaim lama ditolak", async () => {
    const clock = new TestClock(new Date(T0.getTime() + 7200_000));
    const handled = new Map<string, string[]>();
    const dead = instance("dead", clock, handled, 60_000);
    const alive = instance("alive", clock, handled, 60_000);
    await alive.queue.start();
    const id = await insertOutboxEvent(dead.db, clock);
    const [stale] = await dead.jobs.claimOutbox({ limit: 1, lockMs: 60_000 });
    expect(stale!.id).toBe(id);
    expect((await alive.dispatcher.pollOnce()).claimed).toBe(0);
    clock.advance(60_001);
    expect((await alive.dispatcher.pollOnce()).claimed).toBe(1);
    await alive.queue.drained();
    expect(handled.get(id)).toEqual(["alive"]);
    expect(await dead.jobs.processOutboxClaim(stale!, { lockMs: 60_000 })).toBe("lost");
    expect(handled.get(id)).toEqual(["alive"]);
    const [row] = await tdb.admin<{ status: string; attempts: number }[]>`
      select status, attempts from app.outbox_events where id = ${id}`;
    expect(row).toEqual({ status: "dispatched", attempts: 2 });
    await alive.queue.close(1_000);
  });
});
