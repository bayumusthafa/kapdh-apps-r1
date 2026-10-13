import { alumni, notifications, outboxEvents, payments, users } from "@kapdh/database";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRegistry } from "../../src/core/jobs/job-registry.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { NotificationService } from "../../src/core/notifications-kernel/notification.service.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import {
  EXPIRY_REMINDERS_JOB,
  ExpiryRemindersService,
} from "../../src/modules/membership/expiry-reminders.service.js";
import { WORKER_MODULES } from "../../src/app.module.js";
import { MembershipJobsModule } from "../../src/modules/membership/membership-jobs.module.js";
import { createAlumni, createMembershipPayment } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { approveMembershipPayment } from "./helpers.js";

/**
 * Job `membership.expiry-reminders` (AC F07-5, F13-6; ARCHITECTURE §4.8): satu pengingat per periode 30 hari sebelum
 * habis dan satu pemberitahuan saat habis; pengulangan job tidak pernah menggandakan inbox atau outbox.
 */

let t: TestApp;
const DAY_MS = 24 * 3600_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

async function inboxOf(userId: string) {
  return t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.category, "membership")));
}

async function outboxFor(notificationIds: string[]) {
  if (notificationIds.length === 0) return [];
  return t.db
    .select()
    .from(outboxEvents)
    .where(
      inArray(
        outboxEvents.dedupKey,
        notificationIds.map((id) => `notification.created:${id}`),
      ),
    );
}

async function memberExpiringIn(ms: number) {
  const fixture = await createAlumni(t, { status: "verified" });
  const expiresAt = new Date(t.clock.now().getTime() + ms);
  await t.db
    .update(alumni)
    .set({ startsAt: addCalendarMonthsJakarta(expiresAt, -12), expiresAt })
    .where(eq(alumni.userId, fixture.userId));
  return { ...fixture, expiresAt };
}

/**
 * Memajukan jam jauh melewati semua periode anggota uji sebelumnya (lebih dari jendela 30 hari pemberitahuan habis),
 * sehingga kandidat job hanya anggota yang dibuat uji itu sendiri.
 */
function isolateFromEarlierMembers() {
  t.clock.set(new Date(t.clock.now().getTime() + 5 * 365 * DAY_MS));
}

/**
 * Instance job yang sama dengan `db` yang menjalankan `gap` tepat sebelum transaksi notifikasi PERTAMA, yaitu setelah
 * query kandidat (batch) selesai: mensimulasikan persetujuan renewal/suspend yang commit di antara keduanya.
 */
function serviceWithGapBeforeFirstNotify(gap: () => Promise<unknown>): ExpiryRemindersService {
  let pending: (() => Promise<unknown>) | null = gap;
  const db = Object.create(t.db) as Db;
  Object.defineProperty(db, "transaction", {
    value: async (...args: Parameters<Db["transaction"]>) => {
      if (pending) {
        const run = pending;
        pending = null;
        await run();
      }
      return t.db.transaction(...args);
    },
  });
  return new ExpiryRemindersService(db, t.app.get(JobRegistry), t.app.get(NotificationService));
}

function suspendMember(userId: string) {
  return runAsSystem(() =>
    t.db.transaction((tx) =>
      t.app.get(MembershipKernel).suspend(tx, userId, {
        reason: "Pelanggaran ketentuan komunitas (uji)",
        memberMessage: "Akun Anda dibatasi sementara.",
        actorAdminId: null,
      }),
    ),
  );
}

describe("membership.expiry-reminders (AC F07-5)", () => {
  it("AC F07-5: pengingat 30 hari sebelum habis; job diulang (juga bersamaan) → tepat satu notifikasi per periode", async () => {
    const due = await memberExpiringIn(30 * DAY_MS);
    const notYet = await memberExpiringIn(30 * DAY_MS + 60_000);
    for (let i = 0; i < 3; i++) await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    const service = t.app.get(ExpiryRemindersService);
    await Promise.all([service.run(t.clock.now()), service.run(t.clock.now())]);

    const inbox = await inboxOf(due.userId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      title: "Masa KTA segera berakhir",
      data: { route: "/renewal" },
      dedupKey: `u:${due.userId}:membership.expiring:${due.expiresAt.getTime()}`,
    });
    expect(inbox[0]!.body).toContain("Perpanjang");
    expect(await outboxFor(inbox.map((n) => n.id))).toHaveLength(1);
    expect(await inboxOf(notYet.userId)).toHaveLength(0);

    // Masuk jendela satu menit kemudian → pengingat periodenya sendiri.
    t.clock.advance(60_000);
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    expect(await inboxOf(notYet.userId)).toHaveLength(1);
    expect(await inboxOf(due.userId)).toHaveLength(1);
  });

  it("AC F07-5: setelah renewal paid periode baru mendapat pengingatnya sendiri, tetap satu per periode", async () => {
    const member = await memberExpiringIn(10 * DAY_MS);
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    expect(await inboxOf(member.userId)).toHaveLength(1);

    await approveMembershipPayment(t, member.userId, "renewal");
    const [renewed] = await t.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    t.clock.set(new Date(renewed!.expiresAt!.getTime() - 29 * DAY_MS));
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    const inbox = await inboxOf(member.userId);
    expect(inbox.map((n) => n.title)).toEqual(["Masa KTA segera berakhir", "Masa KTA segera berakhir"]);
    expect(new Set(inbox.map((n) => n.dedupKey)).size).toBe(2);
  });

  it("AC F07-5, F13-6: pemberitahuan masa habis sekali per periode; suspended, akun nonaktif dan periode yang habis lama tidak dikirimi", async () => {
    const expired = await memberExpiringIn(-DAY_MS);
    const longAgo = await memberExpiringIn(-40 * DAY_MS);
    const suspended = await createAlumni(t, { status: "suspended" });
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() + 5 * DAY_MS) })
      .where(eq(alumni.userId, suspended.userId));
    const deleting = await createAlumni(t, { status: "expiring", accountStatus: "deletion_pending" });

    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    const notice = await inboxOf(expired.userId);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({
      title: "Masa KTA telah berakhir",
      dedupKey: `u:${expired.userId}:membership.expired:${expired.expiresAt.getTime()}`,
    });
    expect(await inboxOf(longAgo.userId)).toHaveLength(0);
    expect(await inboxOf(suspended.userId)).toHaveLength(0);
    expect(await inboxOf(deleting.userId)).toHaveLength(0);

    // Setelah unsuspend, anggota yang masih expiring diingatkan pada jalan berikutnya.
    await runAsSystem(() =>
      t.db.transaction((tx) =>
        t.app
          .get(MembershipKernel)
          .unsuspend(tx, suspended.userId, { reason: "Banding diterima", actorAdminId: null }),
      ),
    );
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    const afterUnsuspend = await t.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, suspended.userId),
          like(notifications.dedupKey, "%membership.expiring%"),
        ),
      );
    expect(afterUnsuspend).toHaveLength(1);
  });

  it("AC F07-5: iuran renewal yang menunggu verifikasi tidak diingatkan; pengingat dikirim bila tidak ada lagi", async () => {
    const member = await memberExpiringIn(15 * DAY_MS);
    const pending = await createMembershipPayment(t, {
      userId: member.userId,
      type: "renewal",
      status: "pending",
    });
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    expect(await inboxOf(member.userId)).toHaveLength(0);
    await t.db
      .update(payments)
      .set({ status: "rejected", decidedAt: t.clock.now(), rejectionReason: "Nominal tidak sesuai" })
      .where(eq(payments.id, pending.id));
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    expect(await inboxOf(member.userId)).toHaveLength(1);
  });

  it("AC F07-5, PRD 5.1: renewal disetujui, suspend, atau bukti renewal terkirim SETELAH kandidat dipilih → tidak ada pengingat usang", async () => {
    isolateFromEarlierMembers();
    const renewed = await memberExpiringIn(5 * DAY_MS);
    const suspended = await memberExpiringIn(6 * DAY_MS);
    const proofSent = await memberExpiringIn(7 * DAY_MS);
    const unchanged = await memberExpiringIn(8 * DAY_MS);

    // Perubahan terjadi di antara query kandidat dan transaksi notifikasi pertama.
    const service = serviceWithGapBeforeFirstNotify(async () => {
      await approveMembershipPayment(t, renewed.userId, "renewal");
      await suspendMember(suspended.userId);
      await createMembershipPayment(t, { userId: proofSent.userId, type: "renewal", status: "pending" });
    });
    const result = await service.run(t.clock.now());

    expect(result).toEqual({ reminders: 1, expiredNotices: 0 });
    expect(await inboxOf(renewed.userId)).toHaveLength(0);
    expect(await inboxOf(suspended.userId)).toHaveLength(0);
    expect(await inboxOf(proofSent.userId)).toHaveLength(0);
    const control = await inboxOf(unchanged.userId);
    expect(control).toHaveLength(1);
    expect(control[0]!.title).toBe("Masa KTA segera berakhir");
    // Periode baru hasil renewal tetap mendapat pengingatnya sendiri saat masuk jendela 30 hari.
    const [row] = await t.db.select().from(alumni).where(eq(alumni.userId, renewed.userId));
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(renewed.expiresAt.getTime());
    t.clock.set(new Date(row!.expiresAt!.getTime() - 29 * DAY_MS));
    await t.jobs.runScheduled(EXPIRY_REMINDERS_JOB);
    const later = await inboxOf(renewed.userId);
    expect(later.map((n) => n.dedupKey)).toEqual([
      `u:${renewed.userId}:membership.expiring:${row!.expiresAt!.getTime()}`,
    ]);
  });

  it("AC F07-5, PRD 5.1: renewal disetujui atau akun dinonaktifkan SETELAH kandidat dipilih → tidak ada pemberitahuan 'telah berakhir' usang", async () => {
    isolateFromEarlierMembers();
    const renewed = await memberExpiringIn(-DAY_MS);
    const disabled = await memberExpiringIn(-2 * DAY_MS);
    const unchanged = await memberExpiringIn(-3 * DAY_MS);

    const service = serviceWithGapBeforeFirstNotify(async () => {
      await approveMembershipPayment(t, renewed.userId, "renewal");
      await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, disabled.userId));
    });
    const result = await service.run(t.clock.now());

    expect(result).toEqual({ reminders: 0, expiredNotices: 1 });
    expect(await inboxOf(renewed.userId)).toHaveLength(0);
    expect(await inboxOf(disabled.userId)).toHaveLength(0);
    expect((await inboxOf(unchanged.userId)).map((n) => n.title)).toEqual(["Masa KTA telah berakhir"]);
  });

  it("AC F07-5, ARCHITECTURE §4.8: job terdaftar setiap jam di JobRegistry lewat modul job yang dimuat worker", () => {
    const job = t.jobs.registry.scheduledJob(EXPIRY_REMINDERS_JOB);
    expect(job?.everyMs).toBe(3600_000);
    expect(WORKER_MODULES).toContain(MembershipJobsModule);
  });
});
