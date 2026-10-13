import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherStatus } from "../src/outbox/dispatcher.js";
import {
  buildHealthReport,
  createDbHealthProbes,
  type HealthInputs,
  httpStatusFor,
} from "../src/health/health.js";
import { HealthServer } from "../src/health/health-server.js";
import type { SchedulerStatus } from "../src/scheduler/scheduler.js";
import {
  clearOutbox,
  createTestDatabase,
  insertOutboxEvent,
  memoryLogger,
  T0,
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

function dispatcherStatus(clock: TestClock, overrides: Partial<DispatcherStatus> = {}): DispatcherStatus {
  return {
    running: true,
    lastLoopAt: clock.now(),
    lastPollOkAt: clock.now(),
    consecutiveFailures: 0,
    totals: { claimed: 3, released: 0, dispatched: 3, failed: 0, dead: 0, lost: 0 },
    ...overrides,
  };
}

function schedulerStatus(clock: TestClock, overrides: Partial<SchedulerStatus> = {}): SchedulerStatus {
  return {
    running: true,
    role: "leader",
    lastTickAt: clock.now(),
    lastLeaderCheckAt: clock.now(),
    jobs: [
      {
        name: "reservations.expire",
        everyMs: 60_000,
        nextDueAt: new Date(clock.now().getTime() + 60_000),
        lastEnqueuedAt: clock.now(),
        lastStartedAt: clock.now(),
        lastFinishedAt: clock.now(),
        lastStatus: "ok",
      },
    ],
    ...overrides,
  };
}

function inputs(clock: TestClock, overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    clock,
    startedAt: new Date(clock.now().getTime() - 60_000),
    stopping: false,
    probes: createDbHealthProbes(tdb.db),
    queue: { kind: "inline", ping: async () => true },
    dispatcher: dispatcherStatus(clock),
    scheduler: schedulerStatus(clock),
    pollIntervalMs: 2_000,
    tickMs: 1_000,
    outboxLagDegradedSeconds: 300,
    ...overrides,
  };
}

describe("Health worker (PRD 5.5: DB, umur job/outbox tertua, tick penjadwal)", () => {
  it("PRD 5.5: melaporkan DB ok, umur outbox pending tertua, keterlambatan jatuh tempo, dead, dan tick penjadwal terakhir", async () => {
    const clock = new TestClock(T0);
    // Pending tertua dibuat 10 menit lalu tetapi baru jatuh tempo 30 detik lalu (backoff); event dispatched diabaikan.
    await insertOutboxEvent(tdb.db, clock, {
      status: "failed",
      attempts: 2,
      createdAt: new Date(T0.getTime() - 600_000),
      nextAttemptAt: new Date(T0.getTime() - 30_000),
    });
    await insertOutboxEvent(tdb.db, clock, { createdAt: new Date(T0.getTime() - 5_000) });
    // Sedang diklaim (lease berlaku): tidak dihitung terlambat.
    await insertOutboxEvent(tdb.db, clock, {
      createdAt: new Date(T0.getTime() - 900_000),
      nextAttemptAt: new Date(T0.getTime() - 900_000),
      lockedUntil: new Date(T0.getTime() + 60_000),
    });
    await insertOutboxEvent(tdb.db, clock, {
      status: "dispatched",
      createdAt: new Date(T0.getTime() - 86_400_000),
    });

    const report = await buildHealthReport(inputs(clock));
    expect(report.status).toBe("ok");
    expect(httpStatusFor(report.status)).toBe(200);
    expect(report.issues).toEqual([]);
    expect(report.checks.database.ok).toBe(true);
    expect(report.checks.database.latency_ms).toEqual(expect.any(Number));
    expect(report.checks.outbox).toMatchObject({
      ok: true,
      pending: 3,
      dead: 0,
      oldest_pending_age_seconds: 900,
      oldest_due_lag_seconds: 30,
    });
    expect(report.checks.scheduler).toMatchObject({
      ok: true,
      role: "leader",
      last_tick_at: T0.toISOString(),
      jobs: [{ name: "reservations.expire", every_ms: 60_000, last_status: "ok" }],
    });
    expect(report.checks.queue).toEqual({ ok: true, driver: "inline" });
  });

  it("PRD 5.5: backlog outbox melewati ambang atau event dead → degraded (HTTP 200, alert tanpa restart)", async () => {
    const clock = new TestClock(T0);
    await insertOutboxEvent(tdb.db, clock, {
      createdAt: new Date(T0.getTime() - 400_000),
      nextAttemptAt: new Date(T0.getTime() - 400_000),
    });
    const lagging = await buildHealthReport(inputs(clock));
    expect(lagging.status).toBe("degraded");
    expect(lagging.issues).toEqual(["outbox_lagging"]);
    expect(httpStatusFor(lagging.status)).toBe(200);

    await clearOutbox(tdb.db);
    await insertOutboxEvent(tdb.db, clock, { status: "dead", attempts: 10 });
    const dead = await buildHealthReport(inputs(clock));
    expect(dead).toMatchObject({ status: "degraded", issues: ["outbox_dead_events"] });
    expect(dead.checks.outbox).toMatchObject({ pending: 0, dead: 1, oldest_pending_age_seconds: null });
  });

  it("PRD 5.5: database/antrean tidak terjangkau atau loop macet → error (HTTP 503); stopping saat shutdown", async () => {
    const clock = new TestClock(T0);
    const { logger, lines } = memoryLogger();
    const down = await buildHealthReport(
      inputs(clock, {
        probes: {
          database: async () => {
            throw Object.assign(
              new Error("connect ECONNREFUSED postgres://kapdh_worker:rahasia@db:5432/kapdh"),
              {
                code: "ECONNREFUSED",
              },
            );
          },
          outbox: async () => {
            throw new Error("tidak tersambung");
          },
        },
        queue: { kind: "bullmq", ping: async () => false },
        onProbeError: (probe, error) => logger.warn({ probe, error }, "pemeriksaan health gagal"),
      }),
    );
    expect(down.status).toBe("error");
    expect(httpStatusFor(down.status)).toBe(503);
    expect(down.issues).toEqual(["database_unreachable", "queue_unreachable"]);
    expect(down.checks.database).toEqual({ ok: false, latency_ms: null });
    // N-14: URL koneksi/sandi dalam pesan galat tidak pernah masuk laporan maupun log.
    expect(JSON.stringify(down)).not.toContain("rahasia");
    expect(JSON.stringify(lines)).not.toContain("rahasia");
    expect(lines.find((line) => line.probe === "database")).toMatchObject({
      error: { error_code: "ECONNREFUSED" },
    });

    const stalled = await buildHealthReport(
      inputs(clock, {
        dispatcher: dispatcherStatus(clock, { lastLoopAt: new Date(T0.getTime() - 120_000) }),
        scheduler: schedulerStatus(clock, { lastLeaderCheckAt: new Date(T0.getTime() - 120_000) }),
      }),
    );
    expect(stalled).toMatchObject({ status: "error", issues: ["dispatcher_stalled", "scheduler_stalled"] });

    // Masa tenggang start: loop yang belum sempat berputar tidak dianggap macet.
    const fresh = await buildHealthReport(
      inputs(clock, {
        startedAt: new Date(T0.getTime() - 1_000),
        dispatcher: dispatcherStatus(clock, { lastLoopAt: null, lastPollOkAt: null }),
        scheduler: schedulerStatus(clock, { lastLeaderCheckAt: null, lastTickAt: null, role: "standby" }),
      }),
    );
    expect(fresh.status).toBe("ok");

    const stopping = await buildHealthReport(inputs(clock, { stopping: true }));
    expect(stopping.status).toBe("stopping");
    expect(httpStatusFor(stopping.status)).toBe(503);
  });

  it("PRD 5.5: GET/HEAD /healthz melayani JSON no-store; path lain 404, metode lain 405", async () => {
    const clock = new TestClock(T0);
    let status: "ok" | "error" = "ok";
    const server = new HealthServer(async () => {
      const report = await buildHealthReport(inputs(clock));
      return status === "ok" ? report : { ...report, status: "error", issues: ["database_unreachable"] };
    }, memoryLogger().logger);
    const address = await server.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const ok = await fetch(`${base}/healthz?verbose=1`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("application/json");
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toMatchObject({ status: "ok", service: "kapdh-worker" });

      status = "error";
      const failing = await fetch(`${base}/healthz`);
      expect(failing.status).toBe(503);
      expect(await failing.json()).toMatchObject({ status: "error", issues: ["database_unreachable"] });

      const head = await fetch(`${base}/healthz`, { method: "HEAD" });
      expect(head.status).toBe(503);
      expect(await head.text()).toBe("");

      expect((await fetch(`${base}/metrics`)).status).toBe(404);
      const post = await fetch(`${base}/healthz`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      await server.close();
    }
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});
