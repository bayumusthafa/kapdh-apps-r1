import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import type { WorkerEnv } from "@kapdh/config";
import { auditLogs, outboxEvents } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { ctx, runAsSystem, tryCtx } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRegistry, type OutboxEvent } from "../../src/core/jobs/job-registry.js";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "../../src/core/jobs/job-runner.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { OutboxService } from "../../src/core/outbox/outbox.service.js";
import { PaymentHandlerRegistry } from "../../src/core/payments-kernel/payment-handler.registry.js";
import { QrTokenService } from "../../src/core/qr/qr-token.service.js";
import { DB } from "../../src/core/tokens.js";
import { createWorkerContext } from "../../src/worker.js";
import {
  createTestApp,
  createTestDatabase,
  FakePush,
  type TestApp,
  TestClock,
  testEnv,
} from "../support/test-app.js";

/** Keadaan handler penguji: kegagalan terjadwal dan catatan eksekusi. */
const probe = {
  failures: 0,
  calls: [] as {
    payload: unknown;
    meta: Omit<OutboxEvent, "payload">;
    requestId: string;
    jobId: string | null;
    actor: string;
  }[],
  ticks: [] as { jobId: string | null; actor: string; now: Date; contextJobId: string }[],
};

@Injectable()
class JobsProbe implements OnModuleInit {
  constructor(
    private readonly jobs: JobRegistry,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  onModuleInit() {
    this.jobs.registerTopicHandler({
      topic: "event.cancelled",
      handle: async (event, job) => {
        const context = ctx();
        const { payload, ...meta } = event;
        probe.calls.push({
          payload,
          meta,
          requestId: context.requestId,
          jobId: context.jobId,
          actor: context.actor.kind,
        });
        expect(job.jobId).toBe(context.jobId);
        if (probe.failures > 0) {
          probe.failures--;
          throw Object.assign(new Error(`gagal kirim ke rahasia@contoh.test`), { code: "ECONNRESET" });
        }
        // Efek handler beraudit: aktor system, request_id = request asal event (korelasi N-14).
        await withTx(this.db, (tx) =>
          this.audit.write(tx, {
            action: "uji.event_fanout",
            entityType: "event",
            entityId: payload.event_id,
          }),
        );
      },
    });
    this.jobs.registerScheduled({
      name: "uji.tick",
      everyMs: 60_000,
      run: async (now, job) => {
        probe.ticks.push({
          jobId: tryCtx()?.jobId ?? null,
          actor: tryCtx()?.actor.kind ?? "tidak ada",
          now,
          contextJobId: job.jobId,
        });
      },
    });
  }
}

@Module({ providers: [JobsProbe] })
class JobsProbeModule {}

let t: TestApp;
let outbox: OutboxService;

beforeAll(async () => {
  t = await createTestApp({ extraModules: [JobsProbeModule] });
  outbox = t.app.get(OutboxService);
});
beforeEach(async () => {
  probe.failures = 0;
  probe.calls.length = 0;
  probe.ticks.length = 0;
  await t.db.delete(outboxEvents);
});
afterAll(async () => {
  await t.app.close();
});

async function eventRow(id: string) {
  const [row] = await t.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  return row!;
}

describe("OutboxService.publish (AC F04-1, ARCHITECTURE §4.7)", () => {
  it("ditulis dalam transaksi bisnis dengan request_id konteks; dedupKey yang sama tidak menggandakan event", async () => {
    const eventId = uuidv7();
    const first = await runAsSystem(
      () =>
        withTx(t.db, (tx) =>
          outbox.publish(tx, {
            topic: "event.cancelled",
            dedupKey: `event.cancelled:${eventId}`,
            payload: { event_id: eventId },
          }),
        ),
      { requestId: "req-asal-1" },
    );
    expect(first).toEqual(expect.any(String));
    const again = await outbox.publish(t.db, {
      topic: "event.cancelled",
      dedupKey: `event.cancelled:${eventId}`,
      payload: { event_id: eventId },
    });
    expect(again).toBeNull();
    expect(await eventRow(first!)).toMatchObject({
      topic: "event.cancelled",
      status: "pending",
      attempts: 0,
      requestId: "req-asal-1",
      payload: { event_id: eventId },
      nextAttemptAt: t.clock.now(),
    });
  });

  it("transaksi batal tidak meninggalkan event", async () => {
    const eventId = uuidv7();
    await expect(
      withTx(t.db, async (tx) => {
        await outbox.publish(tx, {
          topic: "event.cancelled",
          dedupKey: `x:${eventId}`,
          payload: { event_id: eventId },
        });
        throw new Error("batal");
      }),
    ).rejects.toThrow("batal");
    expect(await t.db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("payload di luar katalog topik ditolak sebelum tersimpan (tanpa PII di outbox)", async () => {
    await expect(
      outbox.publish(t.db, {
        topic: "event.cancelled",
        dedupKey: "x",
        payload: { event_id: uuidv7(), email: "rahasia@contoh.test" } as never,
      }),
    ).rejects.toThrow();
    await expect(
      outbox.publish(t.db, { topic: "event.cancelled", dedupKey: "", payload: { event_id: uuidv7() } }),
    ).rejects.toThrow();
    expect(await t.db.select().from(outboxEvents)).toHaveLength(0);
  });
});

describe("JobRunner.dispatchOutbox (ARCHITECTURE §4.8, PRD 5.1)", () => {
  it("handler dijalankan sebagai aktor system dengan request_id asal event; event menjadi dispatched", async () => {
    const eventId = uuidv7();
    const id = await runAsSystem(
      () =>
        outbox.publish(t.db, {
          topic: "event.cancelled",
          dedupKey: `d:${eventId}`,
          payload: { event_id: eventId },
        }),
      { requestId: "req-asal-2" },
    );
    const result = await t.jobs.dispatchOutbox();
    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0 });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toMatchObject({
      payload: { event_id: eventId },
      meta: { id, topic: "event.cancelled", attempts: 1, requestId: "req-asal-2" },
      requestId: "req-asal-2",
      jobId: `outbox:${id}`,
      actor: "system",
    });
    expect(await eventRow(id!)).toMatchObject({
      status: "dispatched",
      dispatchedAt: t.clock.now(),
      lockedUntil: null,
    });
    const [audit] = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, eventId));
    expect(audit).toMatchObject({ effectiveRole: "system", requestId: "req-asal-2", actorUserId: null });
    // Sudah terkirim: tidak diklaim lagi.
    expect((await t.jobs.dispatchOutbox()).claimed).toBe(0);
  });

  it("handler gagal: failed + backoff + last_error aman (tanpa pesan); dicoba ulang setelah jatuh tempo", async () => {
    probe.failures = 1;
    const eventId = uuidv7();
    const id = await outbox.publish(t.db, {
      topic: "event.cancelled",
      dedupKey: `f:${eventId}`,
      payload: { event_id: eventId },
    });
    expect(await t.jobs.dispatchOutbox()).toEqual({ claimed: 1, dispatched: 0, failed: 1, dead: 0 });
    const failed = await eventRow(id!);
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      lockedUntil: null,
      lastError: "Error:ECONNRESET",
    });
    expect(failed.lastError).not.toContain("rahasia");
    expect(failed.nextAttemptAt.getTime()).toBe(t.clock.now().getTime() + outboxBackoffMs(1));
    // Belum jatuh tempo.
    expect((await t.jobs.dispatchOutbox()).claimed).toBe(0);
    t.clock.advance(outboxBackoffMs(1));
    expect(await t.jobs.dispatchOutbox()).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0 });
    expect((await eventRow(id!)).attempts).toBe(2);
  });

  it("setelah percobaan maksimum event menjadi dead (butuh tindakan operator)", async () => {
    probe.failures = OUTBOX_MAX_ATTEMPTS;
    const eventId = uuidv7();
    const id = await outbox.publish(t.db, {
      topic: "event.cancelled",
      dedupKey: `m:${eventId}`,
      payload: { event_id: eventId },
    });
    let dead = 0;
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      dead += (await t.jobs.dispatchOutbox()).dead;
      t.clock.advance(outboxBackoffMs(attempt));
    }
    expect(dead).toBe(1);
    expect(await eventRow(id!)).toMatchObject({ status: "dead", attempts: OUTBOX_MAX_ATTEMPTS });
    expect((await t.jobs.dispatchOutbox()).claimed).toBe(0);
  });

  it("topik tak dikenal langsung dead; topik tanpa handler gagal dan dijadwalkan ulang", async () => {
    const unknown = uuidv7();
    await t.db.insert(outboxEvents).values({
      id: unknown,
      topic: "topik.asing",
      dedupKey: `u:${unknown}`,
      payload: {},
      nextAttemptAt: t.clock.now(),
      createdAt: t.clock.now(),
    });
    const orphan = await outbox.publish(t.db, {
      topic: "audit.export.requested",
      dedupKey: `o:${uuidv7()}`,
      payload: { export_id: uuidv7(), admin_id: uuidv7() },
    });
    expect(await t.jobs.dispatchOutbox()).toEqual({ claimed: 2, dispatched: 0, failed: 1, dead: 1 });
    expect(await eventRow(unknown)).toMatchObject({ status: "dead", lastError: "UnknownTopicError" });
    expect(await eventRow(orphan!)).toMatchObject({ status: "failed", lastError: "MissingHandlerError" });
  });

  it("event yang sedang diklaim worker lain (locked_until) tidak diklaim ulang sebelum kunci habis", async () => {
    const eventId = uuidv7();
    const id = await outbox.publish(t.db, {
      topic: "event.cancelled",
      dedupKey: `l:${eventId}`,
      payload: { event_id: eventId },
    });
    await t.db
      .update(outboxEvents)
      .set({ lockedUntil: new Date(t.clock.now().getTime() + 60_000) })
      .where(eq(outboxEvents.id, id!));
    expect((await t.jobs.dispatchOutbox()).claimed).toBe(0);
    t.clock.advance(60_001);
    expect((await t.jobs.dispatchOutbox()).dispatched).toBe(1);
  });
});

describe("JobRunner.runScheduled", () => {
  it("menjalankan job terdaftar dalam konteks system dengan job_id dan waktu Clock; job tak terdaftar ditolak", async () => {
    await t.jobs.runScheduled("uji.tick");
    expect(probe.ticks).toHaveLength(1);
    expect(probe.ticks[0]!.actor).toBe("system");
    expect(probe.ticks[0]!.jobId).toMatch(/^uji\.tick:/);
    expect(probe.ticks[0]!.contextJobId).toBe(probe.ticks[0]!.jobId);
    expect(probe.ticks[0]!.now).toEqual(t.clock.now());
    await expect(t.jobs.runScheduled("tidak.ada")).rejects.toThrow();
    expect(t.jobs.registry.scheduledJobs().map((j) => j.name)).toContain("uji.tick");
  });

  it("registri menolak nama job tidak valid, interval terlalu kecil, dan pendaftaran ganda", () => {
    const registry = new JobRegistry();
    const run = async () => {};
    expect(() => registry.registerScheduled({ name: "Tanpa Titik", everyMs: 60_000, run })).toThrow();
    expect(() => registry.registerScheduled({ name: "a.b", everyMs: 10, run })).toThrow();
    registry.registerScheduled({ name: "a.b", everyMs: 1_000, run });
    expect(() => registry.registerScheduled({ name: "a.b", everyMs: 1_000, run })).toThrow();
    registry.registerTopicHandler({ topic: "event.cancelled", handle: async () => {} });
    expect(() =>
      registry.registerTopicHandler({ topic: "event.cancelled", handle: async () => {} }),
    ).toThrow();
  });
});

describe("JobRunner.drainOutbox (helper uji)", () => {
  it("memproses semua event jatuh tempo dalam beberapa putaran lalu berhenti", async () => {
    for (let i = 0; i < 3; i++) {
      const eventId = uuidv7();
      await outbox.publish(t.db, {
        topic: "event.cancelled",
        dedupKey: `drain:${eventId}`,
        payload: { event_id: eventId },
      });
    }
    probe.failures = 1;
    // Satu gagal (backoff ke masa depan), dua terkirim; loop berhenti walau ada event failed.
    expect(await t.jobs.drainOutbox()).toEqual({ claimed: 3, dispatched: 2, failed: 1, dead: 0 });
    t.clock.advance(outboxBackoffMs(1));
    expect(await t.jobs.drainOutbox()).toEqual({ claimed: 1, dispatched: 1, failed: 0, dead: 0 });
  });
});

describe("createWorkerContext (ARCHITECTURE §1, §4.8)", () => {
  it("memuat modul pemilik job dengan WorkerEnv tanpa secret API dan memproses outbox", async () => {
    const { pg, db } = await createTestDatabase();
    const env: WorkerEnv = {
      NODE_ENV: "test",
      DATABASE_URL: testEnv.DATABASE_URL,
      REDIS_URL: undefined,
      LOG_LEVEL: "silent",
      PUBLIC_WEB_URL: testEnv.PUBLIC_WEB_URL,
      API_PUBLIC_URL: testEnv.API_PUBLIC_URL,
      ADMIN_ORIGIN: testEnv.ADMIN_ORIGIN,
      SMTP_URL: undefined,
      MAIL_FROM: testEnv.MAIL_FROM,
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_ROOT: "/tmp",
      S3_ENDPOINT: undefined,
      S3_REGION: undefined,
      S3_BUCKET: undefined,
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: undefined,
      S3_FORCE_PATH_STYLE: false,
      FILE_URL_SECRET: testEnv.FILE_URL_SECRET,
      FCM_PROJECT_ID: undefined,
      FCM_SERVICE_ACCOUNT_JSON: undefined,
      WORKER_CONCURRENCY: 2,
    };
    const clock = new TestClock();
    const worker = await createWorkerContext(
      {
        env,
        db,
        mailer: new MemoryMailer(),
        clock,
        push: new FakePush(),
        storage: new MemoryDriver(),
        redis: null,
      },
      { extraModules: [JobsProbeModule] },
    );
    try {
      expect(worker.registry.topics()).toContain("event.cancelled");
      // Job core yang didaftarkan layanan inti ikut tersedia di worker (ARCHITECTURE §4.8).
      expect(worker.registry.scheduledJobs().map((job) => job.name)).toContain("files.cleanup-temp");
      await worker.jobs.runScheduled("files.cleanup-temp");
      // Kernel domain tersedia tanpa secret API (QR hanya runtime API).
      expect(worker.app.get(MembershipKernel)).toBeInstanceOf(MembershipKernel);
      expect(worker.app.get(PaymentHandlerRegistry).types()).toEqual(
        expect.arrayContaining(["registration", "renewal"]),
      );
      expect(() => worker.app.get(QrTokenService)).toThrow();
      const eventId = uuidv7();
      await worker.app.get(OutboxService).publish(db, {
        topic: "event.cancelled",
        dedupKey: `w:${eventId}`,
        payload: { event_id: eventId },
      });
      expect(await worker.jobs.dispatchOutbox()).toMatchObject({ dispatched: 1 });
    } finally {
      await worker.close();
      await pg.close();
    }
  });
});
