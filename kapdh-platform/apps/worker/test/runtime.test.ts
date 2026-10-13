import { loadWorkerEnv } from "@kapdh/config";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbHealthProbes } from "../src/health/health.js";
import { InlineQueueDriver } from "../src/queue/inline-driver.js";
import { type NamedResource, WorkerService } from "../src/runtime.js";
import type { LeaderLock } from "../src/scheduler/leader-lock.js";
import { resolveWorkerSettings, type WorkerSettings } from "../src/settings.js";
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

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://kapdh_worker:x@127.0.0.1:5432/kapdh",
  FILE_URL_SECRET: "rahasia-berkas-uji-minimal-32-karakter!!",
};

function settings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  const base = resolveWorkerSettings(
    loadWorkerEnv({
      ...BASE_ENV,
      WORKER_HEALTH_PORT: "0",
      WORKER_HEALTH_HOST: "127.0.0.1",
      OUTBOX_POLL_INTERVAL_MS: "250",
      WORKER_SHUTDOWN_TIMEOUT_MS: "2000",
    }),
  );
  return { ...base, scheduler: { ...base.scheduler, tickMs: 100 }, ...overrides };
}

function build(options: { settings?: WorkerSettings; order?: string[]; leaseMs?: number } = {}) {
  const order = options.order ?? [];
  const clock = new TestClock();
  const logs = memoryLogger();
  const fake = fakeRegistry();
  let scheduledRuns = 0;
  fake.registry.registerScheduled({
    name: "files.cleanup-temp",
    everyMs: 3_600_000,
    run: async () => void scheduledRuns++,
  });
  const jobs = createJobRunner(fake.registry, tdb.db, clock, logs.logger);
  const queue = new InlineQueueDriver(logs.logger);
  const originalClose = queue.close.bind(queue);
  queue.close = async (timeoutMs: number) => {
    order.push("queue.close:start");
    const result = await originalClose(timeoutMs);
    order.push("queue.close:end");
    return result;
  };
  let held = false;
  const leader: LeaderLock = {
    tryAcquire: async () => (held = true),
    release: async () => {
      held = false;
      order.push("leader.release");
    },
    close: async () => undefined,
  };
  const resources: NamedResource[] = [
    { name: "koneksi kunci leader", close: async () => void order.push("close:leader") },
    { name: "konteks Nest worker", close: async () => void order.push("close:nest") },
    { name: "adapter", close: async () => void order.push("close:adapter") },
  ];
  const base = options.settings ?? settings();
  const service = new WorkerService({
    settings: options.leaseMs ? { ...base, outbox: { ...base.outbox, leaseMs: options.leaseMs } } : base,
    logger: logs.logger,
    clock,
    jobs,
    registry: fake.registry,
    queue,
    leader,
    probes: createDbHealthProbes(tdb.db),
    resources,
  });
  return {
    service,
    clock,
    logs,
    fake,
    jobs,
    queue,
    order,
    isLeader: () => held,
    scheduledRuns: () => scheduledRuns,
  };
}

async function getHealth(service: WorkerService) {
  const address = service.healthAddress()!;
  const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("Runtime worker (ARCHITECTURE §4.8, PRD 5.1, 5.5)", () => {
  it("PRD 5.1: start → dispatcher memproses outbox, penjadwal (leader) menjalankan job terdaftar, health 200", async () => {
    const w = build();
    await w.service.start();
    try {
      const id = await insertOutboxEvent(tdb.db, w.clock);
      await eventually(async () => (await outboxRow(tdb.db, id)).status === "dispatched");
      await eventually(() => w.scheduledRuns() === 1);
      expect(w.isLeader()).toBe(true);
      const health = await getHealth(w.service);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        status: "ok",
        checks: {
          database: { ok: true },
          queue: { ok: true, driver: "inline" },
          outbox: { pending: 0, dead: 0, dispatcher: { running: true } },
          scheduler: { role: "leader", running: true },
        },
      });
      const started = w.logs.lines.find((line) => line.msg === "worker berjalan");
      expect(started).toMatchObject({
        service: "kapdh-worker",
        queue_driver: "inline",
        scheduled_jobs: ["files.cleanup-temp"],
        topics: ["event.cancelled", "audit.export.requested"],
      });
      // Konfigurasi sensitif tidak pernah dicatat (N-14).
      expect(JSON.stringify(w.logs.lines)).not.toContain("postgres://");
    } finally {
      await w.service.stop("uji");
    }
  });

  it("PRD 5.5: shutdown halus — berhenti poll, health 'stopping', menunggu job berjalan, lalu melepas leader dan menutup sumber daya berurutan", async () => {
    const order: string[] = [];
    const w = build({ order });
    await w.service.start();
    w.fake.hold();
    const id = await insertOutboxEvent(tdb.db, w.clock);
    await eventually(() => w.fake.calls.length === 1);

    const stopping = w.service.stop("SIGTERM");
    await eventually(() => order.includes("queue.close:start"));
    expect(w.service.dispatcher.status().running).toBe(false);
    expect(w.service.scheduler.status().running).toBe(false);
    const during = await getHealth(w.service);
    expect(during).toMatchObject({ status: 503, body: { status: "stopping" } });
    // Event baru setelah stop tidak diklaim lagi oleh instance ini.
    const late = await insertOutboxEvent(tdb.db, w.clock);

    w.fake.release();
    expect(await stopping).toEqual({ graceful: true, reason: "SIGTERM" });
    expect(order).toEqual([
      "queue.close:start",
      "queue.close:end",
      "leader.release",
      "close:leader",
      "close:nest",
      "close:adapter",
    ]);
    expect(await outboxRow(tdb.db, id)).toMatchObject({ status: "dispatched" });
    expect(await outboxRow(tdb.db, late)).toMatchObject({
      status: "pending",
      lockedUntil: null,
      attempts: 0,
    });
    expect(w.service.healthAddress()).toBeNull();
    // Idempoten: panggilan kedua mengembalikan hasil yang sama tanpa menutup ulang.
    expect(await w.service.stop("SIGINT")).toEqual({ graceful: true, reason: "SIGTERM" });
    expect(order.filter((step) => step === "close:adapter")).toHaveLength(1);
    expect(w.logs.lines.find((line) => line.msg === "worker berhenti")).toMatchObject({ graceful: true });
  });

  it("PRD 5.1: batas waktu shutdown habis → graceful=false, event yang belum selesai tidak hilang (diklaim ulang setelah lease)", async () => {
    const w = build({ settings: settings({ shutdownTimeoutMs: 200 }), leaseMs: 60_000 });
    await w.service.start();
    w.fake.hold();
    const id = await insertOutboxEvent(tdb.db, w.clock);
    await eventually(() => w.fake.calls.length === 1);
    expect(await w.service.stop("SIGTERM")).toEqual({ graceful: false, reason: "SIGTERM" });
    expect(w.logs.lines.some((line) => String(line.msg).startsWith("batas waktu shutdown habis"))).toBe(true);
    const leased = await outboxRow(tdb.db, id);
    expect(leased).toMatchObject({ status: "pending", attempts: 1 });
    expect(leased.lockedUntil).not.toBeNull();

    // Proses lain setelah lease habis: event diklaim ulang dan selesai sekali (handler idempoten, PRD 5.1).
    const next = build();
    next.clock.set(new Date(leased.lockedUntil!.getTime() + 1));
    const [claim] = await next.jobs.claimOutbox({ limit: 10, lockMs: 60_000 });
    expect(claim).toMatchObject({ id, attempts: 2 });
    expect(await next.jobs.processOutboxClaim(claim!, { lockMs: 60_000 })).toBe("dispatched");
    // Handler lama yang akhirnya selesai tidak menimpa hasil klaim baru (token lease/fencing).
    w.fake.release();
    await eventually(() =>
      w.logs.lines.some((line) => String(line.msg).startsWith("lease outbox hilang sebelum hasil dicatat")),
    );
    expect(await outboxRow(tdb.db, id)).toMatchObject({ status: "dispatched", attempts: 2 });
  });

  it("PRD 5.5: poll outbox gagal setiap iterasi walau DB dan antrean menjawab ping → /healthz 503 dispatcher_failing setelah batas macet (worker dijalankan ulang)", async () => {
    const w = build();
    // Antrean menolak setiap hitungan slot (mis. Redis menolak perintah walau PING lolos).
    w.queue.capacity = async () => {
      throw Object.assign(new Error("READONLY You can't write against a read only replica."), {
        code: "READONLY",
      });
    };
    await w.service.start();
    try {
      await eventually(() => w.service.dispatcher.status().consecutiveFailures >= 2);
      const early = await getHealth(w.service);
      expect(early.status).toBe(200);
      // Lewat batas macet di jam aplikasi; loop tetap berputar (last_loop_at segar) tetapi tidak ada poll berhasil.
      w.clock.advance(121_000);
      await eventually(async () => {
        const health = await getHealth(w.service);
        return health.status === 503 && (health.body.issues as string[]).join() === "dispatcher_failing";
      });
      const failing = await getHealth(w.service);
      expect(failing.body).toMatchObject({
        status: "error",
        issues: ["dispatcher_failing"],
        checks: { database: { ok: true }, queue: { ok: true }, outbox: { ok: false } },
      });
    } finally {
      await w.service.stop("uji");
    }
  });

  it("start gagal (port health dipakai) → komponen yang sudah berjalan dihentikan dan sumber daya ditutup", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    const order: string[] = [];
    const base = settings();
    const w = build({ order, settings: { ...base, health: { ...base.health, port } } });
    try {
      await expect(w.service.start()).rejects.toThrow(/EADDRINUSE/);
      expect(order).toContain("close:adapter");
      expect(w.service.running).toBe(false);
      expect(w.logs.lines.some((line) => String(line.msg).startsWith("worker gagal start"))).toBe(true);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
