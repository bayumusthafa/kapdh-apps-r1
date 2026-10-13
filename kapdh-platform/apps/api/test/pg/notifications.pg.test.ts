/**
 * Notifikasi (F-13) di bawah konkurensi nyata PostgreSQL 17 (ARCHITECTURE §9.2; PRD 5.1: hasil antrean/ulangan tidak
 * boleh menggandakan notifikasi). API berjalan sebagai login role kapdh_app, dua worker sebagai kapdh_worker dengan
 * pool masing-masing (grant production).
 *
 * - Dua worker memproses pengiriman jatuh tempo bersamaan → setiap pengiriman dikirim tepat sekali (SKIP LOCKED + lease).
 * - Baris yang sedang dikunci transaksi lain dilewati klaim (SKIP LOCKED), tidak ditunggu, dan diklaim setelah dilepas.
 * - AC F13-5: registerDevice bersamaan untuk token yang sama oleh dua akun → tanpa deadlock/500; pending akun yang
 *   kehilangan token dibatalkan; tidak ada pengiriman pending yang menargetkan token milik akun lain.
 * - AC F13-5: registerDevice bersamaan dengan logout keluarga sesi yang sama → tanpa deadlock; tidak ada token aktif
 *   yang tersisa untuk keluarga yang sudah logout.
 * - AC F13-5: sapuan token sesi berakhir yang menunggu kunci token yang sedang diikat ulang ke sesi baru tidak
 *   mencabutnya (predikat ikatan diperiksa ulang pada versi baris terbaru).
 * - AC F13-4: retry pengurus bersamaan untuk pengiriman yang sama → tepat satu dijadwalkan ulang dan satu audit.
 */
import "reflect-metadata";
import type { WorkerEnv } from "@kapdh/config";
import { auditLogs, deviceTokens, notificationDeliveries, notifications, sessions } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { NotificationService } from "../../src/core/notifications-kernel/notification.service.js";
import { NotificationDeliveryService } from "../../src/modules/notifications/delivery.service.js";
import { DevicesService } from "../../src/modules/notifications/devices.service.js";
import { createWorkerContext, type WorkerContext } from "../../src/worker.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, withLockWaitGate } from "./support.js";

let tdb: PgTestDatabase;
let apiConn: ReturnType<typeof connectAs>;
const workerConns: ReturnType<typeof connectAs>[] = [];
let app: NestFastifyApplication;
let apiDb: Db;
const clock = new TestClock();
const apiPush = new FakePush();
const workers: { ctx: WorkerContext; push: FakePush; service: NotificationDeliveryService }[] = [];
let owner: { db: Db; clock: TestClock };

const workerEnv: WorkerEnv = {
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

beforeAll(async () => {
  tdb = await createPgTestDatabase("notifications", 16);
  owner = { db: tdb.db as unknown as Db, clock };
  apiConn = connectAs(tdb, "kapdh_app", 12);
  apiDb = apiConn.db as unknown as Db;
  app = await createApp(
    {
      env: testEnv,
      db: apiDb,
      mailer: new MemoryMailer(),
      clock,
      push: apiPush,
      storage: new MemoryDriver(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  for (let i = 0; i < 2; i++) {
    const conn = connectAs(tdb, "kapdh_worker", 6);
    workerConns.push(conn);
    const push = new FakePush();
    const ctx = await createWorkerContext({
      env: workerEnv,
      db: conn.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push,
      storage: new MemoryDriver(),
      redis: null,
    });
    workers.push({ ctx, push, service: ctx.app.get(NotificationDeliveryService) });
  }
});
afterAll(async () => {
  for (const worker of workers) await worker.ctx.close();
  await app?.close();
  for (const conn of workerConns) await conn.sql.end({ timeout: 5 });
  await apiConn?.sql.end({ timeout: 5 });
  await tdb.drop();
});

const api = () => httpClient(app);

async function notify(userId: string, category: "news" | "payment" | "event" = "news") {
  const service = app.get(NotificationService);
  return runAsSystem(() =>
    withTx(apiDb, (tx) =>
      service.notify(tx, {
        userId,
        category,
        title: "Notifikasi uji konkurensi",
        body: "Isi ringkas.",
        route: "/notifications",
        dedupKey: `pg:${uuidv7()}`,
      }),
    ),
  );
}

async function member() {
  const fixture = await createAlumni(owner);
  const session = await signInAlumni({ app }, fixture);
  return { ...fixture, ...session };
}

async function register(accessToken: string, token: string) {
  return api().put("/devices", { platform: "android", token }, { token: accessToken });
}

describe("Klaim pengiriman bersamaan (PRD 5.1)", () => {
  it("dua worker memproses bersamaan: setiap pengiriman dikirim tepat sekali, attempt 1", async () => {
    const ids: string[] = [];
    for (let m = 0; m < 3; m++) {
      const alumni = await member();
      for (let d = 0; d < 2; d++) {
        const session = d === 0 ? alumni : await signInAlumni({ app }, alumni);
        expect((await register(session.accessToken, `pg-${uuidv7()}`)).statusCode).toBe(204);
      }
      for (let n = 0; n < 10; n++) {
        const created = await notify(alumni.userId);
        await workers[0]!.service.schedule(created.id);
        ids.push(created.id);
      }
    }
    await Promise.all([
      workers[0]!.service.sendDue({ limit: 7 }),
      workers[1]!.service.sendDue({ limit: 7 }),
      workers[0]!.service.retryDue(),
      workers[1]!.service.retryDue(),
      workers[0]!.service.sendDue({ limit: 5 }),
      workers[1]!.service.sendDue({ limit: 5 }),
    ]);
    const sent = [...workers[0]!.push.sent, ...workers[1]!.push.sent];
    expect(sent).toHaveLength(60);
    expect(new Set(sent.map((m) => `${m.token}:${m.data.notification_id}`)).size).toBe(60);
    const rows = await tdb.db
      .select()
      .from(notificationDeliveries)
      .where(inArray(notificationDeliveries.notificationId, ids));
    expect(rows).toHaveLength(60);
    expect(rows.every((row) => row.status === "sent" && row.attempt === 1)).toBe(true);
    const inbox = await tdb.db.select().from(notifications).where(inArray(notifications.id, ids));
    expect(inbox).toHaveLength(30);
  });

  it("baris yang dikunci transaksi lain dilewati klaim (SKIP LOCKED) tanpa menunggu; diklaim setelah kunci dilepas", async () => {
    const alumni = await member();
    expect((await register(alumni.accessToken, `pg-${uuidv7()}`)).statusCode).toBe(204);
    const created = await notify(alumni.userId);
    await workers[0]!.service.schedule(created.id);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = tdb.sql.begin(async (tx) => {
      await tx`select id from app.notification_deliveries where notification_id = ${created.id} for update`;
      locked();
      await released;
    });
    await isLocked;
    const started = Date.now();
    expect(await workers[1]!.service.sendDue({ notificationId: created.id })).toMatchObject({ claimed: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);
    release();
    await holder;
    expect(await workers[1]!.service.sendDue({ notificationId: created.id })).toMatchObject({
      claimed: 1,
      sent: 1,
    });
  });
});

describe("Token perangkat bersamaan (AC F13-5)", () => {
  it("AC F13-5: dua akun mendaftarkan token yang sama bersamaan → semua 204, tanpa deadlock; tidak ada pending yang menargetkan token akun lain", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await member();
      const b = await member();
      const token = `pg-bersama-${uuidv7()}`;
      expect((await register(a.accessToken, token)).statusCode).toBe(204);
      // Pengiriman pending milik A pada token itu (push gagal sementara).
      const forA = await notify(a.userId, "payment");
      await workers[0]!.service.schedule(forA.id);
      const results = await Promise.all([
        register(b.accessToken, token),
        register(a.accessToken, token),
        register(b.accessToken, token),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([204, 204, 204]);
      const [row] = await tdb.db.select().from(deviceTokens).where(eq(deviceTokens.token, token));
      expect([a.userId, b.userId]).toContain(row!.userId);
      expect(row!.revokedAt).toBeNull();
      const pendingForeign = await tdb.db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
        .where(
          and(
            eq(notificationDeliveries.deviceTokenId, row!.id),
            eq(notificationDeliveries.status, "pending"),
            dsql`${notifications.userId} <> ${row!.userId}`,
          ),
        );
      expect(pendingForeign, `putaran ${round}`).toEqual([]);
      // A pernah kehilangan token ke B setidaknya sekali (B mendaftar pertama di antara tiga permintaan atau terakhir).
      const [delivery] = await tdb.db
        .select()
        .from(notificationDeliveries)
        .where(
          and(eq(notificationDeliveries.notificationId, forA.id), eq(notificationDeliveries.channel, "push")),
        );
      if (row!.userId === b.userId)
        expect(delivery).toMatchObject({ status: "cancelled", errorClass: "token_reassigned" });
    }
  });

  it("AC F13-5: registerDevice bersamaan dengan logout keluarga yang sama → tanpa deadlock; tidak ada token aktif untuk keluarga yang logout", async () => {
    for (let round = 0; round < 6; round++) {
      const alumni = await member();
      expect((await register(alumni.accessToken, `pg-awal-${uuidv7()}`)).statusCode).toBe(204);
      const [registered, logout] = await Promise.all([
        register(alumni.accessToken, `pg-baru-${uuidv7()}`),
        api().post("/auth/logout", {}, { token: alumni.accessToken }),
      ]);
      expect([204, 401]).toContain(registered.statusCode);
      expect(logout.statusCode).toBe(204);
      const active = await tdb.db
        .select({ id: deviceTokens.id })
        .from(deviceTokens)
        .where(and(eq(deviceTokens.userId, alumni.userId), isNull(deviceTokens.revokedAt)));
      expect(active, `putaran ${round}: token aktif setelah logout`).toEqual([]);
      const live = await tdb.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, alumni.userId), isNull(sessions.revokedAt)));
      expect(live).toEqual([]);
    }
  });
});

describe("Sapuan token sesi berakhir (AC F13-5)", () => {
  it("AC F13-5: sapuan yang menunggu kunci token yang sedang diikat ulang ke sesi baru tidak mencabutnya; token tanpa ikatan sesi dicabut", async () => {
    const devices = workers[0]!.ctx.app.get(DevicesService);
    const alumni = await member();
    const token = `pg-sapu-${uuidv7()}`;
    expect((await register(alumni.accessToken, token)).statusCode).toBe(204);
    const [row] = await tdb.db.select().from(deviceTokens).where(eq(deviceTokens.token, token));
    const [bound] = await tdb.db.select().from(sessions).where(eq(sessions.id, row!.sessionId!));
    await tdb.db
      .update(sessions)
      .set({ expiresAt: new Date(clock.now().getTime() - 1000) })
      .where(eq(sessions.familyId, bound!.familyId));
    const candidates = (await devices.findEndedSessionTokens(clock.now(), 1000)).filter(
      (c) => c.id === row!.id,
    );
    expect(candidates).toEqual([{ id: row!.id, sessionId: row!.sessionId }]);
    // Anggota masuk lagi di perangkat itu (keluarga sesi baru).
    await signInAlumni({ app }, alumni);
    const [fresh] = await tdb.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, alumni.userId),
          isNull(sessions.revokedAt),
          dsql`${sessions.familyId} <> ${bound!.familyId}`,
        ),
      );

    // Pendaftaran ulang (login baru) memegang kunci baris token; sapuan dimulai dan menunggu, lalu ikatan baru commit.
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const { result, lockWaitObserved } = await withLockWaitGate(tdb, async (hold) => {
      const holder = tdb.sql.begin(async (tx) => {
        await tx`select id from app.device_tokens where id = ${row!.id} for update`;
        locked();
        await hold();
        await tx`update app.device_tokens set session_id = ${fresh!.id} where id = ${row!.id}`;
      });
      await isLocked;
      const [revoked] = await Promise.all([devices.revokeUnchangedTokens(candidates, clock.now()), holder]);
      return revoked;
    });
    expect(lockWaitObserved).toBe(true);
    expect(result).toBe(0);
    const [after] = await tdb.db.select().from(deviceTokens).where(eq(deviceTokens.id, row!.id));
    expect(after).toMatchObject({ revokedAt: null, sessionId: fresh!.id, userId: alumni.userId });

    // Kontrol: token perangkat lain (keluarga sesi lain) yang tidak lagi terikat baris sesi mana pun dicabut sapuan
    // penuh (PostgreSQL 17, role worker), sedangkan token yang terikat keluarga aktif tetap.
    const otherDevice = await signInAlumni({ app }, alumni);
    const orphan = `pg-yatim-${uuidv7()}`;
    expect((await register(otherDevice.accessToken, orphan)).statusCode).toBe(204);
    await tdb.db.update(deviceTokens).set({ sessionId: null }).where(eq(deviceTokens.token, orphan));
    expect(await devices.revokeEndedSessionTokens()).toBeGreaterThanOrEqual(1);
    const [orphanRow] = await tdb.db.select().from(deviceTokens).where(eq(deviceTokens.token, orphan));
    expect(orphanRow!.revokedAt).not.toBeNull();
    const [kept] = await tdb.db.select().from(deviceTokens).where(eq(deviceTokens.id, row!.id));
    expect(kept!.revokedAt).toBeNull();
  });
});

describe("Retry pengurus bersamaan (AC F13-4, F17-1)", () => {
  it("dua retry bersamaan untuk pengiriman failed yang sama → tepat satu requeued, satu not_failed, satu audit", async () => {
    const alumni = await member();
    const token = `pg-retry-${uuidv7()}`;
    expect((await register(alumni.accessToken, token)).statusCode).toBe(204);
    workers[0]!.push.failNext(token, {
      ok: false,
      errorClass: "auth_error",
      retryable: false,
      deactivateToken: false,
    });
    const created = await notify(alumni.userId, "event");
    await workers[0]!.service.deliver(created.id);
    const [failed] = await tdb.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.notificationId, created.id),
          eq(notificationDeliveries.channel, "push"),
        ),
      );
    expect(failed!.status).toBe("failed");

    const sessionsOf = await Promise.all(
      [0, 1].map(async () =>
        signInAdmin({ app, clock }, await createAdmin(owner, { permissions: ["notifications.manage"] })),
      ),
    );
    const results = await Promise.all(
      sessionsOf.map((session) =>
        api().post(
          "/admin/notifications/deliveries/retry",
          { delivery_ids: [failed!.id] },
          { token: session.accessToken },
        ),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const bodies = results.map(
      (r) => r.json() as { requeued: { id: string }[]; skipped: { delivery_id: string; reason: string }[] },
    );
    expect(bodies.map((b) => b.requeued.length).sort()).toEqual([0, 1]);
    expect(bodies.flatMap((b) => b.skipped)).toEqual([{ delivery_id: failed!.id, reason: "not_failed" }]);
    const audits = await tdb.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "notification.delivery.retried"), eq(auditLogs.entityId, failed!.id)));
    expect(audits).toHaveLength(1);
  });
});
