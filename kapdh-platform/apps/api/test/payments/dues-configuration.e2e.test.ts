import { appSettings, files, paymentEvents, payments } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DUES_UNCONFIGURED_MESSAGE } from "../../src/modules/payments/payment-ledger.js";
import { expectOperation } from "../support/contract.js";
import { createPaymentMethod, setSetting } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import { adminSession, createPaymentsApp, memberSession, uploadProof, type JsonBody } from "./support.js";

/**
 * Temuan audit D4-02 (PRD 8.2 butir 4, 9.3; AC F03-1, F03-5, F17-1): nominal iuran hanya diambil dari baris `fees`
 * yang tersimpan dan teraudit (versi >= 1). Tanpa baris itu (database production yang belum menjalankan seed
 * referensi) atau dengan total iuran 0.00, instruksi iuran anggota (POST /me/payments) dan pencatatan pengurus
 * (POST /admin/payments, D13) ditolak 403 FORBIDDEN dengan pesan konfigurasi; tidak ada payment, histori, atau
 * lampiran bukti yang tersisa, dan operator mendapat log error.
 */

/** Menampung baris log JSON aplikasi uji. */
class LogSink extends Writable {
  readonly lines: Record<string, unknown>[] = [];
  override _write(chunk: Buffer, _encoding: string, callback: () => void) {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean))
      this.lines.push(JSON.parse(line) as Record<string, unknown>);
    callback();
  }
  clear() {
    this.lines.length = 0;
  }
  refusals() {
    return this.lines.filter(
      (line) => line.msg === "instruksi iuran ditolak: nominal iuran belum dikonfigurasi",
    );
  }
}

let t: TestApp;
const sink = new LogSink();
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createPaymentsApp({ logDestination: sink });
});
beforeEach(() => sink.clear());
afterAll(async () => {
  await t.app.close();
});

async function deleteStoredFees(): Promise<void> {
  await t.db.delete(appSettings).where(eq(appSettings.key, "fees"));
  t.settings.invalidate("fees");
}

async function paymentsOf(userId: string) {
  return t.db.select().from(payments).where(eq(payments.userId, userId));
}

describe("D4-02: nominal iuran yang belum tersimpan tidak pernah ditagihkan (fail closed)", () => {
  it("tanpa baris fees (versi 0): POST /me/payments 403 FORBIDDEN, tanpa payment, log error untuk operator", async () => {
    await deleteStoredFees();
    expect((await t.settings.getEntry("fees")).version).toBe(0);
    const member = await memberSession(t);
    const method = await createPaymentMethod(t);
    const res = await api().post(
      "/me/payments",
      { type: "registration", payment_method_id: method.id },
      { token: member.token },
    );
    expect(res.statusCode).toBe(403);
    expect(expectOperation("post", "/me/payments", res)).toMatchObject({
      code: "FORBIDDEN",
      message: DUES_UNCONFIGURED_MESSAGE.member,
    });
    expect(await paymentsOf(member.userId)).toEqual([]);
    expect(sink.refusals()).toEqual([
      expect.objectContaining({
        level: "error",
        setting: "fees",
        settings_version: 0,
        dues_type: "registration",
        problem: "fees_not_stored",
      }),
    ]);
  });

  it("tanpa baris fees: POST /admin/payments (D13) 403 dengan pesan pengurus; bukti pengurus tidak terlampir", async () => {
    await deleteStoredFees();
    const member = await memberSession(t);
    const admin = await adminSession(t);
    const proofId = await uploadProof(t, admin.token);
    const res = await api().post(
      "/admin/payments",
      {
        user_id: member.userId,
        type: "registration",
        payment_method_id: (await createPaymentMethod(t)).id,
        proof_file_id: proofId,
        transfer_note: "Mutasi BSI 12 Okt",
        funds_verified: true,
        reason: "Dicocokkan dengan mutasi rekening 12 Oktober",
      },
      { token: admin.token },
    );
    expect(res.statusCode).toBe(403);
    expect(expectOperation("post", "/admin/payments", res)).toMatchObject({
      code: "FORBIDDEN",
      message: DUES_UNCONFIGURED_MESSAGE.admin,
    });
    expect(await paymentsOf(member.userId)).toEqual([]);
    const [proof] = await t.db.select().from(files).where(eq(files.id, proofId));
    expect(proof).toMatchObject({ status: "ready", attachedAt: null });
    expect(sink.refusals()).toHaveLength(1);
  });

  it("setelah nominal disimpan (versi >= 1) instruksi dibuat dengan settings_version tersimpan itu", async () => {
    await deleteStoredFees();
    const version = await setSetting(t, "fees", {
      registration_fee: "50000.00",
      card_fee: "10000.00",
      renewal_fee: "10000.00",
    });
    expect(version).toBe(1);
    const member = await memberSession(t);
    const res = await api().post(
      "/me/payments",
      { type: "registration", payment_method_id: (await createPaymentMethod(t)).id },
      { token: member.token },
    );
    expect(res.statusCode).toBe(201);
    expect(expectOperation("post", "/me/payments", res)).toMatchObject({ amount: "60000.00" });
    const [row] = await paymentsOf(member.userId);
    expect(row).toMatchObject({ amount: "60000.00", settingsVersion: 1 });
    expect(sink.refusals()).toEqual([]);
  });
});

describe("D4-02: total iuran 0.00 tidak dapat diverifikasi sebagai transfer (PRD 3.4)", () => {
  it("registration_fee + card_fee = 0.00 → 403 tanpa payment; renewal dengan nominal > 0 tetap dibuat", async () => {
    const version = await setSetting(t, "fees", {
      registration_fee: "0.00",
      card_fee: "0.00",
      renewal_fee: "10000.00",
    });
    const unverified = await memberSession(t);
    const methodId = (await createPaymentMethod(t)).id;
    const refused = await api().post(
      "/me/payments",
      { type: "registration", payment_method_id: methodId },
      { token: unverified.token },
    );
    expect(refused.statusCode).toBe(403);
    expect(expectOperation("post", "/me/payments", refused)).toMatchObject({ code: "FORBIDDEN" });
    expect(await paymentsOf(unverified.userId)).toEqual([]);
    expect(sink.refusals()).toEqual([
      expect.objectContaining({
        settings_version: version,
        dues_type: "registration",
        problem: "zero_total",
      }),
    ]);

    const expiring = await memberSession(t, "expiring");
    const renewal = await api().post(
      "/me/payments",
      { type: "renewal", payment_method_id: methodId },
      { token: expiring.token },
    );
    expect(renewal.statusCode).toBe(201);
    expect((expectOperation("post", "/me/payments", renewal) as JsonBody).amount).toBe("10000.00");
  });

  it("renewal_fee 0.00 → renewal 403; komponen nol dengan total > 0 diterima beserta baris 0.00 pada snapshot", async () => {
    const version = await setSetting(t, "fees", {
      registration_fee: "50000.00",
      card_fee: "0.00",
      renewal_fee: "0.00",
    });
    const methodId = (await createPaymentMethod(t)).id;
    const expiring = await memberSession(t, "expiring");
    const refused = await api().post(
      "/me/payments",
      { type: "renewal", payment_method_id: methodId },
      { token: expiring.token },
    );
    expect(refused.statusCode).toBe(403);
    expect(await paymentsOf(expiring.userId)).toEqual([]);

    const unverified = await memberSession(t);
    const created = await api().post(
      "/me/payments",
      { type: "registration", payment_method_id: methodId },
      { token: unverified.token },
    );
    expect(created.statusCode).toBe(201);
    const body = expectOperation("post", "/me/payments", created) as JsonBody;
    expect(body).toMatchObject({ amount: "50000.00" });
    const [row] = await paymentsOf(unverified.userId);
    expect(row).toMatchObject({ amount: "50000.00", settingsVersion: version });
    expect(row!.linesSnapshot).toEqual([
      expect.objectContaining({ code: "registration_fee", amount: "50000.00" }),
      expect.objectContaining({ code: "card_fee", amount: "0.00" }),
    ]);
    const events = await t.db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, row!.id));
    expect(events.map((e) => e.kind)).toEqual(["created"]);
  });
});
