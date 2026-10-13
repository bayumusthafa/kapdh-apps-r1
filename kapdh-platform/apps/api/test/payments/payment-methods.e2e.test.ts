import { auditLogs, paymentMethods } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import {
  type AdminSession,
  adminSession,
  createInstruction,
  createPaymentsApp,
  memberSession,
  reauthToken,
} from "./support.js";

/**
 * Metode bayar oleh pengurus settings.manage (kontrak admin-payments.yaml; F-15, AC F15-3, F15-4, D13): reautentikasi,
 * audit, If-Match, metode yang dipakai hanya dapat dinonaktifkan dan identitas rekeningnya tetap.
 */

let t: TestApp;
let admin: AdminSession;
let reauth: string;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createPaymentsApp();
  admin = await adminSession(t, ["settings.manage"]);
  reauth = await reauthToken(t, admin.token);
});
afterAll(async () => {
  await t.app.close();
});

const input = (overrides: Record<string, unknown> = {}) => ({
  kind: "bank",
  provider: "Bank Syariah Indonesia",
  account_number: "7123456789",
  account_holder: "Keluarga Alumni PDH",
  instructions: "Kode bank 451",
  active: true,
  sort_order: 1,
  ...overrides,
});

const headers = (extra: Record<string, string> = {}) => ({ "x-reauth-token": reauth, ...extra });

describe("Metode bayar pengurus (F-15, AC F15-3, F15-4)", () => {
  it("AC F15-3: membuat metode wajib reautentikasi dan dicatat audit; detail dan daftar berhalaman dengan total", async () => {
    const missing = await api().post("/admin/payment-methods", input(), { token: admin.token });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe("REAUTH_REQUIRED");
    const res = await api().post("/admin/payment-methods", input({ provider: "  BSI  " }), {
      token: admin.token,
      headers: headers(),
    });
    const created = expectOperation("post", "/admin/payment-methods", res) as Record<string, any>;
    expect(res.statusCode).toBe(201);
    expect(created).toMatchObject({ provider: "BSI", in_use: false, version: "1", active: true });
    const [audit] = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(audit).toMatchObject({ action: "payment_method.created", actorAdminId: admin.adminId });
    expect(JSON.stringify(audit!.after)).not.toContain("7123456789");

    const detail = await api().get(`/admin/payment-methods/${created.id}`, { token: admin.token });
    expect(expectOperation("get", "/admin/payment-methods/{methodId}", detail)).toMatchObject({ id: created.id });
    await api().post("/admin/payment-methods", input({ provider: "Alfa", sort_order: 0 }), {
      token: admin.token,
      headers: headers(),
    });
    await api().post("/admin/payment-methods", input({ provider: "Gopay", kind: "ewallet", active: false }), {
      token: admin.token,
      headers: headers(),
    });
    const page = await api().get("/admin/payment-methods", { token: admin.token, query: { limit: "2" } });
    const body = expectOperation("get", "/admin/payment-methods", page) as Record<string, any>;
    expect(body.items.map((i: { provider: string }) => i.provider)).toEqual(["Alfa", "BSI"]);
    expect(body.total).toBe(3);
    const rest = (
      await api().get("/admin/payment-methods", { token: admin.token, query: { limit: "2", cursor: body.next_cursor } })
    ).json();
    expect(rest.items.map((i: { provider: string }) => i.provider)).toEqual(["Gopay"]);
    const inactive = (
      await api().get("/admin/payment-methods", { token: admin.token, query: { active: "false" } })
    ).json();
    expect(inactive).toMatchObject({ total: 1, items: [{ provider: "Gopay", active: false }] });
    const invalid = await api().post(
      "/admin/payment-methods",
      input({ instructions: "<script>x</script>", provider: "   " }),
      { token: admin.token, headers: headers() },
    );
    expect(invalid.statusCode).toBe(400);
    expect(Object.keys(invalid.json().field_errors).sort()).toEqual(["instructions", "provider"]);
  });

  it("AC F15-4: If-Match usang menghasilkan 409 VERSION_CONFLICT dengan current; berhasil menaikkan versi dan diaudit", async () => {
    const created = (
      await api().post("/admin/payment-methods", input({ provider: "Mandiri" }), { token: admin.token, headers: headers() })
    ).json();
    const updated = await api().put(
      `/admin/payment-methods/${created.id}`,
      input({ provider: "Mandiri Syariah", sort_order: 9 }),
      { token: admin.token, headers: headers({ "if-match": created.version }) },
    );
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", updated)).toMatchObject({
      provider: "Mandiri Syariah",
      version: "2",
    });
    const stale = await api().put(`/admin/payment-methods/${created.id}`, input(), {
      token: admin.token,
      headers: headers({ "if-match": created.version }),
    });
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: created.id, version: "2", provider: "Mandiri Syariah" },
    });
    const audits = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["payment_method.created", "payment_method.updated"]);
    const noReauth = await api().put(`/admin/payment-methods/${created.id}`, input(), {
      token: admin.token,
      headers: { "if-match": "2" },
    });
    expect(noReauth.json().code).toBe("REAUTH_REQUIRED");
  });

  it("AC F15-3: metode yang dipakai payment hanya dapat dinonaktifkan; identitas rekening tetap; snapshot payment lama tidak berubah", async () => {
    const created = (
      await api().post("/admin/payment-methods", input({ provider: "BRI", account_number: "555000111" }), {
        token: admin.token,
        headers: headers(),
      })
    ).json();
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member, "registration", created.id);
    const viewed = (await api().get(`/admin/payment-methods/${created.id}`, { token: admin.token })).json();
    expect(viewed.in_use).toBe(true);
    const identity = await api().put(
      `/admin/payment-methods/${created.id}`,
      input({ provider: "BRI", account_number: "999", account_holder: "Lain" }),
      { token: admin.token, headers: headers({ "if-match": viewed.version }) },
    );
    expect(identity.statusCode).toBe(400);
    expect(Object.keys(identity.json().field_errors).sort()).toEqual(["account_holder", "account_number"]);
    const deactivated = await api().put(
      `/admin/payment-methods/${created.id}`,
      input({ provider: "BRI", account_number: "555000111", instructions: "Petunjuk baru", active: false }),
      { token: admin.token, headers: headers({ "if-match": viewed.version }) },
    );
    expect(deactivated.json()).toMatchObject({ active: false, instructions: "Petunjuk baru", in_use: true });
    const del = await api().delete(`/admin/payment-methods/${created.id}`, {
      token: admin.token,
      headers: headers({ "if-match": deactivated.json().version }),
    });
    expect(expectOperation("delete", "/admin/payment-methods/{methodId}", del)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { _: expect.any(Array) },
    });
    const owner = (await api().get(`/me/payments/${instruction.paymentId}`, { token: member.token })).json();
    expect(owner).toMatchObject({ method: { id: created.id, instructions: "Kode bank 451" }, method_active: false });
    const list = (await api().get("/payment-methods", { token: member.token })).json();
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(created.id);
  });

  it("F-15: metode yang belum pernah dipakai dapat dihapus (204); If-Match usang 409; tidak ada → 404", async () => {
    const created = (
      await api().post("/admin/payment-methods", input({ provider: "Sementara" }), {
        token: admin.token,
        headers: headers(),
      })
    ).json();
    const stale = await api().delete(`/admin/payment-methods/${created.id}`, {
      token: admin.token,
      headers: headers({ "if-match": "9" }),
    });
    expect(stale.json().code).toBe("VERSION_CONFLICT");
    const res = await api().delete(`/admin/payment-methods/${created.id}`, {
      token: admin.token,
      headers: headers({ "if-match": created.version }),
    });
    expect(res.statusCode).toBe(204);
    expectOperation("delete", "/admin/payment-methods/{methodId}", res);
    expect(await t.db.select().from(paymentMethods).where(eq(paymentMethods.id, created.id))).toHaveLength(0);
    const missing = await api().get(`/admin/payment-methods/${uuidv7()}`, { token: admin.token });
    expect(missing.statusCode).toBe(404);
  });

  it("AC F15-1: tanpa settings.manage (termasuk payments.decide) ditolak 403; sesi mobile ditolak", async () => {
    const payments = await adminSession(t, ["payments.read", "payments.decide"]);
    for (const res of [
      await api().get("/admin/payment-methods", { token: payments.token }),
      await api().post("/admin/payment-methods", input(), { token: payments.token, headers: headers() }),
    ])
      expect(res.statusCode).toBe(403);
    const member = await memberSession(t);
    expect((await api().get("/admin/payment-methods", { token: member.token })).statusCode).toBeOneOf([401, 403]);
  });
});
