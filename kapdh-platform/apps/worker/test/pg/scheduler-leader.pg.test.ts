import { ADVISORY_LOCK_KEYS, type Db, JobRegistry, JobRunner } from "@kapdh/api/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InlineQueueDriver } from "../../src/queue/inline-driver.js";
import { connectLeaderLock, type PgAdvisoryLeaderLock } from "../../src/scheduler/leader-lock.js";
import { Scheduler } from "../../src/scheduler/scheduler.js";
import { silentLogger, T0, TestClock } from "../support/fixtures.js";
import { createWorkerPgDatabase, sleep, type WorkerPgDatabase } from "./support.js";

let tdb: WorkerPgDatabase;

beforeAll(async () => {
  tdb = await createWorkerPgDatabase("leader");
});
afterAll(async () => {
  await tdb.drop();
});

interface Node {
  name: string;
  lock: PgAdvisoryLeaderLock;
  scheduler: Scheduler;
  queue: InlineQueueDriver;
  runs: string[];
}

/** Satu instance worker: koneksi kunci leader sungguhan (role kapdh_worker) + penjadwal + antrean inline. */
async function node(name: string, clock: TestClock): Promise<Node> {
  const logger = silentLogger();
  const registry = new JobRegistry();
  const runs: string[] = [];
  for (const job of [
    { name: "reservations.expire", everyMs: 60_000 },
    { name: "membership.expiry-reminders", everyMs: 3_600_000 },
  ])
    registry.registerScheduled({
      name: job.name,
      everyMs: job.everyMs,
      run: async () => void runs.push(job.name),
    });
  const lock = connectLeaderLock(tdb.workerUrl, { applicationName: `kapdh-worker-leader-${name}` });
  const queue = new InlineQueueDriver(logger);
  const scheduler = new Scheduler(
    { registry, jobs: new JobRunner(registry, {} as Db, clock, logger), queue, leader: lock, clock, logger },
    { tickMs: 1_000, concurrency: 2, attempts: 1, backoffMs: 10, staggerMs: 0 },
  );
  scheduler.attach();
  await queue.start();
  return { name, lock, scheduler, queue, runs };
}

async function tickAll(nodes: Node[]): Promise<void> {
  await Promise.all(nodes.map((n) => n.scheduler.tick()));
  await Promise.all(nodes.map((n) => n.queue.drained()));
}

async function close(nodes: Node[]): Promise<void> {
  for (const n of nodes) {
    await n.scheduler.stop();
    await n.queue.close(1_000);
    await n.scheduler.resign();
    await n.lock.close();
  }
}

/** Pemegang kunci advisory leader menurut PostgreSQL (application_name backend pemegangnya). */
async function lockHolders(): Promise<string[]> {
  const key = BigInt(ADVISORY_LOCK_KEYS.workerSchedulerLeader);
  const rows = await tdb.admin<{ application_name: string }[]>`
    select a.application_name from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database())
      and l.classid = ${(key >> 32n).toString()}::oid and l.objid = ${(key & 0xffffffffn).toString()}::oid
      and l.objsubid = 1`;
  return rows.map((row) => row.application_name);
}

describe("Leader penjadwal lintas instance (PostgreSQL 17 nyata, kunci advisory sesi, PRD 5.1)", () => {
  it("PRD 5.1: dua worker mengecek kunci bersamaan berulang kali — selalu tepat satu leader dan hanya leader yang menjalankan job", async () => {
    const clock = new TestClock(T0);
    const nodes = [await node("a", clock), await node("b", clock)];
    try {
      for (let round = 0; round < 20; round++) {
        await tickAll(nodes);
        const roles = nodes.map((n) => n.scheduler.status().role);
        expect(roles.filter((role) => role === "leader")).toHaveLength(1);
        clock.advance(30_000);
      }
      const leader = nodes.find((n) => n.scheduler.status().role === "leader")!;
      const standby = nodes.find((n) => n !== leader)!;
      expect(await lockHolders()).toEqual([`kapdh-worker-leader-${leader.name}`]);
      // 20 tick × 30 s = 10 menit: job per menit 10×, job per jam 1× (susulan saat menjadi leader); tanpa duplikasi.
      expect(leader.runs.filter((job) => job === "reservations.expire")).toHaveLength(10);
      expect(leader.runs.filter((job) => job === "membership.expiry-reminders")).toHaveLength(1);
      expect(standby.runs).toEqual([]);
    } finally {
      await close(nodes);
    }
    expect(await lockHolders()).toEqual([]);
  });

  it("PRD 5.1: leader berhenti halus (resign) → standby menjadi leader pada tick berikutnya", async () => {
    const clock = new TestClock(T0);
    const a = await node("a", clock);
    const b = await node("b", clock);
    try {
      await tickAll([a]);
      await tickAll([b]);
      expect([a.scheduler.status().role, b.scheduler.status().role]).toEqual(["leader", "standby"]);
      await a.scheduler.stop();
      await a.scheduler.resign();
      clock.advance(1_000);
      await tickAll([b]);
      expect(b.scheduler.status().role).toBe("leader");
      expect(await lockHolders()).toEqual(["kapdh-worker-leader-b"]);
      expect(b.runs.sort()).toEqual(["membership.expiry-reminders", "reservations.expire"]);
    } finally {
      await close([a, b]);
    }
  });

  it("PRD 5.1: proses leader mati / koneksi putus (pg_terminate_backend) → PostgreSQL melepas kunci, instance lain mengambil alih, instance lama menjadi standby", async () => {
    const clock = new TestClock(T0);
    const a = await node("a", clock);
    const b = await node("b", clock);
    try {
      await tickAll([a]);
      await tickAll([b]);
      expect(a.scheduler.status().role).toBe("leader");
      const terminated = await tdb.admin<{ ok: boolean }[]>`
        select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = 'kapdh-worker-leader-a'`;
      expect(terminated.map((row) => row.ok)).toEqual([true]);
      // PostgreSQL melepas kunci sesi saat backend berakhir.
      for (let i = 0; i < 50 && (await lockHolders()).length > 0; i++) await sleep(50);
      clock.advance(1_000);
      await tickAll([b]);
      expect(b.scheduler.status().role).toBe("leader");
      // Instance lama: tick pertama gagal (koneksi diputus) atau tersambung ulang ke backend baru tanpa kunci; tidak
      // pernah lagi menganggap diri leader selama b memegang kunci.
      for (let i = 0; i < 3; i++) {
        clock.advance(1_000);
        await tickAll([a, b]);
        expect(a.scheduler.status().role).toBe("standby");
        expect(b.scheduler.status().role).toBe("leader");
      }
      expect(await lockHolders()).toEqual(["kapdh-worker-leader-b"]);
      const runsBefore = a.runs.length;
      clock.advance(120_000);
      await tickAll([a, b]);
      expect(a.runs.length).toBe(runsBefore);
    } finally {
      await close([a, b]);
    }
  });
});
