import { auditLogs, idempotencyKeys, notifications, paymentAdjustments } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessDaysJakarta } from "../../src/modules/payments/business-days.js";
import { expectOperation } from "../support/contract.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import {
  type AdminSession,
  adminSession,
  createInstruction,
  createPaymentsApp,
  decide,
  DAY,
  type MemberFixture,
  memberSession,
  reviewablePayment,
} from "./support.js";

/**
 * Penyesuaian refund dan koreksi atas payment paid (kontrak admin-payments.yaml; PRD 3.4, 4.3; D6, D2): paid tidak
 * pernah diubah, total refund dibatasi nominal, rekening tujuan hanya selama pending, tenggat 7 hari kerja.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createPaymentsApp();
});
afterAll(async () => {
  await t.app.close();
});

async function paidPayment(): Promise<{ member: MemberFixture; admin: AdminSession; paymentId: string }> {
  const member = await memberSession(t);
  const payment = await reviewablePayment(t, member);
  const admin = await adminSession(t);
  const res = await decide(t, admin, payment.paymentId, {
    decision: "approve",
    expected_proof_version: 1,
    expected_version: payment.version,
    funds_verified: true,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { member, admin, paymentId: payment.paymentId };
}

const evidence = async (admin: AdminSession) => (await uploadTestFile(t, admin.token, "adjustment_evidence")).id;

describe("POST /admin/payments/{id}/adjustments (D6, PRD 4.3)", () => {
  it("D6: refund atas payment paid, tenggat 7 hari kerja, notifikasi permintaan rekening; total tidak melebihi nominal", async () => {
    const { member, admin, paymentId } = await paidPayment();
    const res = await api().post(
      `/admin/payments/${paymentId}/adjustments`,
      { kind: "refund", amount: "40000.00", reason: "Kelebihan transfer" },
      { token: admin.token },
    );
    const body = expectOperation("post", "/admin/payments/{paymentId}/adjustments", res) as Record<string, any>;
    expect(res.statusCode).toBe(201);
    expect(body).toMatchObject({
      payment_id: paymentId,
      kind: "refund",
      amount: "40000.00",
      status: "pending",
      has_refund_destination: false,
      refund_destination: null,
      due_at: addBusinessDaysJakarta(t.clock.now(), 7).toISOString(),
      overdue: false,
      created_by: { admin_id: admin.adminId },
      payment: { id: paymentId, status: "paid", amount: "60000.00", member: { user_id: member.userId } },
    });
    const inbox = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(inbox.map((n) => n.title)).toContain("Refund sedang diproses bendahara");

    const tooMuch = await api().post(
      `/admin/payments/${paymentId}/adjustments`,
      { kind: "refund", amount: "20000.01", reason: "Refund kedua" },
      { token: admin.token },
    );
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().field_errors.amount).toBeDefined();
    const zero = await api().post(
      `/admin/payments/${paymentId}/adjustments`,
      { kind: "refund", amount: "0.00", reason: "Refund nol" },
      { token: admin.token },
    );
    expect(zero.statusCode).toBe(400);
    const correction = await api().post(
      `/admin/payments/${paymentId}/adjustments`,
      { kind: "correction", amount: "0.00", reason: "Catatan koreksi administratif" },
      { token: admin.token },
    );
    expect(expectOperation("post", "/admin/payments/{paymentId}/adjustments", correction)).toMatchObject({
      kind: "correction",
      due_at: null,
    });
  });

  it("PRD 4.3: payment selain paid ditolak 409; konflik kepentingan 403; tanpa payments.decide 403", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const admin = await adminSession(t);
    const pending = await api().post(
      `/admin/payments/${instruction.paymentId}/adjustments`,
      { kind: "refund", amount: "1000.00", reason: "Tidak boleh" },
      { token: admin.token },
    );
    expect(expectOperation("post", "/admin/payments/{paymentId}/adjustments", pending)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
    const paid = await paidPayment();
    const linked = await adminSession(t, ["payments.read", "payments.decide"], {
      linkedAlumniUserId: paid.member.userId,
    });
    const conflict = await api().post(
      `/admin/payments/${paid.paymentId}/adjustments`,
      { kind: "correction", amount: "0.00", reason: "Konflik" },
      { token: linked.token },
    );
    expect(conflict.json().code).toBe("FORBIDDEN");
    const reader = await adminSession(t, ["payments.read"]);
    const denied = await api().post(
      `/admin/payments/${paid.paymentId}/adjustments`,
      { kind: "correction", amount: "0.00", reason: "Tanpa izin" },
      { token: reader.token },
    );
    expect(denied.statusCode).toBe(403);
  });
});

describe("Siklus refund: rekening tujuan, selesai, batal (D2, D6, PRD 10.2)", () => {
  it("D2: rekening tujuan tampil hanya untuk pemutus; replay idempotensi tidak menyimpannya; dihapus saat selesai", async () => {
    const { member, admin, paymentId } = await paidPayment();
    const key = uuidv7();
    const payload = {
      kind: "refund",
      amount: "60000.00",
      reason: "Event batal, refund penuh",
      refund_destination: { provider: "BRI", account_number: "5566778899", account_holder: "Penerima Refund" },
    };
    const created = await api().post(`/admin/payments/${paymentId}/adjustments`, payload, {
      token: admin.token,
      headers: { "idempotency-key": key },
    });
    expect(created.json()).toMatchObject({
      has_refund_destination: true,
      refund_destination: { provider: "BRI", account_number: "5566778899" },
    });
    const [stored] = await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    expect(stored?.status).toBe("completed");
    expect(JSON.stringify(stored)).not.toContain("5566778899");
    const replay = await api().post(`/admin/payments/${paymentId}/adjustments`, payload, {
      token: admin.token,
      headers: { "idempotency-key": key },
    });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toMatchObject({ id: created.json().id, refund_destination: null, has_refund_destination: true });

    const id = created.json().id as string;
    const reader = await adminSession(t, ["payments.read"]);
    const readerView = await api().get(`/admin/payment-adjustments/${id}`, { token: reader.token });
    expect(expectOperation("get", "/admin/payment-adjustments/{adjustmentId}", readerView)).toMatchObject({
      refund_destination: null,
      has_refund_destination: true,
    });
    const audits = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(JSON.stringify(audits)).not.toContain("5566778899");

    const noEvidence = await api().post(
      `/admin/payment-adjustments/${id}/complete`,
      {},
      { token: admin.token, headers: { "if-match": "1" } },
    );
    expect(noEvidence.statusCode).toBe(400);
    expect(noEvidence.json().field_errors.evidence_file_id).toBeDefined();
    const badEvidence = await api().post(
      `/admin/payment-adjustments/${id}/complete`,
      { evidence_file_id: uuidv7() },
      { token: admin.token, headers: { "if-match": "1" } },
    );
    expect(expectOperation("post", "/admin/payment-adjustments/{adjustmentId}/complete", badEvidence)).toMatchObject(
      { code: "FILE_INVALID" },
    );
    const done = await api().post(
      `/admin/payment-adjustments/${id}/complete`,
      { evidence_file_id: await evidence(admin) },
      { token: admin.token, headers: { "if-match": "1" } },
    );
    const completed = expectOperation("post", "/admin/payment-adjustments/{adjustmentId}/complete", done) as Record<
      string,
      any
    >;
    expect(completed).toMatchObject({
      status: "completed",
      has_refund_destination: false,
      refund_destination: null,
      completed_by: { admin_id: admin.adminId },
    });
    const [row] = await t.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.id, id));
    expect(row!.refundDestination).toBeNull();
    const ownerView = (await api().get(`/me/payments/${paymentId}`, { token: member.token })).json();
    expect(ownerView.events.at(-1)).toMatchObject({ kind: "adjusted", actor: "admin", reason: null });
    expect(ownerView.adjustments[0]).toMatchObject({ status: "completed", has_refund_destination: false });
    const evidenceAccess = await api().get(`/files/${completed.evidence_file_id}/access`, { token: reader.token });
    expect(evidenceAccess.statusCode).toBe(200);
    expect(
      (await api().get(`/files/${completed.evidence_file_id}/access`, { token: member.token })).statusCode,
    ).toBe(404);
    const inbox = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(inbox.map((n) => n.title)).toContain("Refund selesai");
    const again = await api().post(
      `/admin/payment-adjustments/${id}/complete`,
      {},
      { token: admin.token, headers: { "if-match": completed.version } },
    );
    expect(again.json().code).toBe("PAYMENT_STATE_CONFLICT");
  });

  it("D2, PRD 6.3: batal menyimpan alasan dan pelaku di kolom penyesuaian, rekening dikosongkan, notifikasi baku", async () => {
    const { member, admin, paymentId } = await paidPayment();
    const created = (
      await api().post(
        `/admin/payments/${paymentId}/adjustments`,
        {
          kind: "refund",
          amount: "10000.00",
          reason: "Refund sebagian",
          refund_destination: { provider: "BNI", account_number: "1112223334", account_holder: "Penerima" },
        },
        { token: admin.token },
      )
    ).json();
    const stale = await api().post(
      `/admin/payment-adjustments/${created.id}/cancel`,
      { reason: "Dicatat ulang" },
      { token: admin.token, headers: { "if-match": "5" } },
    );
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { id: created.id } });
    const res = await api().post(
      `/admin/payment-adjustments/${created.id}/cancel`,
      { reason: "Dicatat ulang dengan nominal lain" },
      { token: admin.token, headers: { "if-match": created.version } },
    );
    expect(expectOperation("post", "/admin/payment-adjustments/{adjustmentId}/cancel", res)).toMatchObject({
      status: "cancelled",
      cancel_reason: "Dicatat ulang dengan nominal lain",
      cancelled_by: { admin_id: admin.adminId },
      has_refund_destination: false,
    });
    const [row] = await t.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.id, created.id));
    expect(row).toMatchObject({ refundDestination: null, cancelledByAdminId: admin.adminId });
    const inbox = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    const cancelledNotice = inbox.find((n) => n.title === "Refund dibatalkan");
    expect(cancelledNotice?.body).not.toContain("Dicatat ulang");
    // Refund yang dibatalkan tidak dihitung dalam batas total refund.
    const full = await api().post(
      `/admin/payments/${paymentId}/adjustments`,
      { kind: "refund", amount: "60000.00", reason: "Refund penuh" },
      { token: admin.token },
    );
    expect(full.statusCode).toBe(201);
  });

  it("D6: PATCH mengubah nominal/alasan/rekening/bukti pending dengan If-Match; refund melebihi sisa 400; selesai → 409", async () => {
    const { admin, paymentId } = await paidPayment();
    const created = (
      await api().post(
        `/admin/payments/${paymentId}/adjustments`,
        { kind: "refund", amount: "10000.00", reason: "Refund awal" },
        { token: admin.token },
      )
    ).json();
    const url = `/admin/payment-adjustments/${created.id}`;
    const patched = await api().patch(
      url,
      {
        amount: "15000.00",
        reason: "Refund dikoreksi",
        refund_destination: { provider: "BCA", account_number: "123", account_holder: "A" },
        evidence_file_id: await evidence(admin),
      },
      { token: admin.token, headers: { "if-match": created.version } },
    );
    const body = expectOperation("patch", "/admin/payment-adjustments/{adjustmentId}", patched) as Record<string, any>;
    expect(body).toMatchObject({ amount: "15000.00", reason: "Refund dikoreksi", has_refund_destination: true });
    const stale = await api().patch(url, { reason: "Usang" }, { token: admin.token, headers: { "if-match": created.version } });
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const over = await api().patch(url, { amount: "60000.01" }, { token: admin.token, headers: { "if-match": body.version } });
    expect(over.statusCode).toBe(400);
    const cleared = await api().patch(
      url,
      { refund_destination: null },
      { token: admin.token, headers: { "if-match": body.version } },
    );
    expect(cleared.json()).toMatchObject({ has_refund_destination: false });
    const correction = (
      await api().post(
        `/admin/payments/${paymentId}/adjustments`,
        { kind: "correction", amount: "0.00", reason: "Koreksi" },
        { token: admin.token },
      )
    ).json();
    const wrongKind = await api().patch(
      `/admin/payment-adjustments/${correction.id}`,
      { refund_destination: { provider: "BCA", account_number: "1", account_holder: "A" } },
      { token: admin.token, headers: { "if-match": correction.version } },
    );
    expect(wrongKind.statusCode).toBe(400);
    const completed = await api().post(
      `/admin/payment-adjustments/${correction.id}/complete`,
      {},
      { token: admin.token, headers: { "if-match": correction.version } },
    );
    expect(completed.json().status).toBe("completed");
    const late = await api().patch(
      `/admin/payment-adjustments/${correction.id}`,
      { reason: "Terlambat" },
      { token: admin.token, headers: { "if-match": completed.json().version } },
    );
    expect(expectOperation("patch", "/admin/payment-adjustments/{adjustmentId}", late)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
  });
});

describe("GET /admin/payment-adjustments (D6)", () => {
  it("D6: urut tenggat terdekat, overdue setelah 7 hari kerja, saring rekening tujuan dan jenis, total", async () => {
    const t2 = await createPaymentsApp();
    const local = t;
    t = t2;
    try {
      const first = await paidPayment();
      const a = (
        await api().post(
          `/admin/payments/${first.paymentId}/adjustments`,
          { kind: "refund", amount: "1000.00", reason: "Refund A" },
          { token: first.admin.token },
        )
      ).json();
      t.clock.advance(DAY);
      const second = await paidPayment();
      const b = (
        await api().post(
          `/admin/payments/${second.paymentId}/adjustments`,
          {
            kind: "refund",
            amount: "2000.00",
            reason: "Refund B",
            refund_destination: { provider: "BSI", account_number: "77", account_holder: "B" },
          },
          { token: second.admin.token },
        )
      ).json();
      const c = (
        await api().post(
          `/admin/payments/${second.paymentId}/adjustments`,
          { kind: "correction", amount: "0.00", reason: "Koreksi C" },
          { token: second.admin.token },
        )
      ).json();
      const admin = await adminSession(t, ["payments.read"]);
      const list = await api().get("/admin/payment-adjustments", { token: admin.token });
      const page = expectOperation("get", "/admin/payment-adjustments", list) as { items: any[]; total: number };
      expect(page.items.map((i) => i.id)).toEqual([a.id, b.id, c.id]);
      expect(page.total).toBe(3);
      const withDestination = (
        await api().get("/admin/payment-adjustments", { token: admin.token, query: { has_refund_destination: "false", kind: "refund" } })
      ).json();
      expect(withDestination.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
      const paged = (await api().get("/admin/payment-adjustments", { token: admin.token, query: { limit: "2" } })).json();
      const rest = (
        await api().get("/admin/payment-adjustments", {
          token: admin.token,
          query: { limit: "2", cursor: paged.next_cursor },
        })
      ).json();
      expect([...paged.items, ...rest.items].map((i: { id: string }) => i.id)).toEqual([a.id, b.id, c.id]);
      t.clock.advance(10 * DAY);
      const fresh = await adminSession(t, ["payments.read"]);
      const overdue = (
        await api().get("/admin/payment-adjustments", { token: fresh.token, query: { overdue: "true" } })
      ).json();
      expect(overdue.items.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
      expect(overdue.items[0].overdue).toBe(true);
      const summary = (await api().get("/admin/payments/summary", { token: fresh.token })).json();
      expect(summary).toMatchObject({ adjustments_pending_count: 3, adjustments_overdue_count: 2 });
      const recent = (
        await api().get("/admin/payment-adjustments", { token: fresh.token, query: { sort: "created_at_desc" } })
      ).json();
      expect(recent.items.map((i: { id: string }) => i.id)).toEqual([c.id, b.id, a.id]);
    } finally {
      t = local;
      await t2.app.close();
    }
  });
});
