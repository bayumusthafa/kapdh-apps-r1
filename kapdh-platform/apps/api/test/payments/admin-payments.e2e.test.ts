import {
  alumni,
  auditLogs,
  membershipEvents,
  notifications,
  outboxEvents,
  payments,
} from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { expectOperation } from "../support/contract.js";
import { createPaymentMethod } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import {
  adminSession,
  createInstruction,
  createPaymentsApp,
  DAY,
  decide,
  HOUR,
  memberSession,
  reviewablePayment,
  submitProof,
  uploadProof,
} from "./support.js";

/**
 * Antrean, detail, keputusan, pembatalan dan pencatatan pembayaran oleh pengurus (kontrak admin-payments.yaml;
 * PRD 3.4, 4.3; AC F04-1 sampai F04-5, F07-1, F07-2, F07-4, D13; PRD 2.3 konflik kepentingan).
 */

let t: TestApp;
const api = () => httpClient(t.app);

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

describe("POST /admin/payments/{id}/decision (AC F04-1 sampai F04-5)", () => {
  it("AC F04-1: approve menyimpan payment paid, payment_event, periode keanggotaan, audit dan notifikasi + outbox dalam satu transaksi", async () => {
    const member = await memberSession(t, "unverified");
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    const res = await decide(t, admin, payment.paymentId, approveBody(payment));
    const body = expectOperation("post", "/admin/payments/{paymentId}/decision", res) as Record<string, any>;
    const now = t.clock.now();
    expect(body).toMatchObject({
      status: "paid",
      stage: "paid",
      decided_by: { admin_id: admin.adminId, display_name: "Bendahara Uji" },
      period: { starts_at: now.toISOString(), expires_at: addCalendarMonthsJakarta(now, 12).toISOString() },
      actions: { can_decide: false, can_cancel: false, can_adjust: true },
    });
    expect(body.events.at(-1)).toMatchObject({
      kind: "approved",
      actor: "admin",
      actor_admin: { admin_id: admin.adminId },
      proof_version: 1,
    });
    const [profile] = await t.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    expect(profile!.expiresAt!.toISOString()).toBe(body.period.expires_at);
    const me = (await api().get("/me", { token: member.token })).json();
    expect(me.effective_status).toBe("verified");
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, payment.paymentId), eq(auditLogs.action, "payment.approved")));
    expect(audit).toMatchObject({ actorAdminId: admin.adminId, effectiveRole: "admin" });
    const [inbox] = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(inbox).toMatchObject({
      category: "payment",
      title: "Iuran pendaftaran disetujui",
      data: { route: `/payments/${payment.paymentId}`, payment_id: payment.paymentId },
    });
    const outbox = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.topic, "notification.created"));
    expect(outbox.some((e) => (e.payload as { notification_id?: string }).notification_id === inbox!.id)).toBe(
      true,
    );
  });

  it("AC F04-2: alasan tolak kosong atau hanya spasi ditolak 400; alasan valid tersedia untuk pemilik dan pengurus", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    for (const reason of [undefined, "", "     ", "  a "]) {
      const res = await decide(t, admin, payment.paymentId, {
        decision: "reject",
        expected_proof_version: 1,
        expected_version: payment.version,
        ...(reason === undefined ? {} : { reason }),
      });
      expect(expectOperation("post", "/admin/payments/{paymentId}/decision", res), String(reason)).toMatchObject({
        code: "VALIDATION_ERROR",
        field_errors: { reason: expect.any(Array) },
      });
    }
    const rejected = await decide(t, admin, payment.paymentId, {
      decision: "reject",
      expected_proof_version: 1,
      expected_version: payment.version,
      reason: "  Bukti buram, nominal tidak terbaca  ",
    });
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", rejected)).toMatchObject({
      status: "rejected",
      stage: "needs_fix",
      rejection_reason: "Bukti buram, nominal tidak terbaca",
      rejection_count: 1,
    });
    const owner = (await api().get(`/me/payments/${payment.paymentId}`, { token: member.token })).json();
    expect(owner.rejection_reason).toBe("Bukti buram, nominal tidak terbaca");
    const [inbox] = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(inbox).toMatchObject({ category: "payment", title: "Bukti iuran perlu diperbaiki" });
  });

  it("PRD 3.4: approve wajib funds_verified true", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    const res = await decide(t, admin, payment.paymentId, { ...approveBody(payment), funds_verified: false });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors.funds_verified).toBeDefined();
  });

  it("AC F04-3: keputusan kedua dengan versi lama mendapat 409 PAYMENT_STATE_CONFLICT beserta status terbaru", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const first = await adminSession(t);
    const second = await adminSession(t);
    expect((await decide(t, first, payment.paymentId, approveBody(payment))).statusCode).toBe(200);
    const late = await decide(t, second, payment.paymentId, {
      decision: "reject",
      expected_proof_version: 1,
      expected_version: payment.version,
      reason: "Dana tidak ditemukan",
    });
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", late)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { id: payment.paymentId, status: "paid", decided_by: { admin_id: first.adminId } },
    });
    // Paid tidak pernah menjadi rejected (PRD 3.4, ARCHITECTURE §2 butir 13).
    const [row] = await t.db.select().from(payments).where(eq(payments.id, payment.paymentId));
    expect(row!.status).toBe("paid");
  });

  it("AC F04-4: bukti diganti setelah layar dibuka → keputusan versi lama 409 PROOF_VERSION_CONFLICT sampai versi baru dibaca", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    const opened = expectOperation(
      "get",
      "/admin/payments/{paymentId}",
      await api().get(`/admin/payments/${payment.paymentId}`, { token: admin.token }),
    ) as Record<string, any>;
    const replaced = await submitProof(t, member, payment.paymentId, 1);
    const stale = await decide(t, admin, payment.paymentId, {
      decision: "approve",
      expected_proof_version: opened.proof_version,
      expected_version: opened.version,
      funds_verified: true,
    });
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", stale)).toMatchObject({
      code: "PROOF_VERSION_CONFLICT",
      current: { proof_version: 2, proof: { file_id: replaced.proof_file_id, version: 2 } },
    });
    const staleVersion = await decide(t, admin, payment.paymentId, {
      decision: "approve",
      expected_proof_version: 2,
      expected_version: opened.version,
      funds_verified: true,
    });
    expect(staleVersion.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const fresh = await decide(t, admin, payment.paymentId, {
      decision: "approve",
      expected_proof_version: 2,
      expected_version: replaced.version,
      funds_verified: true,
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("AC F04-5: pengiriman email/push gagal tidak membatalkan keputusan; inbox tersedia; ulang tidak memperpanjang dua kali", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const admin = await adminSession(t);
    const key = uuidv7();
    const first = await decide(t, admin, payment.paymentId, approveBody(payment), { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    // Worker gagal mengirim (tanpa handler/penyedia gagal) dan mengulang; keputusan tetap committed.
    for (let round = 0; round < 3; round++) {
      await t.jobs.dispatchOutbox();
      t.clock.advance(2 * 60_000);
    }
    const [row] = await t.db.select().from(payments).where(eq(payments.id, payment.paymentId));
    expect(row!.status).toBe("paid");
    expect(
      await t.db.select().from(notifications).where(eq(notifications.userId, member.userId)),
    ).toHaveLength(1);
    const [profile] = await t.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    const replay = await decide(t, admin, payment.paymentId, approveBody(payment), { "idempotency-key": key });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const retry = await decide(t, admin, payment.paymentId, approveBody(payment));
    expect(retry.json().code).toBe("PAYMENT_STATE_CONFLICT");
    expect(
      await t.db.select().from(membershipEvents).where(eq(membershipEvents.paymentId, payment.paymentId)),
    ).toHaveLength(1);
    const [after] = await t.db.select().from(alumni).where(eq(alumni.userId, member.userId));
    expect(after!.expiresAt).toEqual(profile!.expiresAt);
  });

  it("AC F07-1, F07-2: renewal disetujui → expiring diperpanjang dari expires_at lama, expired dari approved_at", async () => {
    const admin = await adminSession(t);
    const expiring = await memberSession(t, "expiring");
    const renewal = await reviewablePayment(t, expiring, "renewal");
    const approved = (await decide(t, admin, renewal.paymentId, approveBody(renewal))).json();
    expect(approved.period.starts_at).toBe(expiring.expiresAt!.toISOString());
    expect(approved.period.expires_at).toBe(addCalendarMonthsJakarta(expiring.expiresAt!, 12).toISOString());

    const expired = await memberSession(t, "expired");
    const late = await reviewablePayment(t, expired, "renewal");
    const body = (await decide(t, admin, late.paymentId, approveBody(late))).json();
    expect(body.period.starts_at).toBe(t.clock.now().toISOString());
  });

  it("AC F07-4: anggota suspended yang pembayaran lamanya disetujui tetap suspended", async () => {
    const member = await memberSession(t, "expiring");
    const renewal = await reviewablePayment(t, member, "renewal");
    await t.db
      .update(alumni)
      .set({ suspendedAt: t.clock.now(), suspensionReason: "Uji suspend", suspensionMessage: "Dibatasi" })
      .where(eq(alumni.userId, member.userId));
    const admin = await adminSession(t);
    const res = await decide(t, admin, renewal.paymentId, approveBody(renewal));
    expect(res.json()).toMatchObject({ status: "paid", member: { effective_status: "suspended" } });
  });

  it("PRD 2.3: pengurus tidak dapat memutus payment akun alumni tertautnya (403); detail menandai konflik", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const linked = await adminSession(t, ["payments.read", "payments.decide"], { linkedAlumniUserId: member.userId });
    const detail = await api().get(`/admin/payments/${payment.paymentId}`, { token: linked.token });
    expect(expectOperation("get", "/admin/payments/{paymentId}", detail)).toMatchObject({
      conflict_of_interest: true,
      actions: { can_decide: false, can_cancel: false, can_adjust: false },
    });
    const res = await decide(t, linked, payment.paymentId, approveBody(payment));
    expect(expectOperation("post", "/admin/payments/{paymentId}/decision", res)).toMatchObject({ code: "FORBIDDEN" });
    const [row] = await t.db.select().from(payments).where(eq(payments.id, payment.paymentId));
    expect(row!.status).toBe("pending");
  });

  it("AC F15-1: tanpa payments.decide, tanpa izin, sesi mobile, atau payment tidak ada ditolak", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const reader = await adminSession(t, ["payments.read"]);
    const content = await adminSession(t, ["content.manage"]);
    const decision = approveBody(payment);
    expect((await decide(t, reader, payment.paymentId, decision)).json().code).toBe("FORBIDDEN");
    for (const url of ["/admin/payments", "/admin/payments/summary", `/admin/payments/${payment.paymentId}`]) {
      const res = await api().get(url, { token: content.token });
      expect(res.statusCode, url).toBe(403);
      expect((await api().get(url, { token: member.token })).statusCode, url).toBeOneOf([401, 403]);
    }
    expect((await decide(t, { ...reader, token: member.token }, payment.paymentId, decision)).statusCode).toBeOneOf([
      401, 403,
    ]);
    const missing = await decide(t, await adminSession(t), uuidv7(), decision);
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /admin/payments dan /summary (F-04, F-15)", () => {
  it("F-04: Menunggu = stage awaiting_review dengan total sama dengan summary; urut usia; overdue setelah 1 hari kerja", async () => {
    const t2 = await createPaymentsApp();
    try {
      const a = await memberSession(t2, "unverified", { fullName: "Siti Aminah" });
      const older = await reviewablePayment(t2, a);
      t2.clock.advance(HOUR);
      const b = await memberSession(t2, "unverified", { fullName: "Budi Santoso" });
      const c = await memberSession(t2, "unverified", { fullName: "Citra Lestari" });
      const newer = await reviewablePayment(t2, b);
      let admin = await adminSession(t2);
      await createInstruction(t2, c); // tanpa bukti: awaiting_transfer
      const list = await httpClient(t2.app).get("/admin/payments", {
        token: admin.token,
        query: { stage: "awaiting_review" },
      });
      const page = expectOperation("get", "/admin/payments", list) as { items: any[]; total: number };
      expect(page.items.map((i) => i.id)).toEqual([older.paymentId, newer.paymentId]);
      expect(page.total).toBe(2);
      const summary = expectOperation(
        "get",
        "/admin/payments/summary",
        await httpClient(t2.app).get("/admin/payments/summary", { token: admin.token }),
      ) as Record<string, any>;
      expect(summary).toMatchObject({
        awaiting_review_count: 2,
        awaiting_transfer_count: 1,
        overdue_count: 0,
        awaiting_review_by_type: { registration: 2, renewal: 0, ticket: 0 },
      });
      expect(page.items[0]).toMatchObject({
        member: { full_name: "Siti Aminah", effective_status: "unverified" },
        overdue: false,
        event_title: null,
        ticket_status: null,
        event_cancelled: null,
      });
      // Selasa 09.00 WIB + 1 hari kerja = Rabu 09.00 WIB.
      expect(page.items[0].review_due_at).toBe(new Date(Date.parse(page.items[0].submitted_at) + DAY).toISOString());
      t2.clock.advance(DAY - HOUR / 2);
      // Sesi admin idle > 30 menit dicabut (ADMIN_IDLE_MS); masuk ulang setelah jam dimajukan.
      admin = await adminSession(t2);
      const overdue = (
        await httpClient(t2.app).get("/admin/payments", { token: admin.token, query: { overdue: "true" } })
      ).json();
      expect(overdue.items.map((i: { id: string }) => i.id)).toEqual([older.paymentId]);
      expect(overdue.items[0].overdue).toBe(true);
      const notOverdue = (
        await httpClient(t2.app).get("/admin/payments", { token: admin.token, query: { overdue: "false" } })
      ).json();
      expect(notOverdue.items.map((i: { id: string }) => i.id)).not.toContain(older.paymentId);
      expect(
        (await httpClient(t2.app).get("/admin/payments/summary", { token: admin.token })).json().overdue_count,
      ).toBe(1);

      const search = (
        await httpClient(t2.app).get("/admin/payments", { token: admin.token, query: { q: "budi" } })
      ).json();
      expect(search.items.map((i: { id: string }) => i.id)).toEqual([newer.paymentId]);
      const byNumber = (
        await httpClient(t2.app).get("/admin/payments", {
          token: admin.token,
          query: { q: a.memberNumber!.slice(0, 8) },
        })
      ).json();
      expect(byNumber.items.map((i: { id: string }) => i.id)).toContain(older.paymentId);

      const desc = (
        await httpClient(t2.app).get("/admin/payments", {
          token: admin.token,
          query: { sort: "submitted_at_desc", limit: "1" },
        })
      ).json();
      expect(desc.items[0].id).toBe(newer.paymentId);
      expect(desc.total).toBe(3);
      const next = (
        await httpClient(t2.app).get("/admin/payments", {
          token: admin.token,
          query: { sort: "submitted_at_desc", limit: "1", cursor: desc.next_cursor },
        })
      ).json();
      expect(next.items[0].id).toBe(older.paymentId);
      const last = (
        await httpClient(t2.app).get("/admin/payments", {
          token: admin.token,
          query: { sort: "submitted_at_desc", limit: "1", cursor: next.next_cursor },
        })
      ).json();
      // Payment tanpa bukti di akhir (nilai kosong di akhir).
      expect(last.items[0].stage).toBe("awaiting_transfer");
      expect(last.next_cursor).toBeNull();
      const mismatch = await httpClient(t2.app).get("/admin/payments", {
        token: admin.token,
        query: { cursor: desc.next_cursor },
      });
      expect(mismatch.statusCode).toBe(400);
      const due = (
        await httpClient(t2.app).get("/admin/payments", {
          token: admin.token,
          query: { sort: "review_due_at_asc" },
        })
      ).json();
      expect(due.items.map((i: { id: string }) => i.id).slice(0, 2)).toEqual([older.paymentId, newer.paymentId]);
    } finally {
      await t2.app.close();
    }
  });

  it("F-04: detail memuat bukti aktif, histori dengan berkas bukti lama yang tetap dapat dibuka pengurus (U-02)", async () => {
    const member = await memberSession(t);
    const payment = await reviewablePayment(t, member);
    const replaced = await submitProof(t, member, payment.paymentId, 1);
    const admin = await adminSession(t, ["payments.read"]);
    const detail = expectOperation(
      "get",
      "/admin/payments/{paymentId}",
      await api().get(`/admin/payments/${payment.paymentId}`, { token: admin.token }),
    ) as Record<string, any>;
    expect(detail).toMatchObject({
      proof: { file_id: replaced.proof_file_id, version: 2, mime: "image/jpeg" },
      transfer_note: "BSI a.n. Alumni Uji",
      rejection_count: 0,
      settings_version: expect.any(String),
      method_active: true,
      refund_on_approve: false,
      conflict_of_interest: false,
      actions: { can_decide: false, can_cancel: false, can_adjust: false },
    });
    const proofEvents = detail.events.filter((e: { proof_file_id: string | null }) => e.proof_file_id);
    expect(proofEvents).toHaveLength(2);
    for (const event of proofEvents) {
      const access = await api().get(`/files/${event.proof_file_id}/access`, { token: admin.token });
      expect(access.statusCode).toBe(200);
    }
    const otherMember = await memberSession(t);
    expect(
      (await api().get(`/files/${proofEvents[0].proof_file_id}/access`, { token: otherMember.token })).statusCode,
    ).toBe(404);
  });
});

describe("POST /admin/payments/{id}/cancel (PRD 4.3)", () => {
  it("PRD 4.3: hanya pending tanpa bukti; rejected tidak pernah dapat dibatalkan; If-Match", async () => {
    const admin = await adminSession(t);
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const stale = await api().post(
      `/admin/payments/${instruction.paymentId}/cancel`,
      { reason: "Instruksi ditinggalkan" },
      { token: admin.token, headers: { "if-match": "7" } },
    );
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const res = await api().post(
      `/admin/payments/${instruction.paymentId}/cancel`,
      { reason: "Instruksi ditinggalkan" },
      { token: admin.token, headers: { "if-match": instruction.version } },
    );
    const body = expectOperation("post", "/admin/payments/{paymentId}/cancel", res) as Record<string, any>;
    expect(body).toMatchObject({ status: "cancelled", cancel_reason: "Instruksi ditinggalkan" });
    expect(body.events.at(-1)).toMatchObject({ kind: "cancelled", actor: "admin" });
    const owner = (await api().get(`/me/payments/${instruction.paymentId}`, { token: member.token })).json();
    expect(owner.events.at(-1)).toMatchObject({ kind: "cancelled", actor: "admin", reason: "Instruksi ditinggalkan" });

    const other = await memberSession(t);
    const proofed = await reviewablePayment(t, other);
    const refused = await api().post(
      `/admin/payments/${proofed.paymentId}/cancel`,
      { reason: "Tidak boleh" },
      { token: admin.token, headers: { "if-match": proofed.version } },
    );
    expect(expectOperation("post", "/admin/payments/{paymentId}/cancel", refused)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
    const rejected = await decide(t, admin, proofed.paymentId, {
      decision: "reject",
      expected_proof_version: 1,
      expected_version: proofed.version,
      reason: "Tidak ditemukan",
    });
    const again = await api().post(
      `/admin/payments/${proofed.paymentId}/cancel`,
      { reason: "Tidak boleh" },
      { token: admin.token, headers: { "if-match": rejected.json().version } },
    );
    expect(again.json().code).toBe("PAYMENT_STATE_CONFLICT");
    const blank = await api().post(
      `/admin/payments/${proofed.paymentId}/cancel`,
      { reason: "   " },
      { token: admin.token, headers: { "if-match": "1" } },
    );
    expect(blank.statusCode).toBe(400);
  });
});

describe("POST /admin/payments: pencatatan iuran di luar aplikasi (D13)", () => {
  const recordBody = async (userId: string, adminToken: string, overrides: Record<string, unknown> = {}) => ({
    user_id: userId,
    type: "registration",
    payment_method_id: (await createPaymentMethod(t, { active: false })).id,
    proof_file_id: await uploadProof(t, adminToken),
    transfer_note: "Mutasi BSI 12 Okt",
    funds_verified: true,
    reason: "Dicocokkan dengan mutasi rekening 12 Oktober",
    ...overrides,
  });

  it("D13: tanpa payment terbuka → payment baru dari fees, langsung paid dengan histori beraktor admin (201)", async () => {
    const member = await memberSession(t);
    const admin = await adminSession(t);
    const res = await api().post("/admin/payments", await recordBody(member.userId, admin.token), {
      token: admin.token,
    });
    const body = expectOperation("post", "/admin/payments", res) as Record<string, any>;
    expect(res.statusCode).toBe(201);
    expect(body).toMatchObject({ status: "paid", amount: "60000.00", proof_version: 1, period: expect.any(Object) });
    expect(body.events.map((e: { kind: string; actor: string }) => `${e.kind}:${e.actor}`)).toEqual([
      "created:admin",
      "proof_submitted:admin",
      "approved:admin",
    ]);
    expect(body.events[0].reason).toBe("Dicocokkan dengan mutasi rekening 12 Oktober");
    const owner = (await api().get(`/me/payments/${body.id}`, { token: member.token })).json();
    // Bukti dan catatan pengurus tidak dibuka kepada anggota (N-09).
    expect(owner).toMatchObject({ status: "paid", proof_file_id: null, transfer_note: null });
    expect(owner.events[0].reason).toBeNull();
    expect((await api().get(`/files/${body.proof.file_id}/access`, { token: member.token })).statusCode).toBe(404);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, body.id), eq(auditLogs.action, "payment.recorded")));
    expect(audit?.reason).toBe("Dicocokkan dengan mutasi rekening 12 Oktober");
    expect((await api().get("/me", { token: member.token })).json().effective_status).toBe("verified");
  });

  it("D13: payment terbuka awaiting_transfer atau needs_fix diselesaikan di tempat (200); awaiting_review → 409 dengan current", async () => {
    const admin = await adminSession(t);
    const waiting = await memberSession(t);
    const instruction = await createInstruction(t, waiting);
    const inPlace = await api().post("/admin/payments", await recordBody(waiting.userId, admin.token), {
      token: admin.token,
    });
    expect(inPlace.statusCode).toBe(200);
    const body = expectOperation("post", "/admin/payments", inPlace) as Record<string, any>;
    expect(body).toMatchObject({ id: instruction.paymentId, status: "paid" });
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual([
      "created",
      "method_changed",
      "proof_submitted",
      "approved",
    ]);

    const fixing = await memberSession(t);
    const proofed = await reviewablePayment(t, fixing);
    const busy = await api().post("/admin/payments", await recordBody(fixing.userId, admin.token), {
      token: admin.token,
    });
    expect(expectOperation("post", "/admin/payments", busy)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { id: proofed.paymentId, stage: "awaiting_review" },
    });
    await decide(t, admin, proofed.paymentId, {
      decision: "reject",
      expected_proof_version: 1,
      expected_version: proofed.version,
      reason: "Nominal kurang",
    });
    const settled = await api().post("/admin/payments", await recordBody(fixing.userId, admin.token), {
      token: admin.token,
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.json().events.map((e: { kind: string }) => e.kind)).toEqual([
      "created",
      "proof_submitted",
      "rejected",
      "method_changed",
      "proof_replaced",
      "approved",
    ]);
  });

  it("D13: validasi akun, kelayakan, berkas, funds_verified dan konflik kepentingan", async () => {
    const admin = await adminSession(t);
    const verified = await memberSession(t, "verified");
    const already = await api().post("/admin/payments", await recordBody(verified.userId, admin.token), {
      token: admin.token,
    });
    expect(already.json().code).toBe("PAYMENT_STATE_CONFLICT");
    const window = await api().post(
      "/admin/payments",
      await recordBody(verified.userId, admin.token, { type: "renewal" }),
      { token: admin.token },
    );
    expect(window.json().field_errors.type).toBeDefined();
    const suspended = await memberSession(t, "suspended");
    const blocked = await api().post("/admin/payments", await recordBody(suspended.userId, admin.token), {
      token: admin.token,
    });
    expect(blocked.json().field_errors.user_id).toBeDefined();
    const unknown = await api().post("/admin/payments", await recordBody(uuidv7(), admin.token), {
      token: admin.token,
    });
    expect(unknown.json().field_errors.user_id).toBeDefined();
    const member = await memberSession(t);
    const notVerified = await api().post(
      "/admin/payments",
      await recordBody(member.userId, admin.token, { funds_verified: false }),
      { token: admin.token },
    );
    expect(notVerified.statusCode).toBe(400);
    const foreignFile = await api().post(
      "/admin/payments",
      await recordBody(member.userId, admin.token, { proof_file_id: await uploadProof(t, member.token) }),
      { token: admin.token },
    );
    expect(expectOperation("post", "/admin/payments", foreignFile)).toMatchObject({ code: "FILE_INVALID" });
    const linked = await adminSession(t, ["payments.read", "payments.decide"], { linkedAlumniUserId: member.userId });
    const conflict = await api().post("/admin/payments", await recordBody(member.userId, linked.token), {
      token: linked.token,
    });
    expect(conflict.json().code).toBe("FORBIDDEN");
    expect(
      await t.db.select().from(payments).where(eq(payments.userId, member.userId)),
    ).toHaveLength(0);
  });
});
