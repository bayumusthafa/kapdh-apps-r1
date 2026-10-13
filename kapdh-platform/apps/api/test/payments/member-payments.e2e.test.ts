import { auditLogs, paymentEvents, payments } from "@kapdh/database";
import { asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { createPaymentMethod, setSetting } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import {
  adminSession,
  createInstruction,
  createPaymentsApp,
  DAY,
  decide,
  memberSession,
  mobileHeaders,
  submitProof,
  uploadProof,
  type JsonBody,
} from "./support.js";

/**
 * Pembayaran anggota (kontrak payments.yaml; PRD 3.3, 4.3; AC F03-1 sampai F03-5, F07-5, D4, D13): kutipan, instruksi,
 * bukti, ganti metode, batal, riwayat dan rekening tujuan refund. Setiap respons divalidasi terhadap kontrak.
 */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createPaymentsApp();
});
afterAll(async () => {
  await t.app.close();
});

describe("GET /payment-methods dan GET /me/fees (F-03, D4, AC F07-5)", () => {
  it("AC F03-1: hanya metode aktif, urut sort_order lalu penyedia", async () => {
    const member = await memberSession(t);
    const later = await createPaymentMethod(t, { provider: "Zeta Bank", sortOrder: 5 });
    const first = await createPaymentMethod(t, { provider: "Alfa Bank", sortOrder: 1 });
    const inactive = await createPaymentMethod(t, { provider: "Nonaktif Bank", active: false });
    const res = await api().get("/payment-methods", { token: member.token });
    const body = expectOperation("get", "/payment-methods", res) as { items: { id: string }[] };
    const ids = body.items.map((item) => item.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(later.id));
  });

  it("AC F03-1, D4: kutipan dari pengaturan fees; kelayakan per status efektif (PRD 2.2, AC F07-5)", async () => {
    const unverified = await memberSession(t, "unverified");
    const res = await api().get("/me/fees", { token: unverified.token });
    const quotes = expectOperation("get", "/me/fees", res) as JsonBody;
    expect(quotes.registration).toMatchObject({
      total: "60000.00",
      eligible: true,
      ineligible_reason: null,
      open_payment_id: null,
      lines: [
        { code: "registration_fee", label: "Register alumni baru", amount: "50000.00" },
        { code: "card_fee", label: "Pembuatan KTA", amount: "10000.00" },
      ],
    });
    expect(quotes.renewal).toMatchObject({
      total: "10000.00",
      eligible: false,
      ineligible_reason: "registration_required",
    });
    expect(quotes).toMatchObject({ period_months: 12, instructions_hidden: false });

    const verified = await memberSession(t, "verified");
    const v = (await api().get("/me/fees", { token: verified.token })).json();
    expect(v.registration).toMatchObject({ eligible: false, ineligible_reason: "already_registered" });
    expect(v.renewal).toMatchObject({ eligible: false, ineligible_reason: "renewal_window_not_open" });
    expect(Date.parse(v.renewal.renewal_opens_at)).toBe(verified.expiresAt!.getTime() - 30 * DAY);

    for (const status of ["expiring", "expired"] as const) {
      const member = await memberSession(t, status);
      const body = (await api().get("/me/fees", { token: member.token })).json();
      expect(body.renewal, status).toMatchObject({ eligible: true, ineligible_reason: null });
    }

    const instruction = await createInstruction(t, unverified);
    const again = (await api().get("/me/fees", { token: unverified.token })).json();
    expect(again.registration.open_payment_id).toBe(instruction.paymentId);
  });

  it("PRD 2.2: anggota suspended ditolak 403 ACCOUNT_SUSPENDED untuk metode, kutipan dan instruksi baru", async () => {
    const suspended = await memberSession(t, "suspended");
    for (const res of [
      await api().get("/payment-methods", { token: suspended.token }),
      await api().get("/me/fees", { token: suspended.token }),
      await api().post(
        "/me/payments",
        { type: "renewal", payment_method_id: (await createPaymentMethod(t)).id },
        { token: suspended.token },
      ),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ACCOUNT_SUSPENDED");
    }
    // Riwayat sendiri tetap terbuka (member_access any).
    expect((await api().get("/me/payments", { token: suspended.token })).statusCode).toBe(200);
  });
});

describe("POST /me/payments: instruksi iuran (AC F03-1, F03-5)", () => {
  it("AC F03-1: nilai server, tujuan bayar dan payment_id tetap; permintaan ulang mengembalikan payment yang sama (200)", async () => {
    const member = await memberSession(t);
    const method = await createPaymentMethod(t, { provider: "BSI Uji", instructions: "Kode bank 451" });
    const res = await api().post(
      "/me/payments",
      // Nominal dari klien diabaikan (PRD 3.3).
      { type: "registration", payment_method_id: method.id, amount: "1.00" },
      { token: member.token },
    );
    const created = expectOperation("post", "/me/payments", res) as JsonBody;
    expect(res.statusCode).toBe(201);
    expect(created).toMatchObject({
      type: "registration",
      status: "pending",
      stage: "awaiting_transfer",
      amount: "60000.00",
      proof_version: 0,
      method: {
        id: method.id,
        provider: "BSI Uji",
        account_number: "7000123456",
        instructions: "Kode bank 451",
      },
      method_active: true,
      instructions_hidden: false,
      actions: { can_submit_proof: true, can_change_method: true, can_cancel: true },
      events: [{ kind: "created", actor: "member" }],
    });
    const [row] = await t.db.select().from(payments).where(eq(payments.id, created.id));
    expect(row!.settingsVersion).not.toBeNull();

    const again = await api().post(
      "/me/payments",
      { type: "registration", payment_method_id: (await createPaymentMethod(t)).id },
      { token: member.token },
    );
    expect(again.statusCode).toBe(200);
    expect(expectOperation("post", "/me/payments", again)).toMatchObject({
      id: created.id,
      method: { id: method.id },
    });
    expect(
      await t.db.select({ id: payments.id }).from(payments).where(eq(payments.userId, member.userId)),
    ).toHaveLength(1);
  });

  it("AC F03-1: Idempotency-Key yang sama memutar ulang hasil pertama (rekening organisasi bukan rahasia)", async () => {
    const member = await memberSession(t);
    const key = uuidv7();
    const body = { type: "registration", payment_method_id: (await createPaymentMethod(t)).id };
    const first = await api().post("/me/payments", body, {
      token: member.token,
      headers: { "idempotency-key": key },
    });
    const replay = await api().post("/me/payments", body, {
      token: member.token,
      headers: { "idempotency-key": key },
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());
  });

  it("PRD 2.2, AC F07-5: renewal sebelum registrasi 403 MEMBERSHIP_REQUIRED; sebelum jendela 400; registrasi ganda 409", async () => {
    const methodId = (await createPaymentMethod(t)).id;
    const unverified = await memberSession(t, "unverified");
    const early = await api().post(
      "/me/payments",
      { type: "renewal", payment_method_id: methodId },
      { token: unverified.token },
    );
    expect(expectOperation("post", "/me/payments", early)).toMatchObject({ code: "MEMBERSHIP_REQUIRED" });

    const verified = await memberSession(t, "verified");
    const window = await api().post(
      "/me/payments",
      { type: "renewal", payment_method_id: methodId },
      { token: verified.token },
    );
    expect(window.statusCode).toBe(400);
    expect(window.json().field_errors.type).toBeDefined();
    const again = await api().post(
      "/me/payments",
      { type: "registration", payment_method_id: methodId },
      { token: verified.token },
    );
    expect(expectOperation("post", "/me/payments", again)).toMatchObject({ code: "PAYMENT_STATE_CONFLICT" });

    const expiring = await memberSession(t, "expiring");
    const renewal = await api().post(
      "/me/payments",
      { type: "renewal", payment_method_id: methodId },
      { token: expiring.token },
    );
    expect(renewal.statusCode).toBe(201);
    expect(renewal.json()).toMatchObject({ type: "renewal", amount: "10000.00" });
  });

  it("F-03: metode tidak ada atau nonaktif ditolak 400 pada payment_method_id", async () => {
    const member = await memberSession(t);
    const inactive = await createPaymentMethod(t, { active: false });
    for (const id of [inactive.id, uuidv7()]) {
      const res = await api().post(
        "/me/payments",
        { type: "registration", payment_method_id: id },
        { token: member.token },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.payment_method_id).toBeDefined();
    }
  });

  it("AC F03-5: perubahan biaya setelah payment dibuat tidak mengubah snapshot; payment baru memakai biaya baru", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    await setSetting(t, "fees", {
      registration_fee: "70000.00",
      card_fee: "15000.00",
      renewal_fee: "20000.00",
    });
    try {
      const proof = await submitProof(t, member, instruction.paymentId);
      const admin = await adminSession(t);
      const approved = await decide(t, admin, instruction.paymentId, {
        decision: "approve",
        expected_proof_version: proof.proof_version,
        expected_version: proof.version,
        funds_verified: true,
      });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ status: "paid", amount: "60000.00" });
      const other = await memberSession(t);
      const fresh = await createInstruction(t, other);
      const detail = (await api().get(`/me/payments/${fresh.paymentId}`, { token: other.token })).json();
      expect(detail.amount).toBe("85000.00");
    } finally {
      await setSetting(t, "fees", {
        registration_fee: "50000.00",
        card_fee: "10000.00",
        renewal_fee: "10000.00",
      });
    }
  });
});

describe("PUT /me/payments/{id}/proof (AC F03-2, F03-3, F03-4)", () => {
  it("AC F03-2: bukti baru menaikkan proof_version, mengganti bukti aktif dan mencatat histori tanpa payment tambahan", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const firstFile = await uploadProof(t, member.token);
    const first = await api().put(
      `/me/payments/${instruction.paymentId}/proof`,
      { file_id: firstFile, expected_proof_version: 0, transfer_note: "Dari BSI" },
      { token: member.token },
    );
    expect(expectOperation("put", "/me/payments/{paymentId}/proof", first)).toMatchObject({
      proof_version: 1,
      proof_file_id: firstFile,
      transfer_note: "Dari BSI",
      stage: "awaiting_review",
      actions: { can_submit_proof: true, can_change_method: false, can_cancel: false },
    });
    const secondFile = await uploadProof(t, member.token);
    const second = await api().put(
      `/me/payments/${instruction.paymentId}/proof`,
      { file_id: secondFile, expected_proof_version: 1 },
      { token: member.token },
    );
    const body = expectOperation("put", "/me/payments/{paymentId}/proof", second) as JsonBody;
    expect(body).toMatchObject({ proof_version: 2, proof_file_id: secondFile, transfer_note: null });
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual([
      "created",
      "proof_submitted",
      "proof_replaced",
    ]);
    const history = await t.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, instruction.paymentId))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
    expect(history.filter((e) => e.proofFileId).map((e) => [e.proofVersion, e.proofFileId])).toEqual([
      [1, firstFile],
      [2, secondFile],
    ]);
    expect(
      await t.db.select({ id: payments.id }).from(payments).where(eq(payments.userId, member.userId)),
    ).toHaveLength(1);
  });

  it("AC F03-2: versi bukti usang ditolak 409 PROOF_VERSION_CONFLICT dengan current", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    await submitProof(t, member, instruction.paymentId, 0);
    const stale = await api().put(
      `/me/payments/${instruction.paymentId}/proof`,
      { file_id: await uploadProof(t, member.token), expected_proof_version: 0 },
      { token: member.token },
    );
    const error = expectOperation("put", "/me/payments/{paymentId}/proof", stale) as JsonBody;
    expect(error).toMatchObject({ code: "PROOF_VERSION_CONFLICT", current: { proof_version: 1 } });
  });

  it("AC F03-3: iuran rejected kembali pending pada payment yang sama dengan versi baru; alasan lama tetap di histori", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const proof = await submitProof(t, member, instruction.paymentId);
    const admin = await adminSession(t);
    const rejected = await decide(t, admin, instruction.paymentId, {
      decision: "reject",
      expected_proof_version: 1,
      expected_version: proof.version,
      reason: "Nominal transfer tidak sesuai",
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const view = (await api().get(`/me/payments/${instruction.paymentId}`, { token: member.token })).json();
    expect(view).toMatchObject({
      status: "rejected",
      stage: "needs_fix",
      rejection_reason: "Nominal transfer tidak sesuai",
      actions: { can_submit_proof: true },
    });
    const resubmitted = await submitProof(t, member, instruction.paymentId, 1);
    const detail = (await api().get(`/me/payments/${resubmitted.id}`, { token: member.token })).json();
    expect(detail).toMatchObject({
      id: instruction.paymentId,
      status: "pending",
      stage: "awaiting_review",
      proof_version: 2,
    });
    expect(detail.events.find((e: { kind: string }) => e.kind === "rejected")).toMatchObject({
      actor: "admin",
      reason: "Nominal transfer tidak sesuai",
      proof_version: 1,
    });
    expect(detail.events.at(-1)).toMatchObject({ kind: "proof_replaced", proof_version: 2 });
  });

  it("AC F03-4: payment paid atau cancelled tidak dapat diganti buktinya; replay Idempotency-Key tidak menggandakan", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const key = uuidv7();
    const file = await uploadProof(t, member.token);
    const body = { file_id: file, expected_proof_version: 0 };
    const first = await api().put(`/me/payments/${instruction.paymentId}/proof`, body, {
      token: member.token,
      headers: { "idempotency-key": key },
    });
    const replay = await api().put(`/me/payments/${instruction.paymentId}/proof`, body, {
      token: member.token,
      headers: { "idempotency-key": key },
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().proof_version).toBe(1);
    const [row] = await t.db.select().from(payments).where(eq(payments.id, instruction.paymentId));
    expect(row!.proofVersion).toBe(1);

    const admin = await adminSession(t);
    const approved = await decide(t, admin, instruction.paymentId, {
      decision: "approve",
      expected_proof_version: 1,
      expected_version: first.json().version,
      funds_verified: true,
    });
    expect(approved.statusCode).toBe(200);
    const paid = await api().put(
      `/me/payments/${instruction.paymentId}/proof`,
      { file_id: await uploadProof(t, member.token), expected_proof_version: 1 },
      { token: member.token },
    );
    expect(expectOperation("put", "/me/payments/{paymentId}/proof", paid)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
      current: { status: "paid" },
    });

    const other = await memberSession(t);
    const cancelled = await createInstruction(t, other);
    const cancel = await api().post(
      `/me/payments/${cancelled.paymentId}/cancel`,
      {},
      { token: other.token, headers: { "if-match": cancelled.version } },
    );
    expect(cancel.statusCode).toBe(200);
    const late = await api().put(
      `/me/payments/${cancelled.paymentId}/proof`,
      { file_id: await uploadProof(t, other.token), expected_proof_version: 0 },
      { token: other.token },
    );
    expect(late.json()).toMatchObject({ code: "PAYMENT_STATE_CONFLICT", current: { status: "cancelled" } });
  });

  it("N-10: berkas bukan payment_proof, milik orang lain atau sudah terpakai ditolak 422 FILE_INVALID", async () => {
    const member = await memberSession(t);
    const other = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const avatar = (await uploadTestFile(t, member.token, "avatar")).id;
    const foreign = await uploadProof(t, other.token);
    const used = await uploadProof(t, member.token);
    await submitProof(t, member, instruction.paymentId, 0, used);
    for (const fileId of [avatar, foreign, used, uuidv7()]) {
      const res = await api().put(
        `/me/payments/${instruction.paymentId}/proof`,
        { file_id: fileId, expected_proof_version: 1 },
        { token: member.token },
      );
      expect(expectOperation("put", "/me/payments/{paymentId}/proof", res), fileId).toMatchObject({
        code: "FILE_INVALID",
      });
    }
  });

  it("N-09: payment milik pengguna lain dan id bukan UUID menghasilkan 404", async () => {
    const owner = await memberSession(t);
    const intruder = await memberSession(t);
    const instruction = await createInstruction(t, owner);
    for (const res of [
      await api().get(`/me/payments/${instruction.paymentId}`, { token: intruder.token }),
      await api().put(
        `/me/payments/${instruction.paymentId}/proof`,
        { file_id: await uploadProof(t, intruder.token), expected_proof_version: 0 },
        { token: intruder.token },
      ),
      await api().put(
        `/me/payments/${instruction.paymentId}/method`,
        { payment_method_id: instruction.methodId },
        { token: intruder.token, headers: { "if-match": instruction.version } },
      ),
      await api().post(
        `/me/payments/${instruction.paymentId}/cancel`,
        {},
        { token: intruder.token, headers: { "if-match": instruction.version } },
      ),
      await api().get("/me/payments/bukan-uuid", { token: intruder.token }),
    ])
      expect(res.statusCode).toBe(404);
  });
});

describe("PUT /me/payments/{id}/method dan POST /me/payments/{id}/cancel (PRD 4.3)", () => {
  it("PRD 4.3: ganti rekening sebelum bukti; If-Match usang 409 VERSION_CONFLICT; setelah bukti 409 PAYMENT_STATE_CONFLICT", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const next = await createPaymentMethod(t, { provider: "Mandiri Uji", accountNumber: "1230009999" });
    const changed = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: next.id },
      { token: member.token, headers: { "if-match": instruction.version } },
    );
    const body = expectOperation("put", "/me/payments/{paymentId}/method", changed) as JsonBody;
    expect(body).toMatchObject({ method: { id: next.id, provider: "Mandiri Uji" }, amount: "60000.00" });
    expect(body.events.at(-1)).toMatchObject({ kind: "method_changed", actor: "member" });

    const stale = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: instruction.methodId },
      { token: member.token, headers: { "if-match": instruction.version } },
    );
    expect(expectOperation("put", "/me/payments/{paymentId}/method", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { method: { id: next.id } },
    });
    const inactive = await createPaymentMethod(t, { active: false });
    const invalid = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: inactive.id },
      { token: member.token, headers: { "if-match": body.version } },
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().field_errors.payment_method_id).toBeDefined();

    const proof = await submitProof(t, member, instruction.paymentId);
    const late = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: instruction.methodId },
      { token: member.token, headers: { "if-match": proof.version } },
    );
    expect(late.json()).toMatchObject({ code: "PAYMENT_STATE_CONFLICT" });
    const missing = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: instruction.methodId },
      { token: member.token },
    );
    expect(missing.statusCode).toBe(400);
  });

  it("PRD 4.3: pemilik membatalkan sebelum bukti (alasan dan aktor di histori); sesudahnya instruksi baru dapat dibuat", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const res = await api().post(
      `/me/payments/${instruction.paymentId}/cancel`,
      { reason: "Salah pilih rekening" },
      { token: member.token, headers: { "if-match": instruction.version } },
    );
    const body = expectOperation("post", "/me/payments/{paymentId}/cancel", res) as JsonBody;
    expect(body).toMatchObject({
      status: "cancelled",
      stage: "cancelled",
      cancel_reason: "Salah pilih rekening",
    });
    expect(body.events.at(-1)).toMatchObject({
      kind: "cancelled",
      actor: "member",
      reason: "Salah pilih rekening",
    });
    const [audit] = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, instruction.paymentId));
    expect(audit).toMatchObject({ action: "payment.cancelled", actorUserId: member.userId });
    const fresh = await createInstruction(t, member);
    expect(fresh.paymentId).not.toBe(instruction.paymentId);

    const proofed = await memberSession(t);
    const withProof = await createInstruction(t, proofed);
    const detail = await submitProof(t, proofed, withProof.paymentId);
    const refused = await api().post(
      `/me/payments/${withProof.paymentId}/cancel`,
      {},
      { token: proofed.token, headers: { "if-match": detail.version } },
    );
    expect(expectOperation("post", "/me/payments/{paymentId}/cancel", refused)).toMatchObject({
      code: "PAYMENT_STATE_CONFLICT",
    });
    const staleVersion = await api().post(
      `/me/payments/${fresh.paymentId}/cancel`,
      {},
      { token: member.token, headers: { "if-match": "99" } },
    );
    expect(staleVersion.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { id: fresh.paymentId } });
  });
});

describe("GET /me/payments dan GET /me/payments/{id} (F-03, F-07)", () => {
  it("F-03: riwayat milik sendiri, terbaru dahulu, saring jenis/status, keyset tanpa duplikasi", async () => {
    const member = await memberSession(t, "expiring");
    const renewal = await createInstruction(t, member, "renewal");
    await api().post(
      `/me/payments/${renewal.paymentId}/cancel`,
      {},
      { token: member.token, headers: { "if-match": renewal.version } },
    );
    t.clock.advance(1000);
    const second = await createInstruction(t, member, "renewal");
    await createInstruction(t, await memberSession(t));
    const page1 = await api().get("/me/payments", { token: member.token, query: { limit: "1" } });
    const body1 = expectOperation("get", "/me/payments", page1) as {
      items: { id: string }[];
      next_cursor: string;
    };
    expect(body1.items.map((i) => i.id)).toEqual([second.paymentId]);
    const page2 = await api().get("/me/payments", {
      token: member.token,
      query: { limit: "1", cursor: body1.next_cursor },
    });
    expect(page2.json().items.map((i: { id: string }) => i.id)).toEqual([renewal.paymentId]);
    const cancelled = await api().get("/me/payments", {
      token: member.token,
      query: { status: "cancelled" },
    });
    expect(cancelled.json().items.map((i: { id: string }) => i.id)).toEqual([renewal.paymentId]);
    const invalid = await api().get("/me/payments", { token: member.token, query: { status: "lunas" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("F-07: payment iuran paid membawa periode keanggotaan yang dihasilkan", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const proof = await submitProof(t, member, instruction.paymentId);
    const admin = await adminSession(t);
    await decide(t, admin, instruction.paymentId, {
      decision: "approve",
      expected_proof_version: 1,
      expected_version: proof.version,
      funds_verified: true,
    });
    const detail = (await api().get(`/me/payments/${instruction.paymentId}`, { token: member.token })).json();
    expect(detail.period.starts_at).toBe(t.clock.now().toISOString());
    expect(detail.events.map((e: { kind: string; actor: string }) => `${e.kind}:${e.actor}`)).toEqual([
      "created:member",
      "proof_submitted:member",
      "approved:admin",
    ]);
  });
});

describe("Rencana cadangan D13: instruksi iuran disembunyikan per platform", () => {
  it("D13: platform tersembunyi melihat instructions_hidden, ditolak 403 FORBIDDEN; android dan tanpa header tidak", async () => {
    await setSetting(t, "payment_instructions", { dues_hidden_platforms: ["ios"] });
    try {
      const member = await memberSession(t);
      const methodId = (await createPaymentMethod(t)).id;
      const ios = mobileHeaders("ios");
      const fees = await api().get("/me/fees", { token: member.token, headers: ios });
      expect(expectOperation("get", "/me/fees", fees)).toMatchObject({ instructions_hidden: true });
      const refused = await api().post(
        "/me/payments",
        { type: "registration", payment_method_id: methodId },
        { token: member.token, headers: ios },
      );
      expect(expectOperation("post", "/me/payments", refused)).toMatchObject({ code: "FORBIDDEN" });

      const created = await api().post(
        "/me/payments",
        { type: "registration", payment_method_id: methodId },
        { token: member.token, headers: mobileHeaders("android") },
      );
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const hiddenView = (
        await api().get(`/me/payments/${id}`, { token: member.token, headers: ios })
      ).json();
      expect(hiddenView).toMatchObject({
        instructions_hidden: true,
        actions: { can_submit_proof: false, can_change_method: false, can_cancel: true },
      });
      const proof = await api().put(
        `/me/payments/${id}/proof`,
        { file_id: await uploadProof(t, member.token), expected_proof_version: 0 },
        { token: member.token, headers: ios },
      );
      expect(expectOperation("put", "/me/payments/{paymentId}/proof", proof)).toMatchObject({
        code: "FORBIDDEN",
      });
      const plain = (await api().get(`/me/payments/${id}`, { token: member.token })).json();
      expect(plain.instructions_hidden).toBe(false);
    } finally {
      await setSetting(t, "payment_instructions", { dues_hidden_platforms: [] });
    }
  });
});

describe("PUT /me/payments/{id}/adjustments/{adjustmentId}/refund-destination (D6, D2)", () => {
  it("D6, D2: pemilik mengirim rekening tujuan refund; nilainya tidak pernah dikembalikan atau diaudit", async () => {
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member);
    const proof = await submitProof(t, member, instruction.paymentId);
    const admin = await adminSession(t);
    await decide(t, admin, instruction.paymentId, {
      decision: "approve",
      expected_proof_version: 1,
      expected_version: proof.version,
      funds_verified: true,
    });
    const refund = await api().post(
      `/admin/payments/${instruction.paymentId}/adjustments`,
      { kind: "refund", amount: "60000.00", reason: "Kelebihan bayar dikembalikan" },
      { token: admin.token },
    );
    expect(refund.statusCode, refund.body).toBe(201);
    const adjustment = refund.json() as { id: string; version: string };
    const before = (await api().get(`/me/payments/${instruction.paymentId}`, { token: member.token })).json();
    expect(before.adjustments[0]).toMatchObject({
      id: adjustment.id,
      kind: "refund",
      destination_required: true,
      has_refund_destination: false,
    });
    const url = `/me/payments/${instruction.paymentId}/adjustments/${adjustment.id}/refund-destination`;
    const destination = { provider: " BCA ", account_number: "9988776655", account_holder: "Penerima Uji" };
    const res = await api().put(url, destination, {
      token: member.token,
      headers: { "if-match": adjustment.version },
    });
    const body = expectOperation(
      "put",
      "/me/payments/{paymentId}/adjustments/{adjustmentId}/refund-destination",
      res,
    );
    expect(JSON.stringify(body)).not.toContain("9988776655");
    expect((body as JsonBody).adjustments[0]).toMatchObject({
      has_refund_destination: true,
      destination_required: false,
    });
    const audits = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, adjustment.id));
    expect(audits.map((a) => a.action)).toContain("payment.refund_destination_set");
    expect(JSON.stringify(audits)).not.toContain("9988776655");

    const stale = await api().put(url, destination, {
      token: member.token,
      headers: { "if-match": adjustment.version },
    });
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const intruder = await memberSession(t);
    const foreign = await api().put(url, destination, {
      token: intruder.token,
      headers: { "if-match": "2" },
    });
    expect(foreign.statusCode).toBe(404);
    const blank = await api().put(
      url,
      { provider: "  ", account_number: "1", account_holder: "x" },
      { token: member.token, headers: { "if-match": "2" } },
    );
    expect(blank.statusCode).toBe(400);
  });
});
