import {
  alumni,
  auditLogs,
  membershipEvents,
  notifications,
  outboxEvents,
  paymentEvents,
  payments,
} from "@kapdh/database";
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService, type AuditEntry } from "../../src/core/audit/audit.service.js";
import type { DbOrTx } from "../../src/core/db/types.js";
import { OutboxService } from "../../src/core/outbox/outbox.service.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import {
  adminSession,
  createPaymentsApp,
  decide,
  memberSession,
  type MemberFixture,
  reviewablePayment,
} from "./support.js";

/**
 * Audit traceability D2 (PRD 3.4 AC F04-1, PRD 3.17 AC F17-1): keputusan pembayaran menyimpan payment, payment_event,
 * hak keanggotaan, audit, inbox dan outbox notifikasi dalam SATU transaksi. Uji lain membuktikan semua efek itu
 * tersimpan bersama; uji ini menyuntikkan kegagalan pada langkah audit dan outbox lewat endpoint keputusan yang sebenarnya
 * dan memeriksa bahwa tidak ada efek parsial yang tertinggal, lalu keputusan ulang berhasil tepat sekali.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createPaymentsApp();
});
afterAll(async () => {
  await t.app.close();
});

const approveBody = (detail: { version: string; proofVersion: number }) => ({
  decision: "approve",
  expected_proof_version: detail.proofVersion,
  expected_version: detail.version,
  funds_verified: true,
});

/** Keadaan yang tidak boleh berubah bila transaksi keputusan batal. */
async function snapshot(paymentId: string, member: MemberFixture) {
  const [payment] = await t.db.select().from(payments).where(eq(payments.id, paymentId));
  const events = await t.db
    .select({ kind: paymentEvents.kind })
    .from(paymentEvents)
    .where(eq(paymentEvents.paymentId, paymentId));
  const membership = await t.db
    .select({ kind: membershipEvents.kind })
    .from(membershipEvents)
    .where(eq(membershipEvents.paymentId, paymentId));
  const [profile] = await t.db
    .select({ expiresAt: alumni.expiresAt })
    .from(alumni)
    .where(eq(alumni.userId, member.userId));
  const [inbox] = await t.db
    .select({ n: count() })
    .from(notifications)
    .where(eq(notifications.userId, member.userId));
  const [outbox] = await t.db.select({ n: count() }).from(outboxEvents);
  const audits = await t.db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(inArray(auditLogs.entityId, [paymentId, member.userId]));
  return {
    status: payment!.status,
    version: String(payment!.version),
    proofVersion: payment!.proofVersion,
    decidedAt: payment!.decidedAt,
    rejectionReason: payment!.rejectionReason,
    paymentEvents: events.map((e) => e.kind).sort(),
    membershipEvents: membership.map((e) => e.kind).sort(),
    expiresAt: payment ? (profile?.expiresAt?.toISOString() ?? null) : null,
    inbox: Number(inbox!.n),
    outbox: Number(outbox!.n),
    audits: audits.map((a) => a.action).sort(),
  };
}

/** AuditService.write gagal hanya untuk aksi tertentu; aksi lain tetap ditulis seperti biasa. */
function failAuditFor(action: string) {
  const audit = t.app.get(AuditService);
  const original = audit.write.bind(audit);
  return vi.spyOn(audit, "write").mockImplementation(async (tx: DbOrTx, entry: AuditEntry) => {
    if (entry.action === action) throw new Error(`audit ${action} gagal ditulis (uji)`);
    return original(tx, entry);
  });
}

/** OutboxService.publish gagal untuk satu topik (mis. outbox tidak dapat ditulis). */
function failOutboxTopic(topic: string) {
  const outbox = t.app.get(OutboxService);
  const original = outbox.publish.bind(outbox) as (
    tx: DbOrTx,
    message: { topic: string },
  ) => Promise<unknown>;
  return vi.spyOn(outbox, "publish").mockImplementation((async (tx: DbOrTx, message: { topic: string }) => {
    if (message.topic === topic) throw new Error(`outbox ${topic} gagal ditulis (uji)`);
    return original(tx, message);
  }) as unknown as OutboxService["publish"]);
}

describe("AC F04-1, F17-1: keputusan pembayaran atomik di endpoint keputusan", () => {
  it("AC F04-1, F17-1: audit payment.approved gagal → 500; payment tetap pending tanpa histori, periode, inbox, outbox maupun audit; keputusan ulang berhasil sekali", async () => {
    const member = await memberSession(t, "unverified");
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    const before = await snapshot(payment.paymentId, member);
    expect(before).toMatchObject({ status: "pending", proofVersion: 1, expiresAt: null, decidedAt: null });

    const spy = failAuditFor("payment.approved");
    try {
      const res = await decide(t, admin, payment.paymentId, approveBody(payment));
      expect(res.statusCode, res.body).toBe(500);
      expect(res.json()).toMatchObject({ code: "INTERNAL_ERROR" });
      expect(spy.mock.calls.some(([, entry]) => entry.action === "payment.approved")).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // Tidak ada efek parsial: periode keanggotaan dan histori yang ditulis SEBELUM audit ikut batal.
    expect(await snapshot(payment.paymentId, member)).toEqual(before);
    const me = (await httpClient(t.app).get("/me", { token: member.token })).json();
    expect(me.effective_status).toBe("unverified");

    // Keputusan yang sama setelah audit pulih berlaku tepat sekali dengan versi yang dibaca pengurus.
    const ok = await decide(t, admin, payment.paymentId, approveBody(payment));
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await snapshot(payment.paymentId, member);
    expect(after).toMatchObject({ status: "paid", membershipEvents: ["activation"] });
    expect(after.paymentEvents.filter((kind) => kind === "approved")).toHaveLength(1);
    expect(after.audits.filter((action) => action === "payment.approved")).toHaveLength(1);
    expect(after.inbox).toBe(before.inbox + 1);
    expect(after.expiresAt).not.toBeNull();
  });

  it("AC F04-1: outbox notification.created gagal → persetujuan renewal batal seluruhnya (expires_at tetap, tanpa audit/inbox); setelah pulih diperpanjang sekali", async () => {
    const member = await memberSession(t, "expiring");
    const payment = await reviewablePayment(t, member, "renewal");
    const admin = await adminSession(t);
    const before = await snapshot(payment.paymentId, member);
    expect(before.expiresAt).toBe(member.expiresAt!.toISOString());

    const spy = failOutboxTopic("notification.created");
    try {
      const res = await decide(t, admin, payment.paymentId, approveBody(payment));
      expect(res.statusCode, res.body).toBe(500);
      expect(spy.mock.calls.some(([, message]) => message.topic === "notification.created")).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // Inbox ditulis sebelum outbox pada transaksi yang sama; keduanya, audit, histori dan periode batal.
    expect(await snapshot(payment.paymentId, member)).toEqual(before);

    const ok = await decide(t, admin, payment.paymentId, approveBody(payment));
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await snapshot(payment.paymentId, member);
    expect(after.status).toBe("paid");
    expect(after.membershipEvents).toEqual(["renewal"]);
    expect(after.inbox).toBe(before.inbox + 1);
    expect(after.outbox).toBeGreaterThan(before.outbox);
    expect(new Date(after.expiresAt!).getTime()).toBeGreaterThan(member.expiresAt!.getTime());
  });

  it("AC F04-2, F17-1: penolakan dengan audit gagal → payment tetap pending tanpa alasan tersimpan; penolakan ulang tersimpan sekali", async () => {
    const member = await memberSession(t, "unverified");
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    const before = await snapshot(payment.paymentId, member);
    const body = {
      decision: "reject",
      expected_proof_version: payment.proofVersion,
      expected_version: payment.version,
      reason: "Nominal transfer tidak sesuai",
    };

    const spy = failAuditFor("payment.rejected");
    try {
      const res = await decide(t, admin, payment.paymentId, body);
      expect(res.statusCode, res.body).toBe(500);
      expect(spy.mock.calls.some(([, entry]) => entry.action === "payment.rejected")).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot(payment.paymentId, member)).toEqual(before);

    const ok = await decide(t, admin, payment.paymentId, body);
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await snapshot(payment.paymentId, member);
    expect(after).toMatchObject({ status: "rejected", rejectionReason: "Nominal transfer tidak sesuai" });
    expect(after.audits.filter((action) => action === "payment.rejected")).toHaveLength(1);
    expect(after.paymentEvents.filter((kind) => kind === "rejected")).toHaveLength(1);
  });
});
