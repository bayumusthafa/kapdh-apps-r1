/**
 * Modul membership di bawah konkurensi nyata PostgreSQL 17 (ARCHITECTURE §9.2; PRD 5.1, 6.4: ulangan/antrean tidak
 * boleh menggandakan notifikasi, keputusan, atau periode). API berjalan sebagai role kapdh_app (grant production).
 *
 * - AC F15-4: PATCH /me/profile bersamaan dengan If-Match yang sama → tepat satu berhasil, sisanya 409, versi naik
 *   sekali (baris alumni dikunci, bukan baca-lalu-tulis).
 * - AC F07-5, F13-6: job membership.expiry-reminders dijalankan bersamaan di beberapa "worker" → satu notifikasi dan
 *   satu outbox per periode.
 * - AC F12-3: dua pengurus men-suspend anggota yang sama bersamaan dengan versi yang sama → satu keputusan, satu
 *   histori suspend.
 * - AC F16-4: inisiasi pemulihan sandi bersamaan → tepat satu challenge aktif (otp_codes_active_key), tanpa 500.
 */
import "reflect-metadata";
import {
  alumni,
  membershipEvents,
  notifications,
  otpCodes,
  outboxEvents,
  sessions as sessionsTable,
} from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { ExpiryRemindersService } from "../../src/modules/membership/expiry-reminders.service.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase, withLockWaitGate } from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
const clock = new TestClock();
let owner: { db: Db; clock: TestClock };
const DAY_MS = 24 * 3600_000;

beforeAll(async () => {
  tdb = await createPgTestDatabase("membership", 16);
  api = connectAs(tdb, "kapdh_app", 12);
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: api.db as unknown as Db,
      mailer: new MemoryMailer(),
      clock,
      push: new FakePush(),
      storage: new MemoryDriver(),
      redis: null,
    },
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

/** Kunci baris alumni dipegang lebih dulu sehingga semua peserta PASTI saling menunggu kunci yang sama. */
async function contended<T>(userId: string, run: () => Promise<T>) {
  return withLockWaitGate(tdb, async (hold) => {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const blocker = tdb.sql.begin(async (tx) => {
      await tx`select user_id from app.alumni where user_id = ${userId} for update`;
      signalLocked();
      await hold();
    });
    await locked;
    const pending = run();
    await blocker;
    return pending;
  });
}

describe("PATCH /me/profile bersamaan (AC F15-4)", () => {
  it("AC F15-4: 8 perubahan dengan If-Match sama → tepat satu 200, tujuh 409 VERSION_CONFLICT, versi naik sekali", async () => {
    const member = await createAlumni(owner, { status: "verified" });
    const session = await signInAlumni({ app }, member);
    const http = httpClient(app);
    const [before] = await tdb.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    const { result, lockWaitObserved } = await contended(member.userId, () =>
      Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          http.patch(
            "/me/profile",
            { city: `Kota ${i}` },
            { token: session.accessToken, headers: { "if-match": String(before!.version) } },
          ),
        ),
      ),
    );
    expect(lockWaitObserved, "permintaan benar-benar saling menunggu kunci baris").toBe(true);
    const codes = result.map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    for (const res of result.filter((r) => r.statusCode === 409))
      expect(res.json().code).toBe("VERSION_CONFLICT");
    const [after] = await tdb.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    expect(after!.version).toBe(before!.version + 1);
    const winner = result.find((r) => r.statusCode === 200)!.json() as { profile: { city: string } };
    expect(after!.city).toBe(winner.profile.city);
  });
});

describe("membership.expiry-reminders bersamaan (AC F07-5, F13-6)", () => {
  it("AC F07-5: 4 eksekusi job bersamaan → satu notifikasi dan satu outbox per periode untuk setiap anggota", async () => {
    const members = [];
    for (let i = 0; i < 6; i++) {
      const fixture = await createAlumni(owner, { status: "verified" });
      const expiresAt = new Date(clock.now().getTime() + (i < 3 ? 5 : -2) * DAY_MS + i * 1000);
      await tdb.db
        .update(alumni)
        .set({ startsAt: addCalendarMonthsJakarta(expiresAt, -12), expiresAt })
        .where(eq(alumni.userId, fixture.userId));
      members.push(fixture.userId);
    }
    const service = app.get(ExpiryRemindersService);
    const runs = await Promise.all(Array.from({ length: 4 }, () => service.run(clock.now())));
    const created = runs.reduce((sum, run) => sum + run.reminders + run.expiredNotices, 0);
    expect(created).toBe(6);
    const inbox = await tdb.db
      .select()
      .from(notifications)
      .where(and(inArray(notifications.userId, members), eq(notifications.category, "membership")));
    expect(inbox).toHaveLength(6);
    expect(new Set(inbox.map((n) => n.userId)).size).toBe(6);
    const outbox = await tdb.db
      .select()
      .from(outboxEvents)
      .where(
        inArray(
          outboxEvents.dedupKey,
          inbox.map((n) => `notification.created:${n.id}`),
        ),
      );
    expect(outbox).toHaveLength(6);
    // Diulang lagi: tidak ada notifikasi baru.
    const rerun = await service.run(clock.now());
    expect(rerun).toEqual({ reminders: 0, expiredNotices: 0 });
  });
});

describe("Suspend bersamaan dari menu anggota (AC F12-3)", () => {
  it("AC F12-3: dua pengurus dengan versi sama → satu suspend berlaku, yang lain 409; satu histori suspend", async () => {
    const member = await createAlumni(owner, { status: "verified" });
    const permissions = ["members.read", "moderation.read", "moderation.resolve"] as const;
    const first = await createAdmin(owner, { permissions: [...permissions] });
    const second = await createAdmin(owner, { permissions: [...permissions] });
    const sessions = [await signInAdmin({ app, clock }, first), await signInAdmin({ app, clock }, second)];
    const [row] = await tdb.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    const http = httpClient(app);
    const { result, lockWaitObserved } = await contended(member.userId, () =>
      Promise.all(
        sessions.map((session, i) =>
          http.post(
            `/admin/members/${member.userId}/suspend`,
            { reason: `Alasan pengurus ${i}`, member_message: "Akun dibatasi sementara.", confirm: true },
            {
              token: session.accessToken,
              headers: { "if-match": String(row!.version), "idempotency-key": uuidv7() },
            },
          ),
        ),
      ),
    );
    expect(lockWaitObserved).toBe(true);
    expect(result.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const events = await tdb.db
      .select()
      .from(membershipEvents)
      .where(and(eq(membershipEvents.userId, member.userId), eq(membershipEvents.kind, "suspend")));
    expect(events).toHaveLength(1);
  });
});

describe("Pemulihan sandi bersamaan (AC F16-4)", () => {
  it("AC F16-4: 4 inisiasi bersamaan → semua diproses berurutan di bawah kunci users, tepat satu challenge aktif", async () => {
    const member = await createAlumni(owner, { status: "verified" });
    const superAdmin = await createAdmin(owner, { role: "super_admin" });
    const session = await signInAdmin({ app, clock }, superAdmin);
    const claims = decodeJwt(session.accessToken);
    const [family] = await tdb.db
      .select({ familyId: sessionsTable.familyId })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, String(claims.sid)));
    const reauth = (
      await app
        .get(TokenService)
        .signReauth({ userId: superAdmin.userId, familyId: family!.familyId, level: 2 })
    ).token;
    const http = httpClient(app);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        http.post(
          `/admin/members/${member.userId}/password-reset`,
          { reason: "Permintaan anggota (uji)", confirm: true },
          {
            token: session.accessToken,
            headers: { "x-reauth-token": reauth, "idempotency-key": uuidv7() },
          },
        ),
      ),
    );
    expect(results.map((res) => res.statusCode)).toEqual([202, 202, 202, 202]);
    const active = await tdb.db
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.userId, member.userId),
          eq(otpCodes.purpose, "password_reset"),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
        ),
      );
    expect(active).toHaveLength(1);
  });
});
