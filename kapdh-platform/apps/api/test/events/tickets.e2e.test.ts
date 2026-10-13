import { auditLogs, paymentAdjustments, payments } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refundDueAt } from "../../src/modules/payments/payment-rules.js";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  type AdminSession,
  createEventRow,
  DAY,
  eventRow,
  HOUR,
  type JsonBody,
  type MemberFixture,
  memberSession,
  paidTicket,
  relogin,
  reserve,
  submitProof,
  ticketRow,
} from "./support.js";

/** Pembatalan tiket oleh peserta (kontrak cancelMyTicket; D6, PRD 3.9, 4.3, 4.5). */

let t: TestApp;
let treasurer: AdminSession;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
  treasurer = await adminSession(t, ["payments.read", "payments.decide"]);
});
afterAll(async () => {
  await t.app.close();
});

function cancel(member: MemberFixture, ticket: { id: string; version: string }, eligible: boolean, extra = {}) {
  return api().post(
    `/me/tickets/${ticket.id}/cancel`,
    { expected_refund_eligible: eligible, ...extra },
    { token: member.token, headers: { "if-match": ticket.version } },
  );
}

describe("cancelMyTicket (D6)", () => {
  it("D6: tiket paid berbayar dibatalkan sebelum H-3 → refund penuh pending tenggat 7 hari kerja; payment tetap paid; kursi dilepas; QR tidak berlaku", async () => {
    const event = await createEventRow(t, { startsInMs: 10 * DAY });
    const member = await memberSession(t);
    const ticket = await paidTicket(t, member, event, await adminSession(t, ["payments.read", "payments.decide"]));
    expect(ticket).toMatchObject({ status: "paid", refund_eligible: true, can_cancel: true });
    const res = await cancel(member, ticket, true, { reason: "Berhalangan hadir" });
    const body = expectOperation("post", "/me/tickets/{ticketId}/cancel", res) as JsonBody;
    expect(body).toMatchObject({
      status: "cancelled",
      cancelled_by: "self",
      cancel_reason: "Berhalangan hadir",
      qr_code: null,
      can_cancel: false,
      payment: { status: "paid" },
      refunds: [{ status: "pending", amount: "75000.00", due_at: refundDueAt(t.clock.now()).toISOString() }],
    });
    expect(await eventRow(t, event.id)).toMatchObject({ heldQuantity: 0, paidQuantity: 0 });
    const [payment] = await t.db.select().from(payments).where(eq(payments.ticketId, ticket.id));
    expect(payment!.status).toBe("paid");
    const [refund] = await t.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.paymentId, payment!.id));
    expect(refund).toMatchObject({ kind: "refund", status: "pending", createdByAdminId: null });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ticket.id), eq(auditLogs.action, "ticket.cancelled")));
    expect(audit).toMatchObject({ actorUserId: member.userId, reason: "Berhalangan hadir" });
  });

  it("D6: sesudah H-3 pembatalan tetap boleh tanpa refund; kelayakan yang berubah sejak tampilan → 409 VERSION_CONFLICT dengan current", async () => {
    const event = await createEventRow(t, { startsInMs: 3 * DAY + HOUR });
    const member = await memberSession(t);
    const ticket = await paidTicket(t, member, event, treasurer);
    expect(ticket.refund_eligible).toBe(true);
    t.clock.advance(2 * HOUR); // H-3 terlewati di antara tampilan dan kirim.
    await relogin(t, member);
    const stale = await cancel(member, ticket, true);
    expect(expectOperation("post", "/me/tickets/{ticketId}/cancel", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: ticket.id, status: "paid", refund_eligible: false, can_cancel: true },
    });
    const res = await cancel(member, ticket, false);
    expect(res.json()).toMatchObject({ status: "cancelled", refunds: [] });
    expect((await eventRow(t, event.id)).paidQuantity).toBe(0);
  });

  it("PRD 4.3: tiket awaiting_payment → cancelled, hold dilepas, payment pending dibatalkan; awaiting_review → 409 PAYMENT_STATE_CONFLICT", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    const res = await cancel(member, ticket, false);
    expect(res.json()).toMatchObject({ status: "cancelled", payment: { status: "cancelled" } });
    expect((await eventRow(t, event.id)).heldQuantity).toBe(0);

    const second = await reserve(t, member, event);
    await submitProof(t, member, second.payment.id);
    const current = (await api().get(`/me/tickets/${second.id}`, { token: member.token })).json();
    const review = await cancel(member, current, false);
    expect(expectOperation("post", "/me/tickets/{ticketId}/cancel", review)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { status: "awaiting_review", can_cancel: false },
    });
    expect((await ticketRow(t, second.id)).status).toBe("awaiting_review");
  });

  it("AC F15-4: If-Match usang → 409 VERSION_CONFLICT; If-Match hilang → 400; sesudah acara mulai → 409; tiket orang lain → 404", async () => {
    const event = await createEventRow(t, { startsInMs: 5 * HOUR, price: "0.00" });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    const stale = await cancel(member, { ...ticket, version: "999" }, false);
    expect(stale.json().code).toBe("VERSION_CONFLICT");
    const missing = await api().post(
      `/me/tickets/${ticket.id}/cancel`,
      { expected_refund_eligible: false },
      { token: member.token },
    );
    expect(expectOperation("post", "/me/tickets/{ticketId}/cancel", missing)).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const stranger = await memberSession(t);
    const foreign = await cancel(stranger, ticket, false);
    expect(expectOperation("post", "/me/tickets/{ticketId}/cancel", foreign)).toMatchObject({ code: "NOT_FOUND" });
    t.clock.advance(6 * HOUR);
    await relogin(t, member);
    const started = await cancel(member, ticket, false);
    expect(started.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { can_cancel: false } });
    expect((await ticketRow(t, ticket.id)).status).toBe("paid");
  });

  it("D6: event gratis — pembatalan melepas kursi tanpa refund; Idempotency-Key sama mengembalikan hasil pertama", async () => {
    const event = await createEventRow(t, { price: "0.00", seatsTotal: 1 });
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    expect(ticket).toMatchObject({ refund_eligible: false, full_refund_until: null });
    const headers = { "if-match": ticket.version, "idempotency-key": "0199b9a0-0000-7000-8000-000000000001" };
    const first = await api().post(
      `/me/tickets/${ticket.id}/cancel`,
      { expected_refund_eligible: false },
      { token: member.token, headers },
    );
    const replay = await api().post(
      `/me/tickets/${ticket.id}/cancel`,
      { expected_refund_eligible: false },
      { token: member.token, headers },
    );
    expect(first.json()).toMatchObject({ status: "cancelled", refunds: [] });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(await eventRow(t, event.id)).toMatchObject({ paidQuantity: 0, heldQuantity: 0 });
    // Kursi kembali tersedia untuk anggota lain.
    const next = await reserve(t, await memberSession(t), event);
    expect(next.status).toBe("paid");
  });

  it("AC F09-2: hold yang sudah lewat tidak dibatalkan melainkan dilepas sebagai expired (409 dengan current)", async () => {
    const event = await createEventRow(t);
    const member = await memberSession(t);
    const ticket = await reserve(t, member, event);
    t.clock.advance(25 * HOUR);
    await relogin(t, member);
    const res = await cancel(member, ticket, false);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { status: "expired" } });
    expect((await ticketRow(t, ticket.id)).status).toBe("expired");
    expect((await eventRow(t, event.id)).heldQuantity).toBe(0);
  });
});
