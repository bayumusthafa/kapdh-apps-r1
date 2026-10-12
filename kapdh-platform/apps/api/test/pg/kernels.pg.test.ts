/**
 * Kernel core di bawah konkurensi nyata PostgreSQL 17 (ARCHITECTURE §9.2, PRD 5.1: hasil antrean/ulangan tidak boleh
 * menggandakan periode, nomor, atau notifikasi). API berjalan dengan login role kapdh_app (grant production); fixture
 * dibuat dengan koneksi pemilik database uji.
 *
 * - AC F04-5 / PRD 9.2 "double approval": applyPaidPayment untuk payment yang sama dipanggil bersamaan → satu periode,
 *   satu membership_event, satu notifikasi.
 * - Dua renewal paid berbeda untuk anggota yang sama diterapkan bersamaan → keduanya berlaku berurutan (tidak ada
 *   lost update pada expires_at).
 * - N-10: unggahan bersamaan oleh pengguna yang sama tidak melewati kuota 10 per purpose (kunci advisory).
 */
import "reflect-metadata";
import { alumni, files, membershipEvents, notifications } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { createAlumni, createMembershipPayment, signInAlumni } from "../support/factories.js";
import { postFile, testJpeg } from "../support/files.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import {
  barrier,
  connectAs,
  createPgTestDatabase,
  type PgTestDatabase,
  withLockWaitGate,
} from "./support.js";

let tdb: PgTestDatabase;
let api: ReturnType<typeof connectAs>;
let app: NestFastifyApplication;
let kernel: MembershipKernel;
const clock = new TestClock();
let owner: { db: Db; clock: TestClock };
let apiDb: Db;

beforeAll(async () => {
  tdb = await createPgTestDatabase("kernels", 16);
  api = connectAs(tdb, "kapdh_app", 12);
  apiDb = api.db as unknown as Db;
  owner = { db: tdb.db as unknown as Db, clock };
  app = await createApp(
    {
      env: testEnv,
      db: apiDb,
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
  kernel = app.get(MembershipKernel);
});
afterAll(async () => {
  await app?.close();
  await api?.sql.end({ timeout: 5 });
  await tdb.drop();
});

/** Transaksi kernel seperti keputusan payment: konteks system, tx dari withTx (efek setelah commit). */
function approve(paymentId: string, approvedAt: Date) {
  return runAsSystem(() => withTx(apiDb, (tx) => kernel.applyPaidPayment(tx, { id: paymentId }, approvedAt)));
}

describe("MembershipKernel.applyPaidPayment bersamaan (AC F04-5, PRD 9.2 double approval)", () => {
  it("payment yang sama diterapkan 8x bersamaan: satu periode, satu membership_event, satu notifikasi", async () => {
    for (let round = 0; round < 3; round++) {
      const member = await createAlumni(owner, { status: "unverified" });
      const payment = await createMembershipPayment(owner, { userId: member.userId, type: "registration" });
      const approvedAt = clock.now();
      // Penahan memegang kunci baris payment lebih dulu, sehingga 8 transaksi kernel PASTI berebut kunci yang sama;
      // kunci dilepas begitu penantian mereka teramati (deterministik, tanpa jendela sleep).
      const { result, lockWaitObserved } = await withLockWaitGate(tdb, async (hold) => {
        let signalLocked!: () => void;
        const locked = new Promise<void>((resolve) => (signalLocked = resolve));
        const blocker = tdb.sql.begin(async (tx) => {
          await tx`select id from app.payments where id = ${payment.id} for update`;
          signalLocked();
          await hold();
        });
        await locked;
        const approvals = Promise.all(Array.from({ length: 8 }, () => approve(payment.id, approvedAt)));
        await blocker;
        return approvals;
      });
      const applied = result.filter((r) => r.applied);
      expect(applied, `putaran ${round}`).toHaveLength(1);
      expect(new Set(result.map((r) => r.eventId)).size).toBe(1);
      expect(lockWaitObserved, "transaksi benar-benar saling menunggu kunci baris").toBe(true);

      const events = await tdb.db
        .select()
        .from(membershipEvents)
        .where(eq(membershipEvents.paymentId, payment.id));
      expect(events).toHaveLength(1);
      const [profile] = await tdb.db.select().from(alumni).where(eq(alumni.userId, member.userId));
      expect(profile!.expiresAt).toEqual(addCalendarMonthsJakarta(approvedAt, 12));
      const inbox = await tdb.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, member.userId), eq(notifications.category, "membership")));
      expect(inbox).toHaveLength(1);
    }
  });

  it("dua renewal paid berbeda diterapkan bersamaan: kunci baris alumni menyerialkan (+24 bulan, tanpa lost update)", async () => {
    const member = await createAlumni(owner, { status: "expiring" });
    const first = await createMembershipPayment(owner, { userId: member.userId, type: "renewal" });
    const second = await createMembershipPayment(owner, { userId: member.userId, type: "renewal" });
    const gate = barrier(2);
    const approvedAt = clock.now();
    const results = await Promise.all(
      [first.id, second.id].map(async (id) => {
        await gate();
        return approve(id, approvedAt);
      }),
    );
    expect(results.every((r) => r.applied)).toBe(true);
    const [profile] = await tdb.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    expect(profile!.expiresAt).toEqual(addCalendarMonthsJakarta(member.expiresAt!, 24));
    const periods = results.map((r) => [r.periodStartsAt.getTime(), r.periodExpiresAt.getTime()]).sort();
    // Periode kedua bersambung tepat dari akhir periode pertama.
    expect(periods[1]![0]).toBe(periods[0]![1]);
  });
});

describe("N-10: kuota unggahan di bawah konkurensi (kunci advisory per pengguna + purpose)", () => {
  it("12 unggahan bersamaan oleh pengguna yang sama: tepat 10 berhasil, sisanya 429", async () => {
    const member = await createAlumni(owner, { status: "verified" });
    const session = await signInAlumni({ app }, member);
    const image = await testJpeg();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => postFile(app, session.accessToken, "avatar", { data: image })),
    );
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(
      statuses.filter((s) => s === 201),
      statuses.join(","),
    ).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    const rows = await tdb.db.select().from(files).where(eq(files.ownerUserId, member.userId));
    expect(rows.filter((r) => r.status === "ready")).toHaveLength(10);
  });
});
