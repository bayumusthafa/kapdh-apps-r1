import {
  alumni,
  auditLogs,
  membershipEvents,
  notifications,
  outboxEvents,
  payments,
  sessions,
  users,
} from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Tx } from "../../src/core/db/types.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { PaymentHandlerRegistry } from "../../src/core/payments-kernel/payment-handler.registry.js";
import { qrBindingMatches, QrTokenService } from "../../src/core/qr/qr-token.service.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  createMembershipPayment,
  signInAlumni,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
let kernel: MembershipKernel;

beforeAll(async () => {
  t = await createTestApp();
  kernel = t.app.get(MembershipKernel);
});
afterAll(async () => {
  await t.app.close();
});

const DAY = 24 * 3600_000;

/** Transaksi withTx dalam konteks system (seperti job/CLI): audit membutuhkan aktor dan request_id dari ctx(). */
function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAsSystem(() => withTx(t.db, fn));
}

async function profileOf(userId: string) {
  const [row] = await t.db.select().from(alumni).where(eq(alumni.userId, userId));
  return row!;
}

async function eventsOf(userId: string) {
  return t.db.select().from(membershipEvents).where(eq(membershipEvents.userId, userId));
}

async function notificationsOf(userId: string) {
  return t.db.select().from(notifications).where(eq(notifications.userId, userId));
}

async function auditsOf(entityId: string, action: string) {
  return t.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)));
}

describe("MembershipKernel.effectiveStatusFor (PRD 2.2, 4.2; AC F07-3)", () => {
  it("dihitung dari data canonical saat ini untuk setiap status, termasuk batch; bukan alumni → null", async () => {
    const statuses: AlumniFixtureStatus[] = [
      "pending_otp",
      "unverified",
      "verified",
      "expiring",
      "expired",
      "suspended",
    ];
    const created = await Promise.all(statuses.map((status) => createAlumni(t, { status })));
    for (const member of created)
      expect((await kernel.effectiveStatusFor(member.userId))?.status, member.status).toBe(member.status);
    const batch = await kernel.effectiveStatusesFor(created.map((m) => m.userId));
    expect([...batch.values()].map((s) => s.status).sort()).toEqual([...statuses].sort());

    const admin = await createAdmin(t);
    expect(await kernel.effectiveStatusFor(admin.userId)).toBeNull();
    expect(await kernel.effectiveStatusFor(uuidv7())).toBeNull();

    // AC F07-3: batas waktu lewat tanpa worker → expired dari timestamp.
    const verified = created[statuses.indexOf("expiring")]!;
    const later = new Date(verified.expiresAt!.getTime() + 1000);
    expect((await kernel.effectiveStatusFor(verified.userId, { now: later }))?.status).toBe("expired");
  });

  it("tingkat akses @MemberAccess: active hanya verified/expiring; suspended → ACCOUNT_SUSPENDED", () => {
    expect(kernel.allows("active", "expiring")).toBe(true);
    expect(kernel.allows("active", "expired")).toBe(false);
    expect(kernel.allows("nonsuspended", "unverified")).toBe(true);
    expect(() => kernel.assertAccess("nonsuspended", "suspended")).toThrow(
      expect.objectContaining({ code: "ACCOUNT_SUSPENDED", status: 403 }),
    );
    expect(() => kernel.assertAccess("active", "unverified")).toThrow(
      expect.objectContaining({ code: "MEMBERSHIP_REQUIRED", status: 403 }),
    );
    expect(() => kernel.assertAccess("any", "pending_otp")).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe("MembershipKernel.allocateMemberNumber (AC F05-1)", () => {
  it("nomor dialokasikan sekali dari sequence dan tidak berubah pada pemanggilan ulang", async () => {
    const member = await createAlumni(t, {
      status: "pending_otp",
      cohort: 25,
      classIn: 4,
      classOut: 6,
      gender: "female",
    });
    const first = await inTx((tx) => kernel.allocateMemberNumber(tx, member.userId));
    expect(first).toMatch(/^25\.02\.02\.[1-9]\d*$/);
    const again = await inTx((tx) => kernel.allocateMemberNumber(tx, member.userId));
    expect(again).toBe(first);
    const profile = await profileOf(member.userId);
    expect(profile.memberNumber).toBe(first);
    expect(String(profile.memberSeq)).toBe(first!.split(".")[3]);
    expect(await inTx((tx) => kernel.allocateMemberNumber(tx, uuidv7()))).toBeNull();
  });
});

describe("MembershipKernel.applyPaidPayment (PRD 3.7; AC F04-1, F04-5, F05-1, F07-1, F07-2, F07-4)", () => {
  it("registration: periode mulai approved_at +12 bulan kalender Jakarta; histori dan audit; idempoten; tanpa notifikasi kedua", async () => {
    const member = await createAlumni(t, { status: "unverified" });
    const payment = await createMembershipPayment(t, { userId: member.userId, type: "registration" });
    const approvedAt = new Date("2026-01-31T10:00:00Z");
    const result = await inTx((tx) => kernel.applyPaidPayment(tx, payment, approvedAt));
    expect(result).toMatchObject({
      outcome: "applied",
      applied: true,
      kind: "activation",
      periodStartsAt: approvedAt,
      periodExpiresAt: addCalendarMonthsJakarta(approvedAt, 12),
    });
    const profile = await profileOf(member.userId);
    expect(profile.startsAt).toEqual(approvedAt);
    expect(profile.expiresAt).toEqual(addCalendarMonthsJakarta(approvedAt, 12));
    expect(profile.memberNumber).toBe(member.memberNumber);
    const events = await eventsOf(member.userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "activation", paymentId: payment.id, beforeExpiresAt: null });
    expect(await auditsOf(member.userId, "membership.activated")).toHaveLength(1);
    // AC F13-1: satu keputusan = satu notification_id. Notifikasi keputusan (kategori payment, /payments/{id}) ditulis
    // modul payments di transaksi yang sama; kernel tidak menambah notifikasi membership kedua.
    expect(await notificationsOf(member.userId)).toHaveLength(0);
    expect(
      await t.db.select().from(outboxEvents).where(eq(outboxEvents.topic, "notification.created")),
    ).toEqual([]);

    // AC F04-5: pemanggilan ulang (retry worker/handler) tidak memperpanjang dua kali.
    const again = await inTx((tx) => kernel.applyPaidPayment(tx, payment, new Date()));
    expect(again).toMatchObject({ outcome: "already_applied", applied: false, eventId: result.eventId });
    expect((await profileOf(member.userId)).expiresAt).toEqual(profile.expiresAt);
    expect(await eventsOf(member.userId)).toHaveLength(1);

    // Status dihitung ulang dari periode baru.
    expect(
      (await kernel.effectiveStatusFor(member.userId, { now: new Date("2026-02-01T00:00:00Z") }))?.status,
    ).toBe("verified");
  });

  it("AC F07-1: renewal sebelum habis dimulai dari expires_at lama (sisa masa aktif tidak hilang)", async () => {
    const member = await createAlumni(t, { status: "expiring" });
    const before = await profileOf(member.userId);
    const payment = await createMembershipPayment(t, { userId: member.userId, type: "renewal" });
    const approvedAt = t.clock.now();
    const result = await inTx((tx) => kernel.applyPaidPayment(tx, payment, approvedAt));
    expect(result).toMatchObject({ kind: "renewal", periodStartsAt: before.expiresAt });
    const after = await profileOf(member.userId);
    expect(after.expiresAt).toEqual(addCalendarMonthsJakarta(before.expiresAt!, 12));
    // Rentang berjalan bersambung: starts_at tetap.
    expect(after.startsAt).toEqual(before.startsAt);
    expect(after.version).toBe(before.version + 1);
    const [event] = await eventsOf(member.userId);
    expect(event).toMatchObject({
      kind: "renewal",
      beforeExpiresAt: before.expiresAt,
      afterStartsAt: before.expiresAt,
      afterExpiresAt: after.expiresAt,
    });
  });

  it("AC F07-2: renewal setelah expired dihitung dari approved_at; akses aktif kembali", async () => {
    const member = await createAlumni(t, { status: "expired" });
    const payment = await createMembershipPayment(t, { userId: member.userId, type: "renewal" });
    const approvedAt = t.clock.now();
    await inTx((tx) => kernel.applyPaidPayment(tx, payment, approvedAt));
    const after = await profileOf(member.userId);
    expect(after.startsAt).toEqual(approvedAt);
    expect(after.expiresAt).toEqual(addCalendarMonthsJakarta(approvedAt, 12));
    expect((await kernel.effectiveStatusFor(member.userId))?.status).toBe("verified");
  });

  it("AC F07-4: anggota suspended — periode diperbarui tetapi effective_status tetap suspended", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const before = await profileOf(member.userId);
    const payment = await createMembershipPayment(t, { userId: member.userId, type: "renewal" });
    await inTx((tx) => kernel.applyPaidPayment(tx, payment, t.clock.now()));
    const after = await profileOf(member.userId);
    expect(after.expiresAt).toEqual(addCalendarMonthsJakarta(before.expiresAt!, 12));
    expect(after.suspendedAt).toEqual(before.suspendedAt);
    expect((await kernel.effectiveStatusFor(member.userId))?.status).toBe("suspended");
  });

  it("kontrak adminDecidePayment: pemilik terhapus (user_id NULL / akun deleted) → paid tanpa efek keanggotaan", async () => {
    // Baris users dihapus: payments.user_id menjadi NULL (ON DELETE SET NULL), profil alumni ikut terhapus.
    const gone = await createAlumni(t, { status: "unverified" });
    const orphan = await createMembershipPayment(t, { userId: gone.userId });
    await t.db.delete(users).where(eq(users.id, gone.userId));
    const [orphanRow] = await t.db.select().from(payments).where(eq(payments.id, orphan.id));
    expect(orphanRow!.userId).toBeNull();
    expect(await inTx((tx) => kernel.applyPaidPayment(tx, orphan, t.clock.now()))).toEqual({
      outcome: "owner_deleted",
      applied: false,
      kind: "activation",
      eventId: null,
      periodStartsAt: null,
      periodExpiresAt: null,
    });
    // Hook pra-kunci iuran melewati pemilik yang sudah tidak ada.
    const registry = t.app.get(PaymentHandlerRegistry);
    await inTx((tx) => registry.lockRelated(tx, { ...orphanRow!, type: "registration" }));
    await inTx((tx) => registry.handlerFor("registration").onApproved(tx, orphanRow!, t.clock.now()));
    expect(
      await t.db.select().from(membershipEvents).where(eq(membershipEvents.paymentId, orphan.id)),
    ).toEqual([]);

    // Akun berstatus deleted (baris dipertahankan): tidak pernah diaktifkan.
    const deleted = await createAlumni(t, { status: "unverified", accountStatus: "deleted" });
    const payment = await createMembershipPayment(t, { userId: deleted.userId, type: "registration" });
    expect(await inTx((tx) => kernel.applyPaidPayment(tx, payment, t.clock.now()))).toMatchObject({
      outcome: "owner_deleted",
    });
    expect((await profileOf(deleted.userId)).expiresAt).toBeNull();
    expect(await eventsOf(deleted.userId)).toHaveLength(0);
  });

  it("menolak payment belum paid, registration ganda, renewal sebelum aktivasi, dan payment tiket", async () => {
    const unverified = await createAlumni(t, { status: "unverified" });
    const pending = await createMembershipPayment(t, { userId: unverified.userId, status: "pending" });
    await expect(inTx((tx) => kernel.applyPaidPayment(tx, pending, t.clock.now()))).rejects.toMatchObject({
      status: 409,
      code: "PAYMENT_STATE_CONFLICT",
    });
    const renewal = await createMembershipPayment(t, { userId: unverified.userId, type: "renewal" });
    await expect(inTx((tx) => kernel.applyPaidPayment(tx, renewal, t.clock.now()))).rejects.toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
    const active = await createAlumni(t, { status: "verified" });
    const duplicate = await createMembershipPayment(t, { userId: active.userId, type: "registration" });
    await expect(inTx((tx) => kernel.applyPaidPayment(tx, duplicate, t.clock.now()))).rejects.toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
    await expect(
      inTx((tx) => kernel.applyPaidPayment(tx, { id: uuidv7() }, t.clock.now())),
    ).rejects.toMatchObject({ status: 404 });
    expect(await eventsOf(unverified.userId)).toHaveLength(0);
  });

  it("wajib tx commit-aware (bukan savepoint); rollback membatalkan periode, histori, dan audit", async () => {
    const member = await createAlumni(t, { status: "unverified" });
    const payment = await createMembershipPayment(t, { userId: member.userId });
    await expect(
      runAsSystem(() =>
        t.db.transaction((tx) => tx.transaction((sp) => kernel.applyPaidPayment(sp, payment, t.clock.now()))),
      ),
    ).rejects.toThrow(/wajib dipanggil dengan tx commit-aware/);
    await expect(
      inTx(async (tx) => {
        await kernel.applyPaidPayment(tx, payment, t.clock.now());
        throw new Error("keputusan dibatalkan");
      }),
    ).rejects.toThrow("keputusan dibatalkan");
    expect((await profileOf(member.userId)).expiresAt).toBeNull();
    expect(await eventsOf(member.userId)).toHaveLength(0);
    expect(await auditsOf(member.userId, "membership.activated")).toHaveLength(0);
  });

  it("ARCHITECTURE §4.10: db.transaction dari DB yang diinjeksi commit-aware → kernel diterima dan efek menunggu commit", async () => {
    const member = await createAlumni(t, { status: "unverified" });
    const payment = await createMembershipPayment(t, { userId: member.userId });
    const result = await runAsSystem(() =>
      t.db.transaction((tx) => kernel.applyPaidPayment(tx, payment, t.clock.now())),
    );
    expect(result.outcome).toBe("applied");
    expect((await kernel.effectiveStatusFor(member.userId))?.status).toBe("verified");
  });
});

describe("PaymentHandlerRegistry (ARCHITECTURE §4.6)", () => {
  it("core mendaftarkan handler registration/renewal yang memanggil applyPaidPayment; ticket milik modul events", async () => {
    const registry = t.app.get(PaymentHandlerRegistry);
    expect(registry.types().sort()).toEqual(expect.arrayContaining(["registration", "renewal"]));
    expect(() => registry.register({ type: "registration", onApproved: async () => {} })).toThrow(
      /sudah terdaftar/,
    );

    const member = await createAlumni(t, { status: "unverified" });
    const payment = await createMembershipPayment(t, { userId: member.userId });
    await inTx((tx) => registry.handlerFor("registration").onApproved(tx, payment, t.clock.now()));
    await inTx((tx) => registry.handlerFor("registration").onApproved(tx, payment, t.clock.now()));
    expect(await eventsOf(member.userId)).toHaveLength(1);
    expect((await kernel.effectiveStatusFor(member.userId))?.status).toBe("verified");

    if (!registry.has("ticket")) expect(() => registry.handlerFor("ticket")).toThrow(/belum terdaftar/);
  });

  it("URUTAN KUNCI kontrak C3: handler iuran core memiliki hook pra-kunci users → alumni pemilik", async () => {
    const registry = t.app.get(PaymentHandlerRegistry);
    for (const type of ["registration", "renewal"] as const)
      expect(registry.handlerFor(type).lockRelated, type).toBeTypeOf("function");
    const member = await createAlumni(t, { status: "expiring" });
    const payment = await createMembershipPayment(t, { userId: member.userId, type: "renewal" });
    // Pola modul payments: baca tanpa kunci → hook pra-kunci → payment FOR UPDATE → onApproved (kunci dipakai ulang).
    const outcome = await inTx(async (tx) => {
      await registry.lockRelated(tx, payment);
      await tx.select().from(payments).where(eq(payments.id, payment.id)).for("update");
      return kernel.applyPaidPayment(tx, payment, t.clock.now());
    });
    expect(outcome.outcome).toBe("applied");
  });

  it("kontrak C3/C5: lockRelated menerima user_id + ticket_id (jenis tanpa hook = no-op); onApproved dapat melaporkan refund D6", async () => {
    const registry = new PaymentHandlerRegistry();
    const calls: string[] = [];
    registry.register({ type: "registration", onApproved: async () => {} });
    registry.register({
      type: "ticket",
      lockRelated: async (_tx, payment) => {
        calls.push(`lock:${payment.ticketId}:${payment.userId}`);
      },
      onApproved: async () => ({
        refund: { amount: "75000.00", dueAt: new Date("2026-10-23T00:00:00Z"), reason: "Event dibatalkan" },
      }),
    });
    const ticketId = uuidv7();
    const userId = uuidv7();
    await inTx((tx) => registry.lockRelated(tx, { id: uuidv7(), type: "ticket", ticketId, userId }));
    await inTx((tx) =>
      registry.lockRelated(tx, { id: uuidv7(), type: "registration", ticketId: null, userId }),
    );
    expect(calls).toEqual([`lock:${ticketId}:${userId}`]);
    const outcome = await registry
      .handlerFor("ticket")
      .onApproved(undefined as never, {} as never, new Date());
    expect(outcome).toMatchObject({ refund: { amount: "75000.00", reason: "Event dibatalkan" } });
  });
});

describe("MembershipKernel.suspend / unsuspend (AC F12-3, F12-4, F12-5)", () => {
  it("AC F12-4: suspend mencabut sesi umum (session_version naik), mencatat histori/audit, dan memberi pesan aman", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const moderator = await createAdmin(t, { permissions: ["moderation.resolve"] });
    const session = await signInAlumni(t, member);
    const api = httpClient(t.app);
    expect((await api.get("/me", { token: session.accessToken })).statusCode).toBe(200);
    const [userBefore] = await t.db.select().from(users).where(eq(users.id, member.userId));

    const result = await inTx((tx) =>
      kernel.suspend(tx, member.userId, {
        reason: "Spam berulang di grup (catatan internal)",
        memberMessage: "Akun Anda dibatasi karena melanggar ketentuan komunitas.",
        actorAdminId: moderator.adminId,
      }),
    );
    expect(result.sessionsRevoked).toBe(1);
    const [userAfter] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(userAfter!.sessionVersion).toBe(userBefore!.sessionVersion + 1);
    const active = await t.db.select().from(sessions).where(eq(sessions.userId, member.userId));
    expect(active.every((s) => s.revokedAt !== null)).toBe(true);
    // Access token lama langsung ditolak (AuthGuard memeriksa sesi + session_version).
    expect((await api.get("/me", { token: session.accessToken })).statusCode).toBe(401);

    const profile = await profileOf(member.userId);
    expect(profile).toMatchObject({
      suspensionReason: "Spam berulang di grup (catatan internal)",
      suspendedByAdminId: moderator.adminId,
    });
    expect(profile.suspendedAt).toEqual(t.clock.now());
    const [event] = await eventsOf(member.userId);
    expect(event).toMatchObject({
      kind: "suspend",
      actorAdminId: moderator.adminId,
      afterExpiresAt: profile.expiresAt,
    });
    const [audit] = await auditsOf(member.userId, "member.suspended");
    expect(audit).toMatchObject({ reason: "Spam berulang di grup (catatan internal)" });
    const [notice] = await notificationsOf(member.userId);
    expect(notice).toMatchObject({
      category: "account",
      body: "Akun Anda dibatasi karena melanggar ketentuan komunitas.",
      data: { route: "/restricted" },
    });
    expect(JSON.stringify(notice)).not.toContain("catatan internal");

    // Masuk lagi: hanya portal pembatasan (effective_status suspended + pesan aman).
    const relogin = await signInAlumni(t, member);
    const me = (await api.get("/me", { token: relogin.accessToken })).json() as Record<string, unknown>;
    expect(me).toMatchObject({
      effective_status: "suspended",
      suspension_message: "Akun Anda dibatasi karena melanggar ketentuan komunitas.",
    });

    // Kontrak adminSuspendMember: prasyarat dilanggar → 400 dengan versi terkini (bukan 409).
    await expect(
      inTx((tx) =>
        kernel.suspend(tx, member.userId, { reason: "lagi", memberMessage: "lagi", actorAdminId: null }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: { current: { version: String(profile.version), account_status: "active" } },
    });
    await expect(
      inTx((tx) =>
        kernel.suspend(tx, member.userId, { reason: "  ", memberMessage: "x", actorAdminId: null }),
      ),
    ).rejects.toMatchObject({ status: 400, extra: { fieldErrors: { reason: expect.any(Array) } } });
    await expect(
      inTx((tx) => kernel.suspend(tx, uuidv7(), { reason: "x", memberMessage: "x", actorAdminId: null })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("kontrak adminSuspendMember: akun deletion_pending tidak dapat dibatasi (400, tanpa perubahan)", async () => {
    const pending = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
    expect(pending.deletionRequestNumber).toMatch(/^DEL-\d{4}-[0-9A-Z]{4,}$/);
    await expect(
      inTx((tx) =>
        kernel.suspend(tx, pending.userId, { reason: "uji", memberMessage: "uji", actorAdminId: null }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: { current: { account_status: "deletion_pending", suspended_at: null } },
    });
    expect((await profileOf(pending.userId)).suspendedAt).toBeNull();
    expect(await eventsOf(pending.userId)).toHaveLength(0);
  });

  it("AC F12-5: unsuspend menghitung ulang dari expires_at — masa habis menjadi expired, bukan verified", async () => {
    const lapsed = await createAlumni(t, { status: "suspended" });
    t.clock.advance(400 * DAY);
    const outcome = await inTx((tx) =>
      kernel.unsuspend(tx, lapsed.userId, { reason: "Banding diterima", actorAdminId: null }),
    );
    expect(outcome.effectiveStatus).toBe("expired");
    expect((await kernel.effectiveStatusFor(lapsed.userId))?.status).toBe("expired");
    const [notice] = (await notificationsOf(lapsed.userId)).filter(
      (n) => n.title === "Pembatasan akun dicabut",
    );
    expect(notice!.data).toEqual({ route: "/renewal" });
    // Tanpa member_message: teks baku kontrak adminUnsuspendMember.
    expect(notice!.body).toContain("Pembatasan akun Anda telah dicabut pengurus.");

    const current = await createAlumni(t, { status: "suspended" });
    const restored = await inTx((tx) =>
      kernel.unsuspend(tx, current.userId, { reason: "Banding diterima", actorAdminId: null }),
    );
    expect(restored.effectiveStatus).toBe("verified");
    expect(await auditsOf(current.userId, "member.unsuspended")).toHaveLength(1);
    const kinds = (await eventsOf(current.userId)).map((e) => e.kind);
    expect(kinds).toEqual(["unsuspend"]);
    // Kontrak adminUnsuspendMember: anggota tidak sedang suspended → 400 dengan versi terkini.
    await expect(
      inTx((tx) => kernel.unsuspend(tx, current.userId, { reason: "x", actorAdminId: null })),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: { current: { suspended_at: null } },
    });
  });

  it("kontrak adminUnsuspendMember: SATU notifikasi memuat member_message; banding dikabulkan dinyatakan", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    await inTx((tx) =>
      kernel.unsuspend(tx, member.userId, {
        reason: "Banding diterima pengurus",
        memberMessage: "Terima kasih atas klarifikasinya",
        appealGranted: true,
        actorAdminId: null,
      }),
    );
    const inbox = await notificationsOf(member.userId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      category: "account",
      title: "Banding dikabulkan",
      data: { route: "/kta" },
    });
    expect(inbox[0]!.body).toContain("Banding Anda dikabulkan.");
    expect(inbox[0]!.body).toContain("Terima kasih atas klarifikasinya.");
    expect(inbox[0]!.body).not.toContain("Banding diterima pengurus");
    const [audit] = await auditsOf(member.userId, "member.unsuspended");
    expect(audit!.after).toMatchObject({ appeal_granted: true, effective_status: "verified" });
  });
});

describe("MembershipKernel.correctIdentity (PRD 3.5, AC F05-6)", () => {
  it("12.02.01.N → 12.01.01.N saat kelas keluar dikoreksi menjadi 6; N tetap; audit + histori nomor lama/baru", async () => {
    const member = await createAlumni(t, {
      status: "verified",
      cohort: 12,
      classIn: 1,
      classOut: 3,
      gender: "male",
    });
    const seq = member.memberSeq!;
    expect(member.memberNumber).toBe(`12.02.01.${seq}`);
    const admin = await createAdmin(t, { permissions: ["members.manage"] });
    const before = await profileOf(member.userId);

    const result = await inTx((tx) =>
      kernel.correctIdentity(
        tx,
        member.userId,
        { classOut: 6 },
        { adminId: admin.adminId },
        "Data rapor terverifikasi",
        {
          expectedVersion: before.version,
        },
      ),
    );
    expect(result).toEqual({
      changed: true,
      previousMemberNumber: `12.02.01.${seq}`,
      memberNumber: `12.01.01.${seq}`,
      version: before.version + 1,
    });
    const after = await profileOf(member.userId);
    expect(after).toMatchObject({ classOut: 6, memberSeq: seq, memberNumber: `12.01.01.${seq}` });
    const [event] = await eventsOf(member.userId);
    expect(event).toMatchObject({
      kind: "number_correction",
      beforeMemberNumber: `12.02.01.${seq}`,
      afterMemberNumber: `12.01.01.${seq}`,
      actorAdminId: admin.adminId,
    });
    const [audit] = await auditsOf(member.userId, "member.number_corrected");
    expect(audit!.before).toMatchObject({ member_number: `12.02.01.${seq}`, class_out: 3 });
    expect(audit!.after).toMatchObject({ member_number: `12.01.01.${seq}`, class_out: 6 });

    // AC F05-6: QR lama (URL nomor lama) menjadi "perlu diperbarui"; kartu terbitan ulang memuat nomor baru dan lolos.
    const qr = t.app.get(QrTokenService);
    const signed = (await qr.sign({
      userId: member.userId,
      memberSeq: seq,
      membershipExpiresAt: after.expiresAt!,
    }))!;
    const claims = (await qr.verify(signed.token))!;
    const current = { userId: member.userId, memberSeq: after.memberSeq, memberNumber: after.memberNumber };
    expect(qrBindingMatches(claims, current, `12.01.01.${seq}`)).toBe(true);
    expect(qrBindingMatches(claims, current, `12.02.01.${seq}`)).toBe(false);
  });

  it("validasi kelas/angkatan, versi usang → 409 dengan keadaan terbaru, tanpa perubahan → changed false", async () => {
    const member = await createAlumni(t, { status: "verified", cohort: 20, classIn: 4, classOut: 6 });
    const profile = await profileOf(member.userId);
    const correct = (changes: Parameters<MembershipKernel["correctIdentity"]>[2], version?: number) =>
      inTx((tx) =>
        kernel.correctIdentity(tx, member.userId, changes, { adminId: null }, "Koreksi data", {
          expectedVersion: version,
        }),
      );
    await expect(correct({ classOut: 3 })).rejects.toMatchObject({ status: 400 });
    await expect(correct({ cohort: 99 })).rejects.toMatchObject({
      status: 400,
      extra: { fieldErrors: { cohort: expect.any(Array) } },
    });
    await expect(correct({ gender: "female" }, profile.version + 5)).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      extra: { current: { member_number: profile.memberNumber, version: String(profile.version) } },
    });
    await expect(
      inTx((tx) => kernel.correctIdentity(tx, member.userId, { gender: "female" }, { adminId: null }, " ")),
    ).rejects.toMatchObject({ status: 400 });
    expect(await correct({ classIn: 4 })).toMatchObject({
      changed: false,
      memberNumber: profile.memberNumber,
    });
    expect(await eventsOf(member.userId)).toHaveLength(0);
  });

  it("tanpa nomor (belum aktivasi) → audit member.identity_corrected; deletion_pending → 400", async () => {
    const unverified = await createAlumni(t, { status: "pending_otp", cohort: 20 });
    const corrected = await inTx((tx) =>
      kernel.correctIdentity(tx, unverified.userId, { cohort: 21 }, { adminId: null }, "Koreksi angkatan"),
    );
    expect(corrected).toMatchObject({ changed: true, memberNumber: null });
    expect(await auditsOf(unverified.userId, "member.identity_corrected")).toHaveLength(1);
    expect(await auditsOf(unverified.userId, "member.number_corrected")).toHaveLength(0);

    const pending = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
    await expect(
      inTx((tx) => kernel.correctIdentity(tx, pending.userId, { classOut: 5 }, { adminId: null }, "Koreksi")),
    ).rejects.toMatchObject({ status: 400, extra: { current: { account_status: "deletion_pending" } } });
  });
});
