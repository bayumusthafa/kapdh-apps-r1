import { type Db, JobRegistry, JobRunner } from "@kapdh/api/worker";
import { describe, expect, it } from "vitest";
import { InlineQueueDriver } from "../src/queue/inline-driver.js";
import type { LeaderLock } from "../src/scheduler/leader-lock.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { eventually, memoryLogger, T0, TestClock } from "./support/fixtures.js";

/** Kunci leader bersama di memori: meniru satu kunci advisory yang diperebutkan beberapa instance. */
class SharedLock {
  holder: string | null = null;
  failing = false;
  for(name: string): LeaderLock & { releases: number } {
    const lock = {
      releases: 0,
      tryAcquire: async () => {
        if (this.failing) throw Object.assign(new Error("connection terminated"), { code: "57P01" });
        if (this.holder === null) this.holder = name;
        return this.holder === name;
      },
      release: async () => {
        lock.releases++;
        if (this.holder === name) this.holder = null;
      },
      close: async () => undefined,
    };
    return lock;
  }
}

interface Instance {
  scheduler: Scheduler;
  queue: InlineQueueDriver;
  runs: { name: string; now: Date; jobId: string }[];
  logs: ReturnType<typeof memoryLogger>;
}

/**
 * Satu instance worker: JobRegistry asli dengan job uji (registri palsu) dan JobRunner asli, antrean inline. Job
 * menulis ke `runs` milik instance sehingga terlihat instance mana yang menjalankannya.
 */
async function instance(
  name: string,
  lock: SharedLock,
  clock: TestClock,
  options: {
    jobs?: { name: string; everyMs: number }[];
    gate?: () => Promise<void> | undefined;
    failFirst?: string;
  } = {},
): Promise<Instance & { lock: ReturnType<SharedLock["for"]> }> {
  const logs = memoryLogger();
  const registry = new JobRegistry();
  const runs: Instance["runs"] = [];
  let failed = false;
  for (const job of options.jobs ?? [
    { name: "reservations.expire", everyMs: 60_000 },
    { name: "events.lifecycle", everyMs: 300_000 },
  ]) {
    registry.registerScheduled({
      name: job.name,
      everyMs: job.everyMs,
      run: async (now, ctx) => {
        runs.push({ name: job.name, now, jobId: ctx.jobId });
        await options.gate?.();
        if (options.failFirst === job.name && !failed) {
          failed = true;
          throw new Error("deadlock detected");
        }
      },
    });
  }
  // runScheduled tidak menyentuh database; JobRunner asli dipakai agar konteks/log job sama dengan production.
  const jobs = new JobRunner(registry, {} as Db, clock, logs.logger);
  const queue = new InlineQueueDriver(logs.logger);
  const leader = lock.for(name);
  const scheduler = new Scheduler(
    { registry, jobs, queue, leader, clock, logger: logs.logger },
    { tickMs: 50, concurrency: 2, attempts: 3, backoffMs: 5, staggerMs: 0 },
  );
  scheduler.attach();
  await queue.start();
  return { scheduler, queue, runs, logs, lock: leader };
}

describe("Penjadwal job terdaftar dengan leader tunggal (ARCHITECTURE §4.8, PRD 5.1)", () => {
  it("ARCHITECTURE §4.8: leader menjalankan setiap job terdaftar sekali saat menjadi leader, lalu pada setiap batas slot", async () => {
    const clock = new TestClock(T0);
    const a = await instance("a", new SharedLock(), clock);
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.runs.map((run) => run.name).sort()).toEqual(["events.lifecycle", "reservations.expire"]);
    expect(a.scheduler.status()).toMatchObject({ role: "leader", lastTickAt: T0 });
    // N-14: setiap eksekusi memiliki job_id `<nama>:<uuid>` dan memakai waktu Clock.
    expect(a.runs[0]!.jobId).toMatch(/^(reservations\.expire|events\.lifecycle):[0-9a-f-]{36}$/);
    expect(a.runs[0]!.now).toEqual(T0);

    // Tick lain dalam slot yang sama: tidak ada eksekusi ganda.
    clock.advance(30_000);
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.runs).toHaveLength(2);

    // Batas slot 1 menit: hanya job per menit yang berjalan.
    clock.advance(30_000);
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.runs.map((run) => run.name)).toEqual(expect.arrayContaining(["reservations.expire"]));
    expect(a.runs.filter((run) => run.name === "reservations.expire")).toHaveLength(2);
    expect(a.runs.filter((run) => run.name === "events.lifecycle")).toHaveLength(1);

    // Batas 5 menit: keduanya.
    clock.set(new Date(T0.getTime() + 300_000));
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.runs.filter((run) => run.name === "events.lifecycle")).toHaveLength(2);
    const status = a.scheduler.status().jobs.find((job) => job.name === "events.lifecycle");
    expect(status).toMatchObject({
      everyMs: 300_000,
      lastStatus: "ok",
      nextDueAt: new Date(T0.getTime() + 600_000),
    });
    await a.queue.close(1_000);
  });

  it("PRD 5.1: dua instance berebut kunci — hanya leader yang menjadwalkan; standby mengambil alih setelah leader melepas kunci", async () => {
    const clock = new TestClock(T0);
    const lock = new SharedLock();
    const a = await instance("a", lock, clock);
    const b = await instance("b", lock, clock);
    await a.scheduler.tick();
    await b.scheduler.tick();
    await Promise.all([a.queue.drained(), b.queue.drained()]);
    expect(a.scheduler.status().role).toBe("leader");
    expect(b.scheduler.status().role).toBe("standby");
    expect(a.runs).toHaveLength(2);
    expect(b.runs).toHaveLength(0);
    // Standby tetap memeriksa kunci (loop hidup) tetapi tidak pernah menjadwalkan.
    expect(b.scheduler.status().lastLeaderCheckAt).toEqual(T0);
    expect(b.scheduler.status().lastTickAt).toBeNull();

    // Leader berhenti halus: melepas kunci; standby menjadi leader pada tick berikutnya.
    await a.scheduler.stop();
    await a.scheduler.resign();
    expect(a.lock.releases).toBe(1);
    expect(a.scheduler.status().role).toBe("standby");
    clock.advance(1_000);
    await b.scheduler.tick();
    await b.queue.drained();
    expect(b.scheduler.status().role).toBe("leader");
    expect(b.runs.map((run) => run.name).sort()).toEqual(["events.lifecycle", "reservations.expire"]);
    expect(b.logs.lines.some((line) => line.msg === "instance ini menjadi leader penjadwal")).toBe(true);
    await Promise.all([a.queue.close(1_000), b.queue.close(1_000)]);
  });

  it("PRD 5.1: kunci leader hilang (koneksi putus) → instance berhenti menjadwalkan; galat dicatat aman sekali", async () => {
    const clock = new TestClock(T0);
    const lock = new SharedLock();
    const a = await instance("a", lock, clock);
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.scheduler.status().role).toBe("leader");
    lock.failing = true;
    clock.advance(60_000);
    await a.scheduler.tick();
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.scheduler.status().role).toBe("standby");
    expect(a.runs).toHaveLength(2);
    const errors = a.logs.lines.filter((line) =>
      String(line.msg).startsWith("pemeriksaan kunci leader penjadwal gagal"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: "error", error: { error_code: "57P01" } });
    expect(
      a.logs.lines.some((line) => line.msg === "kunci leader penjadwal hilang; instance ini menjadi standby"),
    ).toBe(true);
    await a.queue.close(1_000);
  });

  it("job yang masih berjalan tidak ditumpuk: slot berikutnya dilewati sampai run sebelumnya selesai", async () => {
    const clock = new TestClock(T0);
    let release!: () => void;
    let gate: Promise<void> | undefined = new Promise<void>((resolve) => (release = resolve));
    const a = await instance("a", new SharedLock(), clock, {
      jobs: [{ name: "account.deletion", everyMs: 60_000 }],
      gate: () => gate,
    });
    await a.scheduler.tick();
    await eventually(() => a.runs.length === 1);
    clock.advance(60_000);
    await a.scheduler.tick();
    clock.advance(60_000);
    await a.scheduler.tick();
    expect(a.runs).toHaveLength(1);
    expect(
      a.logs.lines.filter((line) => line.msg === "run sebelumnya masih berjalan; slot jadwal dilewati"),
    ).toHaveLength(2);
    gate = undefined;
    release();
    await a.queue.drained();
    clock.advance(60_000);
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.runs).toHaveLength(2);
    await a.queue.close(1_000);
  });

  it("job terjadwal yang gagal dicoba ulang (backoff) dan statusnya tercatat untuk health", async () => {
    const clock = new TestClock(T0);
    const a = await instance("a", new SharedLock(), clock, {
      jobs: [{ name: "notifications.retry", everyMs: 60_000 }],
      failFirst: "notifications.retry",
    });
    await a.scheduler.tick();
    await a.queue.drained();
    expect(a.runs).toHaveLength(2);
    expect(a.scheduler.status().jobs[0]).toMatchObject({ name: "notifications.retry", lastStatus: "ok" });
    const failure = a.logs.lines.find((line) => line.msg === "job terjadwal gagal");
    expect(failure).toMatchObject({ level: "error", job: "notifications.retry" });
    expect(String(failure!.job_id)).toMatch(/^notifications\.retry:/);
    expect(JSON.stringify(a.logs.lines)).not.toContain("deadlock detected");
    await a.queue.close(1_000);
  });

  it("loop tick berjalan sendiri setiap tickMs dan berhenti saat stop()", async () => {
    const clock = new TestClock(T0);
    const a = await instance("a", new SharedLock(), clock);
    a.scheduler.start();
    await eventually(() => a.runs.length === 2);
    expect(a.scheduler.status().running).toBe(true);
    await a.scheduler.stop();
    expect(a.scheduler.status().running).toBe(false);
    clock.advance(600_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.runs).toHaveLength(2);
    await a.queue.close(1_000);
  });
});
