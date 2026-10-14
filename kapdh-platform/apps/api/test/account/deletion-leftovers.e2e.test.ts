import { auditLogs, files, idempotencyKeys, paymentAdjustments, payments } from "@kapdh/database";
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountDeletionProcessor } from "../../src/modules/account/deletion-processor.js";
import { objectMentionsAny, remainingPersonalData } from "../../src/modules/account/deletion-steps.js";
import { expectOperation } from "../support/contract.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, type AdminSession } from "../payments/support.js";
import { expectFullyDeleted } from "./expect-deleted.js";
import {
  createRichMember,
  deletionRow,
  ensureAuditPurgeRole,
  requestDeletionViaApp,
  type RichMember,
  runDeletion,
} from "./support.js";

/**
 * Sisa data akun yang dihapus di luar tabel milik akun (temuan audit D5-02 dan D5-03; D2, F-14 AC F14-3, F14-4):
 *   - D5-02: respons Idempotency-Key tersimpan milik aktor LAIN yang memuat identitas akun (mis. check-in pengurus
 *     memuat nama/nomor anggota) dan berkas ekspor audit CSV yang dibuat sebelum anonimisasi audit;
 *   - D5-03: bukti penyelesaian penyesuaian (adjustment_evidence, memuat rekening/nama penerima) yang dilampirkan
 *     pengurus SETELAH akun dihapus atau selama deletion_pending.
 * Jalur PostgreSQL 17 ujung-ke-ujung ada di test/pg/deletion-e2e.pg.test.ts.
 */

const DAY = 24 * 3600_000;
let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
  await ensureAuditPurgeRole(t.db);
});
afterAll(async () => {
  await t.app.close();
});
afterEach(() => {
  t.app.get(AccountDeletionProcessor).setStepObserver(null);
});

/** Respons Idempotency-Key tersimpan (status completed) pada scope aktor tertentu. */
async function storedResponse(scope: string, endpoint: string, body: unknown): Promise<string> {
  const id = uuidv7();
  const now = t.clock.now();
  await t.db.insert(idempotencyKeys).values({
    id,
    scope,
    endpoint,
    key: uuidv7(),
    payloadHash: "p".repeat(64),
    status: "completed",
    responseStatus: 200,
    responseBody: body,
    expiresAt: new Date(now.getTime() + DAY),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Ekspor audit CSV tersimpan (seperti job audit.export) dengan isi tertentu. */
async function storedExport(ownerUserId: string, csv: string): Promise<{ id: string; objectKey: string }> {
  const id = uuidv7();
  const now = t.clock.now();
  const objectKey = `audit_export/2026/10/${id}`;
  const stored = await t.storage.put(objectKey, Buffer.from(csv, "utf8"), { contentType: "text/csv" });
  await t.db.insert(files).values({
    id,
    ownerUserId,
    purpose: "audit_export",
    storageDriver: "local",
    objectKey,
    mime: "text/csv",
    bytes: stored.bytes,
    sha256: stored.sha256,
    visibility: "private",
    status: "ready",
    attachedAt: now,
    expiresAt: new Date(now.getTime() + DAY),
    createdAt: now,
    updatedAt: now,
  });
  return { id, objectKey };
}

async function deleteAccount(rich: RichMember): Promise<string> {
  const { requestNumber } = await requestDeletionViaApp(t, rich.session);
  await t.jobs.drainOutbox();
  return requestNumber;
}

async function fileState(file: { id: string; objectKey: string }) {
  const [row] = await t.db.select().from(files).where(eq(files.id, file.id));
  return { status: row!.status, stored: await t.storage.exists(file.objectKey) };
}

describe("D5-02: respons idempotensi aktor lain yang merujuk akun ikut dihapus", () => {
  it("respons pengurus/anggota lain yang memuat id akun, tiket, payment, penyesuaian atau laporan dihapus; respons lain tetap", async () => {
    const rich = await createRichMember(t);
    const staff = rich.superAdmin.userId;
    const holder = { full_name: "Budi Penghapus", member_number: "29.01.01.7" };
    const leaked = [
      await storedResponse(staff, "POST /api/v1/admin/checkin", {
        ticket: { id: rich.tickets.paid, holder },
      }),
      await storedResponse(staff, "POST /api/v1/admin/payments/{paymentId}/decision", {
        id: rich.payments.ticketWithProof,
        member: { user_id: rich.member.userId, ...holder },
      }),
      await storedResponse(staff, "POST /api/v1/admin/payment-adjustments/{adjustmentId}/cancel", {
        id: rich.adjustments.correction,
      }),
      await storedResponse(staff, "POST /api/v1/admin/reports/{reportId}/decision", {
        id: rich.reports.aboutMemberMessage,
      }),
      await storedResponse(rich.peer.userId, "POST /api/v1/chat/rooms", {
        members: [{ user_id: rich.member.userId, full_name: "Budi Penghapus" }],
      }),
    ];
    const unrelated = await storedResponse(staff, "POST /api/v1/admin/checkin", {
      ticket: { id: uuidv7(), holder: { full_name: "Ahmad Rekan", member_number: "29.01.01.8" } },
    });

    const requestNumber = await deleteAccount(rich);
    await expectFullyDeleted(t, rich, requestNumber);
    const left = await t.db
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(inArray(idempotencyKeys.id, [...leaked, unrelated]));
    expect(left.map((row) => row.id)).toEqual([unrelated]);
    expect((await remainingPersonalData(t.db, rich.member.userId)).idempotencyKeys).toBe(0);
  });

  it("respons yang tercatat selama jendela deletion_pending (sesudah revoke_access) dihapus di langkah credentials", async () => {
    const rich = await createRichMember(t);
    const { id } = await requestDeletionViaApp(t, rich.session);
    let windowResponse = "";
    t.app.get(AccountDeletionProcessor).setStepObserver(async ({ step }) => {
      if (step === "revoke_access")
        windowResponse = await storedResponse(
          rich.superAdmin.userId,
          "POST /api/v1/admin/payments/{id}/cancel",
          {
            id: rich.payments.registration,
            member: { full_name: "Budi Penghapus" },
          },
        );
    });
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "completed" });
    expect(windowResponse).not.toBe("");
    expect(await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, windowResponse))).toEqual(
      [],
    );
  });
});

describe("D5-02: ekspor audit yang memuat entri akun sebelum anonimisasi dihapus", () => {
  it("ekspor yang memuat id akun/inventaris dihapus (objek + baris); ekspor tanpa rujukan tetap", async () => {
    const rich = await createRichMember(t);
    const header = "created_at,action,entity_type,entity_id,actor_user_id,before,after\r\n";
    const leaking = await storedExport(
      rich.superAdmin.userId,
      `${header}"2026-10-12","profile.updated","alumni","${rich.member.userId}","${rich.member.userId}",` +
        `"{""full_name"":""Budi Penghapus""}",""\r\n`,
    );
    const byPayment = await storedExport(
      rich.superAdmin.userId,
      `${header}"2026-10-12","payment.approved","payment","${rich.payments.registration}","",` +
        `"","{""amount"":""60000.00""}"\r\n`,
    );
    const unrelated = await storedExport(
      rich.superAdmin.userId,
      `${header}"2026-10-12","settings.updated","app_setting","fees","",` + `"",""\r\n`,
    );

    await deleteAccount(rich);
    expect(await fileState(leaking)).toEqual({ status: "deleted", stored: false });
    expect(await fileState(byPayment)).toEqual({ status: "deleted", stored: false });
    expect(await fileState(unrelated)).toEqual({ status: "ready", stored: true });
  });

  it("objectMentionsAny: pencocokan melintasi batas chunk stream; objek yang tidak ada = tidak cocok", async () => {
    const needle = uuidv7();
    const key = `audit_export/2026/10/${uuidv7()}`;
    await t.storage.put(key, Buffer.from(`${"x".repeat(70_000)}${needle}${"y".repeat(70_000)}`), {
      contentType: "text/csv",
    });
    expect(await objectMentionsAny(t.storage, key, [uuidv7(), needle])).toBe(true);
    expect(await objectMentionsAny(t.storage, key, [uuidv7()])).toBe(false);
    expect(await objectMentionsAny(t.storage, `audit_export/2026/10/${uuidv7()}`, [needle])).toBe(false);
  });
});

describe("D5-03: bukti penyesuaian atas payment yang pemiliknya dihapus tidak disimpan", () => {
  async function treasurer(): Promise<AdminSession> {
    return adminSession(t, ["payments.read", "payments.decide"], { displayName: "Bendahara D5" });
  }

  async function adjustmentRow(id: string) {
    const [row] = await t.db.select().from(paymentAdjustments).where(eq(paymentAdjustments.id, id));
    return row!;
  }

  it("refund pending diselesaikan SETELAH akun dihapus: 200, rujukan bukti diputus, berkas dihapus, audit hanya sha256/ukuran", async () => {
    const rich = await createRichMember(t);
    await deleteAccount(rich);
    const [payment] = await t.db
      .select({ userId: payments.userId })
      .from(payments)
      .innerJoin(paymentAdjustments, eq(paymentAdjustments.paymentId, payments.id))
      .where(eq(paymentAdjustments.id, rich.adjustments.refund));
    expect(payment!.userId).toBeNull();

    const admin = await treasurer();
    const evidence = await uploadTestFile(t, admin.token, "adjustment_evidence");
    const before = await adjustmentRow(rich.adjustments.refund);
    const res = await api().post(
      `/admin/payment-adjustments/${rich.adjustments.refund}/complete`,
      { evidence_file_id: evidence.id },
      { token: admin.token, headers: { "if-match": String(before.version) } },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(expectOperation("post", "/admin/payment-adjustments/{adjustmentId}/complete", res)).toMatchObject({
      status: "completed",
      evidence_file_id: null,
      refund_destination: null,
    });
    const [file] = await t.db.select().from(files).where(eq(files.id, evidence.id));
    expect(file).toMatchObject({ status: "deleted" });
    expect(await t.storage.exists(file!.objectKey)).toBe(false);
    expect(await adjustmentRow(rich.adjustments.refund)).toMatchObject({
      status: "completed",
      evidenceFileId: null,
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, rich.adjustments.refund),
          eq(auditLogs.action, "payment_adjustment.completed"),
        ),
      );
    expect(audit!.after).toMatchObject({
      status: "completed",
      evidence_file_id: null,
      evidence_erased: {
        file_id: evidence.id,
        sha256: file!.sha256,
        bytes: file!.bytes,
        reason_code: "owner_deleted",
      },
    });
    // Bukti tidak lagi dapat dibuka pengurus.
    expect((await api().get(`/files/${evidence.id}/access`, { token: admin.token })).statusCode).toBe(404);
  });

  it("selama deletion_pending: bukti yang dilampirkan lewat PATCH tetap selama pending, lalu dihapus saat refund dibatalkan; job tetap selesai", async () => {
    const rich = await createRichMember(t);
    const { id: deletionId } = await requestDeletionViaApp(t, rich.session);
    const admin = await treasurer();
    const evidence = await uploadTestFile(t, admin.token, "adjustment_evidence");
    const pending = await adjustmentRow(rich.adjustments.refund);
    const patched = await api().patch(
      `/admin/payment-adjustments/${rich.adjustments.refund}`,
      { evidence_file_id: evidence.id },
      { token: admin.token, headers: { "if-match": String(pending.version) } },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ status: "pending", evidence_file_id: evidence.id });

    const cancelled = await api().post(
      `/admin/payment-adjustments/${rich.adjustments.refund}/cancel`,
      { reason: "Rekening tujuan tidak dapat dihubungi" },
      { token: admin.token, headers: { "if-match": patched.json().version } },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(
      expectOperation("post", "/admin/payment-adjustments/{adjustmentId}/cancel", cancelled),
    ).toMatchObject({ status: "cancelled", evidence_file_id: null });
    const [file] = await t.db.select().from(files).where(eq(files.id, evidence.id));
    expect(file).toMatchObject({ status: "deleted" });
    expect(await t.storage.exists(file!.objectKey)).toBe(false);

    await t.jobs.drainOutbox();
    expect(await deletionRow(t.db, deletionId)).toMatchObject({ status: "completed" });
  });

  it("pemilik masih aktif: bukti penyelesaian tetap tersimpan (kontrol)", async () => {
    const rich = await createRichMember(t);
    const admin = await treasurer();
    const evidence = await uploadTestFile(t, admin.token, "adjustment_evidence");
    const before = await adjustmentRow(rich.adjustments.refund);
    const res = await api().post(
      `/admin/payment-adjustments/${rich.adjustments.refund}/complete`,
      { evidence_file_id: evidence.id },
      { token: admin.token, headers: { "if-match": String(before.version) } },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "completed", evidence_file_id: evidence.id });
    const [file] = await t.db.select().from(files).where(eq(files.id, evidence.id));
    expect(file).toMatchObject({ status: "ready", expiresAt: null });
  });
});
