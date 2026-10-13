import { loadWorkerEnv } from "@kapdh/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueUnavailableError } from "../../src/queue/queue-driver.js";
import { bootWorker, type WorkerService } from "../../src/runtime.js";
import { FakeRedis } from "../support/fake-redis.js";
import { eventually, memoryLogger } from "../support/fixtures.js";
import { createWorkerPgDatabase, type WorkerPgDatabase } from "./support.js";

let tdb: WorkerPgDatabase;
let storageRoot: string;

beforeAll(async () => {
  tdb = await createWorkerPgDatabase("runtime");
  storageRoot = mkdtempSync(join(tmpdir(), "kapdh-worker-storage-"));
});
afterAll(async () => {
  await tdb.drop();
  rmSync(storageRoot, { recursive: true, force: true });
});

/** WorkerEnv seperti production minus secret API: DATABASE_URL role kapdh_worker, tanpa Redis (antrean inline). */
function env(extra: Record<string, string> = {}) {
  return loadWorkerEnv({
    NODE_ENV: "test",
    DATABASE_URL: tdb.workerUrl,
    LOG_LEVEL: "info",
    FILE_URL_SECRET: "rahasia-berkas-uji-minimal-32-karakter!!",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_ROOT: storageRoot,
    WORKER_CONCURRENCY: "2",
    WORKER_HEALTH_PORT: "0",
    WORKER_HEALTH_HOST: "127.0.0.1",
    OUTBOX_POLL_INTERVAL_MS: "250",
    WORKER_SHUTDOWN_TIMEOUT_MS: "10000",
    ...extra,
  });
}

async function health(worker: WorkerService) {
  const res = await fetch(`http://127.0.0.1:${worker.healthAddress()!.port}/healthz`);
  return {
    status: res.status,
    body: (await res.json()) as {
      status: string;
      issues: string[];
      checks: { scheduler: { role: string }; queue: { ok: boolean; driver: string } };
    },
  };
}

async function workerConnections(): Promise<string[]> {
  const rows = await tdb.admin<{ application_name: string }[]>`
    select application_name from pg_stat_activity
    where datname = current_database() and application_name like 'kapdh-worker%' order by 1`;
  return rows.map((row) => row.application_name);
}

describe("Worker production lengkap (createWorkerDeps + createWorkerContext, role kapdh_worker, PostgreSQL 17)", () => {
  it("PRD 5.1, 5.5: dua instance worker — tepat satu leader penjadwal, health 200, leader berhenti halus → instance lain mengambil alih", async () => {
    const logsA = memoryLogger("info");
    const logsB = memoryLogger("info");
    const a = await bootWorker(env(), { logger: logsA.logger });
    let b: WorkerService | null = null;
    try {
      await eventually(async () => (await health(a)).body.checks.scheduler.role === "leader", 15_000);
      b = await bootWorker(env(), { logger: logsB.logger });
      const second = b;
      await eventually(async () => (await health(second)).status === 200, 15_000);
      // Standby memeriksa kunci tetapi tidak menjadi leader selama a hidup.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect((await health(a)).body.checks.scheduler.role).toBe("leader");
      expect((await health(second)).body.checks.scheduler.role).toBe("standby");
      const healthA = await health(a);
      expect(healthA.status).toBe(200);
      expect(healthA.body).toMatchObject({
        status: "ok",
        checks: {
          database: { ok: true },
          queue: { ok: true, driver: "inline" },
          outbox: { pending: 0, dead: 0 },
        },
      });
      // Job yang didaftarkan modul (WORKER_MODULES) dijadwalkan leader dan berjalan sebagai kapdh_worker.
      const started = logsA.lines.find((line) => line.msg === "worker berjalan");
      expect(started?.scheduled_jobs).toEqual(expect.arrayContaining(["files.cleanup-temp"]));
      await eventually(
        () =>
          logsA.lines.some(
            (line) => line.msg === "job terjadwal selesai" && line.job === "files.cleanup-temp",
          ),
        15_000,
      );
      expect(logsB.lines.some((line) => line.msg === "job terjadwal selesai")).toBe(false);
      // Koneksi khusus: kunci leader dan health per instance (selain pool kerja).
      expect(await workerConnections()).toEqual(
        expect.arrayContaining(["kapdh-worker", "kapdh-worker-health", "kapdh-worker-leader"]),
      );

      // Leader berhenti halus (SIGTERM): melepas kunci; instance lain menjadi leader dalam beberapa tick.
      expect(await a.stop("SIGTERM")).toEqual({ graceful: true, reason: "SIGTERM" });
      await eventually(async () => (await health(second)).body.checks.scheduler.role === "leader", 15_000);
      await eventually(
        () =>
          logsB.lines.some(
            (line) => line.msg === "job terjadwal selesai" && line.job === "files.cleanup-temp",
          ),
        15_000,
      );
      // N-14: tidak ada URL koneksi/sandi atau secret di log.
      const text = JSON.stringify([...logsA.lines, ...logsB.lines]);
      expect(text).not.toContain("postgres://");
      expect(text).not.toContain("rahasia-berkas");
    } finally {
      await a.stop("uji");
      await b?.stop("uji");
    }
    // Shutdown menutup semua koneksi worker (pool kerja, health, kunci leader).
    await eventually(async () => (await workerConnections()).length === 0, 10_000);
  });

  it("PRD 5.1: event outbox yang di-commit sebelum worker hidup tetap diklaim dan diproses setelah worker start", async () => {
    const eventId = "0190a6f2-cccc-7000-8000-000000000001";
    const outboxId = "0190a6f2-dddd-7000-8000-000000000001";
    // Topik dengan atau tanpa handler terdaftar: dispatcher tetap mengklaimnya (attempts bertambah, lease dilepas).
    await tdb.admin`
      insert into app.outbox_events (id, topic, dedup_key, payload, status, attempts, next_attempt_at, created_at)
      values (${outboxId}, 'event.cancelled', ${`event.cancelled:${eventId}`},
              ${JSON.stringify({ event_id: eventId })}::jsonb, 'pending', 0, now(), now())`;
    const worker = await bootWorker(env(), { logger: memoryLogger("warn").logger });
    try {
      await eventually(async () => {
        const [row] = await tdb.admin<{ attempts: number; locked_until: Date | null; status: string }[]>`
          select attempts, locked_until, status from app.outbox_events where id = ${outboxId}`;
        return row!.attempts >= 1 && row!.locked_until === null && row!.status !== "pending";
      }, 15_000);
    } finally {
      await worker.stop("uji");
    }
  });

  it("PRD 5.1: REDIS_URL diisi tetapi Redis mati saat boot → bootWorker gagal setelah batas tunggu (proses keluar non-zero dan dijalankan ulang) tanpa menyisakan koneksi", async () => {
    const redis = new FakeRedis();
    await redis.reservePort();
    const logs = memoryLogger("info");
    const started = performance.now();
    await expect(
      bootWorker(env({ REDIS_URL: redis.url }), {
        logger: logs.logger,
        adjustSettings: (settings) => ({ ...settings, queue: { ...settings.queue, readyTimeoutMs: 1_500 } }),
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(logs.lines.some((line) => String(line.msg).startsWith("worker gagal start"))).toBe(true);
    expect(logs.lines.some((line) => line.msg === "worker berjalan")).toBe(false);
    await eventually(async () => (await workerConnections()).length === 0, 10_000);
  });

  it("PRD 5.1, 5.5: driver BullMQ — boot berhasil, health 200; Redis putus → 503 queue_unreachable tanpa menggantung; Redis kembali → 200 tanpa restart", async () => {
    const redis = new FakeRedis();
    await redis.start();
    const worker = await bootWorker(env({ REDIS_URL: redis.url }), {
      logger: memoryLogger("warn").logger,
      adjustSettings: (settings) => ({
        ...settings,
        queue: { readyTimeoutMs: 5_000, operationTimeoutMs: 1_000 },
      }),
    });
    try {
      await eventually(async () => (await health(worker)).status === 200, 15_000);
      expect((await health(worker)).body).toMatchObject({
        status: "ok",
        checks: { queue: { ok: true, driver: "bullmq" } },
      });

      await redis.stop();
      await eventually(async () => {
        const report = await health(worker);
        return report.status === 503 && report.body.issues.includes("queue_unreachable");
      }, 15_000);

      await redis.start();
      await eventually(async () => (await health(worker)).status === 200, 20_000);
      expect((await health(worker)).body.checks.queue).toEqual({ ok: true, driver: "bullmq" });
    } finally {
      expect((await worker.stop("uji")).reason).toBe("uji");
      await redis.stop();
    }
    await eventually(async () => (await workerConnections()).length === 0, 10_000);
  });
});
