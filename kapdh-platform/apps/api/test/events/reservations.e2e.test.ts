import { auditLogs, paymentEvents, payments, tickets } from "@kapdh/database";
import { and, asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { createPaymentMethod, setSetting } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  createEventRow,
  DAY,
  decidePayment,
  eventRow,
  HOUR,
  type JsonBody,
  memberSession,
  methodId,
  relogin,
  reserve,
  reserveRaw,
  submitProof,
  ticketRow,
} from "./support.js";

/**
 * Reservasi satu kursi (kontrak createEventReservation; F-09, AC F09-1..F09-4, D5, PRD 4.4, 6.4) dan handler
 * pembayaran tiket modul events yang dipanggil modul payments.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe("createEventReservation: kuota dan hold (AC F09-1, D5)", () => {
  it("AC F09-1: reservasi berbayar membuat tiket awaiting_payment + payment tiket pending dan menahan kursi; kuota habis → EVENT_SOLD_OUT dengan current", async () => {
    const event = await createEventRow(t, { seatsTotal: 2 });
    const method = await methodId(t);
    const first = await memberSession(t);
    const res = await reserveRaw(t, first, event.id, { expected_price: "75000.00", payment_method_id: method });
    const ticket = expectOperation("post", "/events/{eventId}/reservations", res) as JsonBody;
    expect(res.statusCode).toBe(201);
    expect(ticket).toMatchObject({
      status: "awaiting_payment",
      total: "75000.00",
      payment_status: "pending",
      qr_code: null,
      payment: { status: "pending", amount: "75000.00", proof_version: 0, method: { provider: "Bank Event Uji" } },
      refunds: [],
      can_cancel: true,
      refund_eligible: false,
      event: { id: event.id, status: "open" },
    });
    // D5: hold 24 jam (sebelum registration_closes_at).
    expect(ticket.hold_expires_at).toBe(new Date(t.clock.now().getTime() + 24 * HOUR).toISOString());
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 1, paidQuantity: 0 });
    const [payment] = await t.db.select().from(payments).where(eq(payments.ticketId, ticket.id));
    expect(payment).toMatchObject({ type: "ticket", status: "pending", amount: "75000.00", settingsVersion: null });

    await reserve(t, await memberSession(t), event, method);
    const late = await memberSession(t);
    const soldOut = await reserveRaw(t, late, event.id, { expected_price: "75000.00", payment_method_id: method });
    const error = expectOperation("post", "/events/{eventId}/reservations", soldOut) as JsonBody;
    expect(error).toMatchObject({
      code: "EVENT_SOLD_OUT",
      current: { id: event.id, seats_available: 0, registration_state: "sold_out", can_reserve: false },
    });
    expect(error.current.reservation_blocked_reason).toBe("sold_out");
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 2, paidQuantity: 0 });
    const own = await t.db.select().from(tickets).where(eq(tickets.userId, late.userId));
    expect(own).toHaveLength(0);
  });

  it("D5: hold dibatasi registration_closes_at bila lebih dahulu dari 24 jam", async () => {
    const event = await createEventRow(t, { startsInMs: 6 * HOUR, registrationClosesBeforeStartMs: HOUR });
    const ticket = await reserve(t, await memberSession(t), event);
    expect(ticket.hold_expires_at).toBe(event.registrationClosesAt.toISOString());
  });

  it("AC F09-1: transaksi gagal tidak meninggalkan hold (metode nonaktif/tanpa metode → 400)", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const inactive = await createPaymentMethod(t, { active: false });
    const res = await reserveRaw(t, member, event.id, { expected_price: "75000.00", payment_method_id: inactive.id });
    expect(expectOperation("post", "/events/{eventId}/reservations", res)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { payment_method_id: expect.any(Array) },
    });
    const missing = await reserveRaw(t, member, event.id, { expected_price: "75000.00" });
    expect(missing.json().field_errors.payment_method_id).toBeDefined();
    const badPrice = await reserveRaw(t, member, event.id, { expected_price: "75000" });
    expect(badPrice.json().field_errors.expected_price).toBeDefined();
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
    expect(await t.db.select().from(tickets).where(eq(tickets.eventId, event.id))).toHaveLength(0);
  });

  it("PRD 4.4, 4.5: expected_price berbeda → 409 VERSION_CONFLICT dengan current dan tanpa hold", async () => {
    const event = await createEventRow(t, { price: "90000.00" });
    const member = await memberSession(t);
    const res = await reserveRaw(t, member, event.id, {
      expected_price: "75000.00",
      payment_method_id: await methodId(t),
    });
    expect(expectOperation("post", "/events/{eventId}/reservations", res)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { price: "90000.00", can_reserve: true },
    });
    expect((await eventRow(t, event.id)).heldQuantity).toBe(0);
  });

  it("PRD 6.4, 9.2: tiket aktif kedua ditolak 409 VERSION_CONFLICT; current.my_ticket menunjuk tiket aktif", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const method = await methodId(t);
    const first = await reserve(t, member, event, method);
    const again = await reserveRaw(t, member, event.id, { expected_price: "75000.00", payment_method_id: method });
    expect(expectOperation("post", "/events/{eventId}/reservations", again)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: {
        reservation_blocked_reason: "has_active_ticket",
        can_reserve: false,
        my_ticket: { id: first.id, status: "awaiting_payment" },
      },
    });
    expect((await eventRow(t, event.id)).heldQuantity).toBe(1);
  });

  it("PRD 4.3: Idempotency-Key sama mengembalikan hasil pertama tanpa tiket kedua", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const body = { expected_price: "75000.00", payment_method_id: await methodId(t) };
    const key = uuidv7();
    const first = await reserveRaw(t, member, event.id, body, { "idempotency-key": key });
    const replay = await reserveRaw(t, member, event.id, body, { "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().id).toBe(first.json().id);
    expect(replay.json().payment.method.account_number).toBe("7000123456");
    expect((await eventRow(t, event.id)).heldQuantity).toBe(1);
  });

  it("PRD 4.4: jendela pendaftaran — belum dibuka, sudah ditutup, event closed/cancelled → 409 RESERVATION_EXPIRED; draft → 404", async () => {
    const member = await memberSession(t);
    const notYet = await createEventRow(t, { registrationOpensInMs: 2 * DAY });
    const res = await reserveRaw(t, member, notYet.id, { expected_price: "75000.00", payment_method_id: await methodId(t) });
    expect(expectOperation("post", "/events/{eventId}/reservations", res)).toMatchObject({
      code: "RESERVATION_EXPIRED",
      current: { registration_state: "not_yet_open", reservation_blocked_reason: "not_yet_open" },
    });
    for (const status of ["closed", "cancelled"] as const) {
      const event = await createEventRow(t, { status });
      const closed = await reserveRaw(t, member, event.id, { expected_price: "75000.00", payment_method_id: await methodId(t) });
      expect(closed.json()).toMatchObject({ code: "RESERVATION_EXPIRED", current: { registration_state: status } });
    }
    const draft = await createEventRow(t, { status: "draft" });
    const notFound = await reserveRaw(t, member, draft.id, { expected_price: "75000.00" });
    expect(expectOperation("post", "/events/{eventId}/reservations", notFound)).toMatchObject({ code: "NOT_FOUND" });
    const unknown = await reserveRaw(t, member, uuidv7(), { expected_price: "75000.00" });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("Event gratis (AC F09-3)", () => {
  it("AC F09-3: tiket langsung paid dengan total 0.00, QR 128-bit diterbitkan, tanpa payment palsu; metode bayar ditolak", async () => {
    const event = await createEventRow(t, { price: "0.00", seatsTotal: 5 });
    const member = await memberSession(t);
    const withMethod = await reserveRaw(t, member, event.id, {
      expected_price: "0.00",
      payment_method_id: await methodId(t),
    });
    expect(withMethod.json().field_errors.payment_method_id).toBeDefined();
    const res = await reserveRaw(t, member, event.id, { expected_price: "0.00", payment_method_id: null });
    const ticket = expectOperation("post", "/events/{eventId}/reservations", res) as JsonBody;
    expect(ticket).toMatchObject({
      status: "paid",
      total: "0.00",
      payment: null,
      payment_status: null,
      hold_expires_at: null,
      refund_eligible: false,
      full_refund_until: null,
    });
    expect(ticket.qr_code).toMatch(/^[0-9a-f]{32}$/);
    expect(await t.db.select().from(payments).where(eq(payments.ticketId, ticket.id))).toHaveLength(0);
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 1 });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ticket.id), eq(auditLogs.action, "ticket.reserved")));
    expect(audit).toMatchObject({ actorUserId: member.userId, effectiveRole: "alumni" });
  });
});

describe("Hold kedaluwarsa (AC F09-2)", () => {
  it("AC F09-2: proyeksi baca sebelum job; job melepas tepat sekali (payment dibatalkan sistem); ulang job tidak berubah; bukti sesudah batas ditolak", async () => {
    const event = await createEventRow(t, { seatsTotal: 1 });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    t.clock.advance(24 * HOUR + 1000);
    await relogin(t, member);
    const other = await memberSession(t);
    // Proyeksi baca: hold habis tampil expired dan kursi kembali tersedia walau job belum berjalan.
    const detail = (await api().get(`/events/${event.id}`, { token: other.token })).json();
    expect(detail).toMatchObject({ seats_available: 1, registration_state: "open", can_reserve: true });
    const mine = (await api().get(`/me/tickets/${ticket.id}`, { token: member.token })).json();
    expect(mine).toMatchObject({ status: "expired", hold_expires_at: ticket.hold_expires_at, can_cancel: false });
    expect((await ticketRow(t, ticket.id)).status).toBe("awaiting_payment");

    await t.jobs.runScheduled("reservations.expire");
    expect((await ticketRow(t, ticket.id)).status).toBe("expired");
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0 });
    const [payment] = await t.db.select().from(payments).where(eq(payments.ticketId, ticket.id));
    expect(payment).toMatchObject({ status: "cancelled", cancelReason: "Batas reservasi habis" });
    const history = await t.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, payment!.id))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
    expect(history.at(-1)).toMatchObject({ kind: "cancelled", actorUserId: null, actorAdminId: null });
    // Job berulang tidak melepas dua kali.
    await t.jobs.runScheduled("reservations.expire");
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0 });
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ticket.id), eq(auditLogs.action, "ticket.expired")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.effectiveRole).toBe("system");
    // Bukti sesudah batas ditolak (kontrak C3: RESERVATION_EXPIRED).
    const late = await submitProof(t, member, ticket.payment.id);
    expect(late.json().code).toBe("RESERVATION_EXPIRED");
  });

  it("AC F09-2: request berikutnya (reservasi anggota lain) melepas hold kedaluwarsa secara fisik lalu memakai kursinya", async () => {
    const event = await createEventRow(t, { seatsTotal: 1 });
    const holder = await memberSession(t);
    const held = await reserve(t, holder, event);
    t.clock.advance(25 * HOUR);
    const next = await memberSession(t);
    const ticket = await reserve(t, next, event);
    expect(ticket.status).toBe("awaiting_payment");
    expect((await ticketRow(t, held.id)).status).toBe("expired");
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 1, paidQuantity: 0 });
  });

  it("AC F09-2: bukti tepat waktu → awaiting_review menahan kursi; job tidak mengedaluwarsakannya", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    const proof = await submitProof(t, member, ticket.payment.id);
    expect(proof.statusCode, proof.body).toBe(200);
    expect(await ticketRow(t, ticket.id)).toMatchObject({ status: "awaiting_review", holdExpiresAt: null });
    t.clock.advance(3 * DAY);
    await t.jobs.runScheduled("reservations.expire");
    expect((await ticketRow(t, ticket.id)).status).toBe("awaiting_review");
    expect((await eventRow(t, event.id)).heldQuantity).toBe(1);
  });
});

describe("Keputusan pembayaran tiket (handler ticket; AC F04-1, F09-4)", () => {
  it("AC F04-1: approve → tiket paid, held menjadi paid, QR terbit; QR dapat dilihat anggota", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    await submitProof(t, member, ticket.payment.id);
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const approved = await decidePayment(t, treasurer, ticket.payment.id, "approve");
    expect(approved.statusCode, approved.body).toBe(200);
    await relogin(t, member);
    const detail = (await api().get(`/me/tickets/${ticket.id}`, { token: member.token })).json();
    expect(detail).toMatchObject({ status: "paid", payment_status: "paid", can_cancel: true, refund_eligible: true });
    expect(detail.qr_code).toMatch(/^[0-9a-f]{32}$/);
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 1 });
  });

  it("AC F09-4: reject → payment rejected final, tiket cancelled (system), kursi dilepas; daftar ulang membuat tiket + payment baru", async () => {
    const event = await createEventRow(t, { seatsTotal: 1 });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    await submitProof(t, member, ticket.payment.id);
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const rejected = await decidePayment(t, treasurer, ticket.payment.id, "reject");
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await ticketRow(t, ticket.id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
    await relogin(t, member);
    const again = await reserve(t, member, event);
    expect(again.id).not.toBe(ticket.id);
    expect(again.payment.id).not.toBe(ticket.payment.id);
    // Bukti untuk payment lama tidak menghidupkan tiket yang dibatalkan.
    const revive = await submitProof(t, member, ticket.payment.id, 1);
    expect(revive.json().code).toBe("PAYMENT_STATE_CONFLICT");
    expect((await ticketRow(t, ticket.id)).status).toBe("cancelled");
  });

  it("PRD 4.3: pengurus membatalkan instruksi tanpa bukti → tiket cancelled (admin) dan hold dilepas", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    const treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
    const view = (await api().get(`/admin/payments/${ticket.payment.id}`, { token: treasurer.token })).json();
    const res = await api().post(
      `/admin/payments/${ticket.payment.id}/cancel`,
      { reason: "Reservasi ganda" },
      { token: treasurer.token, headers: { "if-match": view.version } },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await ticketRow(t, ticket.id)).toMatchObject({ status: "cancelled", cancelledBy: "admin" });
    expect((await eventRow(t, event.id)).heldQuantity).toBe(0);
  });

  it("PRD 2.2: hold tiket sesudah keputusan tetap di event lain; kursi event lain tidak terpengaruh (kontrol)", async () => {
    const first = await createEventRow(t);
    const second = await createEventRow(t);
    const member = await memberSession(t);
    await reserve(t, member, first);
    await reserve(t, member, second);
    expect((await eventRow(t, first.id)).heldQuantity).toBe(1);
    expect((await eventRow(t, second.id)).heldQuantity).toBe(1);
  });

  it("D5: pengaturan events.hold_hours dipakai untuk batas hold", async () => {
    await setSetting(t, "events", {
      hold_hours: 2,
      checkin_before_hours: 2,
      self_cancel_days: 3,
      review_escalation_business_days: 2,
    });
    try {
      const event = await createEventRow(t);
      const ticket = await reserve(t, await memberSession(t), event);
      expect(ticket.hold_expires_at).toBe(new Date(t.clock.now().getTime() + 2 * HOUR).toISOString());
    } finally {
      await setSetting(t, "events", {
        hold_hours: 24,
        checkin_before_hours: 2,
        self_cancel_days: 3,
        review_escalation_business_days: 2,
      });
    }
  });
});
