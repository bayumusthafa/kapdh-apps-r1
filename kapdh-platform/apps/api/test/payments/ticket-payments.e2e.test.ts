import {
  auditLogs,
  events,
  notifications,
  outboxEvents,
  paymentAdjustments,
  paymentEvents,
  payments,
  tickets,
} from "@kapdh/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../../src/core/db/rows.js";
import { AppException } from "../../src/core/errors/app-exception.js";
import { addBusinessDaysJakarta, addBusinessDaysSql } from "../../src/modules/payments/business-days.js";
import { refundDueAt } from "../../src/modules/payments/payment-rules.js";
import { PaymentsKernel } from "../../src/modules/payments/payments.kernel.js";
import { expectOperation } from "../support/contract.js";
import { createPaymentMethod, createMembershipPayment } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import {
  adminSession,
  createInstruction,
  createPaymentsApp,
  DAY,
  decide,
  HOUR,
  inContext,
  memberActor,
  memberSession,
  systemActor,
  ticketFixture,
  uploadProof,
  type JsonBody,
} from "./support.js";

/**
 * Pembayaran tiket di modul payments (aturan tag Events dan kontrak C3; F-09 sisi pembayaran, AC F09-2, F09-4, D5,
 * D6) dan API lintas modul PaymentsKernel. Handler tiket penguji dipakai selama modul events belum mendaftarkan
 * handler `ticket` (test/payments/support.ts).
 */

let t: TestApp;
let kernel: PaymentsKernel;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createPaymentsApp();
  kernel = t.app.get(PaymentsKernel);
});
afterAll(async () => {
  await t.app.close();
});

async function ticketRow(ticketId: string) {
  const [row] = await t.db.select().from(tickets).where(eq(tickets.id, ticketId));
  return row!;
}
async function eventRow(eventId: string) {
  const [row] = await t.db.select().from(events).where(eq(events.id, eventId));
  return row!;
}

describe("PaymentsKernel.createPayment dan bukti tiket (F-09, D5)", () => {
  it("F-09: payment tiket disnapshot (baris, metode, settings_version null); detail anggota memuat tiket", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member);
    const [row] = await t.db.select().from(payments).where(eq(payments.id, fixture.paymentId));
    expect(row).toMatchObject({
      type: "ticket",
      status: "pending",
      amount: "75000.00",
      settingsVersion: null,
      ticketId: fixture.ticketId,
      paymentMethodId: fixture.methodId,
    });
    const res = await api().get(`/me/payments/${fixture.paymentId}`, { token: member.token });
    const body = expectOperation("get", "/me/payments/{paymentId}", res) as JsonBody;
    expect(body).toMatchObject({
      stage: "awaiting_transfer",
      lines: [{ code: "ticket", label: "Tiket event", amount: "75000.00" }],
      ticket: {
        ticket_id: fixture.ticketId,
        event_title: "Reuni Akbar Uji",
        ticket_status: "awaiting_payment",
        event_status: "open",
        event_timezone: "Asia/Jakarta",
      },
      instructions_hidden: false,
      actions: { can_submit_proof: true, can_change_method: true, can_cancel: false },
      events: [{ kind: "created", actor: "member" }],
    });
    const inactive = await createPaymentMethod(t, { active: false });
    const refused = await inContext(memberActor(member.userId), () =>
      t.db
        .transaction((tx) =>
          kernel.createPayment(tx, {
            userId: member.userId,
            type: "ticket",
            ticketId: fixture.ticketId,
            amount: "75000.00",
            lines: [{ code: "ticket", amount: "75000.00" }],
            paymentMethodId: inactive.id,
          }),
        )
        .catch((error: unknown) => error),
    );
    expect(refused).toBeInstanceOf(AppException);
    expect((refused as AppException).extra.fieldErrors?.payment_method_id).toBeDefined();
  });

  it("AC F09-2, F04-1: bukti sebelum hold → tiket awaiting_review dan kursi ditahan; approve → tiket paid + QR", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member);
    const proof = await api().put(
      `/me/payments/${fixture.paymentId}/proof`,
      { file_id: await uploadProof(t, member.token), expected_proof_version: 0 },
      { token: member.token },
    );
    const detail = expectOperation("put", "/me/payments/{paymentId}/proof", proof) as JsonBody;
    expect(detail).toMatchObject({ stage: "awaiting_review", ticket: { ticket_status: "awaiting_review" } });
    expect((await eventRow(fixture.eventId)).heldQuantity).toBe(1);
    const admin = await adminSession(t);
    const queue = (
      await api().get("/admin/payments", {
        token: admin.token,
        query: { type: "ticket", event_id: fixture.eventId },
      })
    ).json();
    expect(queue.items[0]).toMatchObject({
      id: fixture.paymentId,
      event_title: "Reuni Akbar Uji",
      ticket_status: "awaiting_review",
      event_cancelled: false,
    });
    const approved = await decide(t, admin, fixture.paymentId, {
      decision: "approve",
      expected_proof_version: 1,
      expected_version: detail.version,
      funds_verified: true,
    });
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", approved)).toMatchObject({
      status: "paid",
      ticket: { ticket_status: "paid" },
      period: null,
      settings_version: null,
    });
    const ticket = await ticketRow(fixture.ticketId);
    expect(ticket.status).toBe("paid");
    expect(ticket.qrCode).not.toBeNull();
    expect(await eventRow(fixture.eventId)).toMatchObject({ heldQuantity: 0, paidQuantity: 1 });
  });

  it("AC F09-2: bukti sesudah hold habis → kedaluwarsa di-commit tepat sekali lalu 409 RESERVATION_EXPIRED dengan current", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member, { holdMs: 2 * HOUR });
    t.clock.advance(2 * HOUR + 1000);
    const memberToken = (await relogin(member)).token;
    const lapsedView = (await api().get(`/me/payments/${fixture.paymentId}`, { token: memberToken })).json();
    // Respons BACA memproyeksikan hold yang habis sebagai expired (aturan tag Events) dan menutup tindakan.
    expect(lapsedView).toMatchObject({
      ticket: { ticket_status: "expired" },
      actions: { can_submit_proof: false, can_change_method: false },
    });
    const changeMethod = await api().put(
      `/me/payments/${fixture.paymentId}/method`,
      { payment_method_id: fixture.methodId },
      { token: memberToken, headers: { "if-match": lapsedView.version } },
    );
    expect(expectOperation("put", "/me/payments/{paymentId}/method", changeMethod)).toMatchObject({
      code: "RESERVATION_EXPIRED",
    });
    const file = await uploadProof(t, memberToken);
    const res = await api().put(
      `/me/payments/${fixture.paymentId}/proof`,
      { file_id: file, expected_proof_version: 0 },
      { token: memberToken },
    );
    expect(expectOperation("put", "/me/payments/{paymentId}/proof", res)).toMatchObject({
      code: "RESERVATION_EXPIRED",
      current: { status: "cancelled", ticket: { ticket_status: "expired" } },
    });
    expect((await ticketRow(fixture.ticketId)).status).toBe("expired");
    expect((await eventRow(fixture.eventId)).heldQuantity).toBe(0);
    const history = await t.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, fixture.paymentId))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
    expect(history.at(-1)).toMatchObject({ kind: "cancelled", actorUserId: null, actorAdminId: null });
    const again = await api().put(
      `/me/payments/${fixture.paymentId}/proof`,
      { file_id: file, expected_proof_version: 0 },
      { token: memberToken },
    );
    expect(again.json().code).toBe("RESERVATION_EXPIRED");
    expect((await eventRow(fixture.eventId)).heldQuantity).toBe(0);
  });

  it("AC F09-4: tolak bukti tiket → payment rejected final, tiket cancelled, hold dilepas; bukti baru 409", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member);
    const proof = (
      await api().put(
        `/me/payments/${fixture.paymentId}/proof`,
        { file_id: await uploadProof(t, member.token), expected_proof_version: 0 },
        { token: member.token },
      )
    ).json();
    const admin = await adminSession(t);
    const rejected = await decide(t, admin, fixture.paymentId, {
      decision: "reject",
      expected_proof_version: 1,
      expected_version: proof.version,
      reason: "Transfer tidak ditemukan",
    });
    expect(rejected.json()).toMatchObject({ status: "rejected", stage: "rejected_final" });
    expect((await ticketRow(fixture.ticketId)).status).toBe("cancelled");
    expect((await eventRow(fixture.eventId)).heldQuantity).toBe(0);
    const resubmit = await api().put(
      `/me/payments/${fixture.paymentId}/proof`,
      { file_id: await uploadProof(t, member.token), expected_proof_version: 1 },
      { token: member.token },
    );
    expect(expectOperation("put", "/me/payments/{paymentId}/proof", resubmit)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { stage: "rejected_final", actions: { can_submit_proof: false } },
    });
  });

  it("AC F09-7, D6, F13-1: payment berbukti yang tiketnya batal karena event dibatalkan → refund_on_approve; approve membuat refund sistem dengan satu notifikasi keputusan", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member);
    const proof = (
      await api().put(
        `/me/payments/${fixture.paymentId}/proof`,
        { file_id: await uploadProof(t, member.token), expected_proof_version: 0 },
        { token: member.token },
      )
    ).json();
    // Modul events membatalkan event: tiket cancelled (system), payment berbukti dibiarkan (kontrak C3/C5).
    const cancelledAt = t.clock.now();
    await t.db
      .update(events)
      .set({ status: "cancelled", cancelledAt, cancelReason: "Cuaca buruk", heldQuantity: 0 })
      .where(eq(events.id, fixture.eventId));
    await t.db
      .update(tickets)
      .set({ status: "cancelled", cancelledAt, cancelledBy: "system", cancelReason: "Event dibatalkan" })
      .where(eq(tickets.id, fixture.ticketId));
    const kept = await inContext(systemActor(), () =>
      t.db.transaction((tx) => kernel.cancelForTicket(tx, fixture.ticketId, "Event dibatalkan")),
    );
    expect(kept.outcome).toBe("kept_with_proof");
    const admin = await adminSession(t);
    const detail = (await api().get(`/admin/payments/${fixture.paymentId}`, { token: admin.token })).json();
    expect(detail).toMatchObject({
      refund_on_approve: true,
      event_cancelled: true,
      ticket_status: "cancelled",
      ticket: { event_status: "cancelled", ticket_cancelled_by: "system" },
      actions: { can_decide: true },
    });
    // Tenggat dihitung dari pembatalan tiket, bukan dari waktu persetujuan.
    t.clock.advance(10 * 60_000);
    const inboxBefore = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, member.userId));
    const approved = await decide(t, admin, fixture.paymentId, {
      decision: "approve",
      expected_proof_version: 1,
      expected_version: proof.version,
      funds_verified: true,
    });
    const body = expectOperation("post", "/admin/payments/{paymentId}/decision", approved) as JsonBody;
    expect(body).toMatchObject({ status: "paid", ticket: { ticket_status: "cancelled" } });
    expect(body.adjustments).toEqual([
      expect.objectContaining({
        kind: "refund",
        amount: "75000.00",
        status: "pending",
        created_by: null,
        due_at: refundDueAt(cancelledAt).toISOString(),
      }),
    ]);
    expect((await ticketRow(fixture.ticketId)).qrCode).toBeNull();
    const owner = (await api().get(`/me/payments/${fixture.paymentId}`, { token: member.token })).json();
    expect(owner.adjustments[0]).toMatchObject({ destination_required: true });
    // AC F13-1: satu keputusan = satu notification_id; permintaan rekening tujuan refund ada di notifikasi itu.
    const inboxAfter = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    const created = inboxAfter.filter((row) => !inboxBefore.some((old) => old.id === row.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      category: "payment",
      title: "Dana tiket diterima, refund sedang diproses bendahara",
      data: { route: `/payments/${fixture.paymentId}`, payment_id: fixture.paymentId },
    });
    expect(created[0]!.body).toContain("rekening tujuan refund");
    const outbox = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `notification.created:${created[0]!.id}`));
    expect(outbox).toHaveLength(1);
  });

  it("PRD 4.3: anggota tidak membatalkan payment tiket (409); pengurus membatalkan payment tanpa bukti → tiket batal dan hold dilepas", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member);
    const view = (await api().get(`/me/payments/${fixture.paymentId}`, { token: member.token })).json();
    const own = await api().post(
      `/me/payments/${fixture.paymentId}/cancel`,
      {},
      { token: member.token, headers: { "if-match": view.version } },
    );
    expect(own.json().code).toBe("PAYMENT_STATE_CONFLICT");
    const admin = await adminSession(t);
    const res = await api().post(
      `/admin/payments/${fixture.paymentId}/cancel`,
      { reason: "Reservasi ganda" },
      { token: admin.token, headers: { "if-match": view.version } },
    );
    expect(res.json()).toMatchObject({ status: "cancelled", ticket: { ticket_status: "cancelled" } });
    expect((await eventRow(fixture.eventId)).heldQuantity).toBe(0);
  });

  it("D5: batas review tiket = yang lebih dahulu antara 2 hari kerja dan pembukaan check-in", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member, { startsInMs: DAY });
    await api().put(
      `/me/payments/${fixture.paymentId}/proof`,
      { file_id: await uploadProof(t, member.token), expected_proof_version: 0 },
      { token: member.token },
    );
    const admin = await adminSession(t, ["payments.read"]);
    const detail = (await api().get(`/admin/payments/${fixture.paymentId}`, { token: admin.token })).json();
    const event = await eventRow(fixture.eventId);
    expect(detail.review_due_at).toBe(new Date(event.startsAt.getTime() - 2 * HOUR).toISOString());
    expect(detail.event_starts_at).toBe(event.startsAt.toISOString());
  });
});

describe("PaymentsKernel lintas modul (events, account, dasbor)", () => {
  it("AC F09-2, F09-7: cancelForTicket tanpa bukti → cancelled tepat sekali; terminal → unchanged; tanpa payment → none", async () => {
    const member = await memberSession(t, "verified");
    const fixture = await ticketFixture(t, member);
    const first = await inContext(systemActor(), () =>
      t.db.transaction((tx) => kernel.cancelForTicket(tx, fixture.ticketId, "Batas reservasi habis")),
    );
    expect(first.outcome).toBe("cancelled");
    expect(first.payment).toMatchObject({ status: "cancelled", cancelReason: "Batas reservasi habis" });
    const second = await inContext(systemActor(), () =>
      t.db.transaction((tx) => kernel.cancelForTicket(tx, fixture.ticketId, "Batas reservasi habis")),
    );
    expect(second.outcome).toBe("unchanged");
    const none = await inContext(systemActor(), () =>
      t.db.transaction((tx) => kernel.cancelForTicket(tx, uuidv7(), "x")),
    );
    expect(none).toEqual({ outcome: "none", payment: null });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, fixture.paymentId), eq(auditLogs.action, "payment.cancelled")));
    expect(audit?.effectiveRole).toBe("system");
  });

  it("AC F09-7, D6: recordSystemRefund refund penuh sekali (pemanggilan ulang tidak menggandakan); payment selain paid ditolak", async () => {
    const member = await memberSession(t, "verified");
    const paid = await createMembershipPayment(t, { userId: member.userId, type: "renewal", status: "paid" });
    const dueAt = addBusinessDaysJakarta(t.clock.now(), 7);
    const first = await inContext(systemActor(), () =>
      t.db.transaction((tx) =>
        kernel.recordSystemRefund(tx, {
          paymentId: paid.id,
          amount: paid.amount,
          dueAt,
          reason: "Event dibatalkan",
        }),
      ),
    );
    expect(first).toMatchObject({
      kind: "refund",
      amount: "10000.00",
      createdByAdminId: null,
      status: "pending",
    });
    const second = await inContext(systemActor(), () =>
      t.db.transaction((tx) =>
        kernel.recordSystemRefund(tx, {
          paymentId: paid.id,
          amount: paid.amount,
          dueAt,
          reason: "Event dibatalkan",
        }),
      ),
    );
    expect(second).toBeNull();
    expect(
      await t.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.paymentId, paid.id)),
    ).toHaveLength(1);
    const pending = await createMembershipPayment(t, {
      userId: (await memberSession(t)).userId,
      status: "pending",
    });
    await expect(
      inContext(systemActor(), () =>
        t.db.transaction((tx) =>
          kernel.recordSystemRefund(tx, { paymentId: pending.id, amount: "1.00", dueAt, reason: "x" }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("AC F14-4: cancelUnprovenDues hanya iuran pending tanpa bukti yang dibatalkan; payment berbukti tetap", async () => {
    const member = await memberSession(t, "expiring");
    const registration = await createInstruction(t, member, "renewal");
    const proofed = await memberSession(t);
    const kept = await createInstruction(t, proofed);
    await api().put(
      `/me/payments/${kept.paymentId}/proof`,
      { file_id: await uploadProof(t, proofed.token), expected_proof_version: 0 },
      { token: proofed.token },
    );
    const cancelled = await inContext(systemActor(), () =>
      t.db.transaction(
        async (tx) =>
          (await kernel.cancelUnprovenDues(tx, member.userId, "Akun dihapus")) +
          (await kernel.cancelUnprovenDues(tx, proofed.userId, "Akun dihapus")),
      ),
    );
    expect(cancelled).toBe(1);
    const [row] = await t.db.select().from(payments).where(eq(payments.id, registration.paymentId));
    expect(row!.status).toBe("cancelled");
    const [still] = await t.db.select().from(payments).where(eq(payments.id, kept.paymentId));
    expect(still!.status).toBe("pending");
  });

  it("F-15: summary kernel sama dengan GET /admin/payments/summary (C7 DashboardPayments)", async () => {
    const admin = await adminSession(t, ["payments.read"]);
    const http = (await api().get("/admin/payments/summary", { token: admin.token })).json();
    const direct = await kernel.summary();
    expect({ ...direct, generated_at: http.generated_at }).toEqual(http);
  });
});

describe("Hari kerja Senin-Jumat Asia/Jakarta (kontrak C3/C7)", () => {
  it("D5, D6: rumus hari kerja JS dan SQL sama untuk setiap hari dalam sepekan dan 0-10 hari kerja", async () => {
    const base = Date.parse("2026-10-12T01:30:00Z"); // Senin 08.30 WIB
    const instants = Array.from({ length: 7 }, (_, d) => new Date(base + d * DAY + d * 3_600_123));
    instants.push(new Date(Date.parse("2026-10-16T17:30:00Z"))); // Sabtu 00.30 WIB (Jumat malam UTC)
    for (const at of instants)
      for (const days of [0, 1, 2, 5, 7, 10]) {
        const [row] = rows<{ due: string | Date }>(
          await t.db.execute(
            sql`select ${addBusinessDaysSql(sql`${at.toISOString()}::timestamptz`, days)} as due`,
          ),
        );
        expect(new Date(row!.due).toISOString(), `${at.toISOString()} + ${days}`).toBe(
          addBusinessDaysJakarta(at, days).toISOString(),
        );
      }
    // Jumat 09.00 WIB + 1 = Senin; Sabtu + 1 = Senin; Jumat + 7 = Selasa dua pekan kemudian.
    expect(addBusinessDaysJakarta(new Date("2026-10-16T02:00:00Z"), 1).toISOString()).toBe(
      "2026-10-19T02:00:00.000Z",
    );
    expect(addBusinessDaysJakarta(new Date("2026-10-17T02:00:00Z"), 1).toISOString()).toBe(
      "2026-10-19T02:00:00.000Z",
    );
    expect(addBusinessDaysJakarta(new Date("2026-10-16T02:00:00Z"), 7).toISOString()).toBe(
      "2026-10-27T02:00:00.000Z",
    );
  });
});

async function relogin(member: { userId: string }) {
  // Access token 15 menit sudah lewat setelah jam dimajukan; sesi baru untuk akun yang sama.
  const [user] = rows<{ email: string }>(
    await t.db.execute(sql`select email from app.users where id = ${member.userId}`),
  );
  const res = await api().post("/auth/login", { email: user!.email, password: "Kapdh#2026" });
  expect(res.statusCode, res.body).toBe(200);
  return { token: res.json().session.access_token as string };
}
