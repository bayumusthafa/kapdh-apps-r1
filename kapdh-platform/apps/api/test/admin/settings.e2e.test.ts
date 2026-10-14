import { auditLogs, payments } from "@kapdh/database";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectOperation, expectSchema } from "../support/contract.js";
import { totp } from "../../src/core/identity/crypto.js";
import { createAlumni, createMembershipPayment, setSetting, signInAlumni } from "../support/factories.js";
import { postFile } from "../support/files.js";
import { httpClient, type HttpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { type AdminActor, adminActor } from "./helpers.js";

let t: TestApp;
let api: HttpClient;
let manager: AdminActor;

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  manager = await adminActor(t, { permissions: ["settings.manage"], displayName: "Bendahara Uji" });
});
afterAll(async () => {
  await t.app.close();
});

const REFERENCE = {
  fees: { registration_fee: "50000.00", card_fee: "10000.00", renewal_fee: "10000.00" },
  min_app_version: { android: "1.0.0", ios: "1.0.0" },
  maintenance: { active: false, message: null, until: null },
  store_links: { android: null, ios: null },
  support: { email: "bantuan@kapdh.or.id", whatsapp: null },
  payment_instructions: { dues_hidden_platforms: [] as ("android" | "ios")[] },
} as const;

/** Setiap tes mulai dari nilai seed referensi (versi naik, tetapi nilai sama). */
beforeEach(async () => {
  for (const [key, value] of Object.entries(REFERENCE))
    await setSetting(t, key as keyof typeof REFERENCE, value as never);
});

/** Versi kunci saat ini menurut GET /admin/settings (nilai If-Match yang dibaca web admin). */
async function version(key: string): Promise<string> {
  const res = await api.get("/admin/settings", { token: manager.token });
  expect(res.statusCode).toBe(200);
  return (res.json() as Record<string, { version: string }>)[key]!.version;
}

async function lastSettingsAudit(key: string) {
  const [row] = await t.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "settings.updated"), eq(auditLogs.entityId, key)))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);
  return row!;
}

describe("GET /admin/settings dan /admin/settings/fees (F-15)", () => {
  it("AC F15-3: seluruh pengaturan beserta versi; kunci legal tidak ditampilkan; nilai kebijakan baca-saja ada", async () => {
    const res = await api.get("/admin/settings", { token: manager.token });
    const body = expectOperation("get", "/admin/settings", res) as Record<string, Record<string, unknown>>;
    expect(res.statusCode).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      [
        "chat",
        "events",
        "fees",
        "maintenance",
        "membership",
        "min_app_version",
        "payment_instructions",
        "store_links",
        "support",
      ].sort(),
    );
    expect(body.fees).toMatchObject({ ...REFERENCE.fees, registration_total: "60000.00" });
    expect(body.membership).toMatchObject({ period_months: 12, expiring_days: 30, renewal_window_days: 30 });
    expect(body.events).toMatchObject({ hold_hours: 24, review_escalation_business_days: 2 });
    expect(body.support).toMatchObject({ email: "bantuan@kapdh.or.id", whatsapp: null, updated_by: null });
  });

  it("D4: GET /admin/settings/fees mengembalikan komponen biaya versi aktif dengan total desimal", async () => {
    const res = await api.get("/admin/settings/fees", { token: manager.token });
    const body = expectOperation("get", "/admin/settings/fees", res) as Record<string, unknown>;
    expect(body).toMatchObject({
      registration_fee: "50000.00",
      card_fee: "10000.00",
      renewal_fee: "10000.00",
      registration_total: "60000.00",
      updated_by: null,
    });
    expect(typeof body.version).toBe("string");
  });
});

describe("PUT /admin/settings/fees (AC F15-3, F03-5, F15-4)", () => {
  it("AC F03-5, F15-3: nominal baru menjadi versi berikutnya dengan audit before/after; payment lama tetap memakai snapshot", async () => {
    const member = await createAlumni(t, { status: "unverified" });
    const existing = await createMembershipPayment(t, {
      userId: member.userId,
      type: "registration",
      status: "pending",
      amount: "60000.00",
    });
    const current = await version("fees");
    const { token, headers } = await manager.sensitive(current);
    const res = await api.put(
      "/admin/settings/fees",
      {
        registration_fee: "75000.00",
        card_fee: "15000.00",
        renewal_fee: "20000.00",
        reason: "Rapat pengurus 10/2026",
      },
      { token, headers },
    );
    const body = expectOperation("put", "/admin/settings/fees", res) as Record<string, unknown>;
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      registration_fee: "75000.00",
      card_fee: "15000.00",
      renewal_fee: "20000.00",
      registration_total: "90000.00",
      version: String(Number(current) + 1),
      effective_from: t.clock.now().toISOString(),
      updated_by: { admin_id: manager.admin.adminId, display_name: "Bendahara Uji" },
    });

    // Payment yang sudah dibuat tidak berubah (snapshot nominal + settings_version lama, AC F03-5).
    const [after] = await t.db.select().from(payments).where(eq(payments.id, existing.id));
    expect(after!.amount).toBe("60000.00");
    expect(after!.settingsVersion).toBe(existing.settingsVersion);
    // Payment baru membaca versi aktif yang baru.
    const entry = await t.settings.getEntry("fees");
    expect(entry.version).toBe(Number(current) + 1);
    expect(entry.value.registration_fee).toBe("75000.00");

    // Audit dalam transaksi yang sama: aktor admin, before/after + versi (snapshot konfigurasi), alasan.
    const audit = await lastSettingsAudit("fees");
    expect(audit).toMatchObject({
      entityType: "app_setting",
      actorAdminId: manager.admin.adminId,
      effectiveRole: "admin",
      reason: "Rapat pengurus 10/2026",
    });
    expect(audit.before).toEqual({ value: REFERENCE.fees, version: Number(current) });
    expect(audit.after).toEqual({
      value: { registration_fee: "75000.00", card_fee: "15000.00", renewal_fee: "20000.00" },
      version: Number(current) + 1,
    });
  });

  it("AC F15-4: If-Match usang menghasilkan 409 VERSION_CONFLICT dengan current FeeSettings, tanpa menimpa", async () => {
    const stale = await version("fees");
    const first = await manager.sensitive(stale);
    const ok = await api.put(
      "/admin/settings/fees",
      { registration_fee: "55000.00", card_fee: "10000.00", renewal_fee: "10000.00" },
      first,
    );
    expect(ok.statusCode).toBe(200);
    const second = await manager.sensitive(stale);
    const res = await api.put(
      "/admin/settings/fees",
      { registration_fee: "99000.00", card_fee: "10000.00", renewal_fee: "10000.00" },
      second,
    );
    const body = expectOperation("put", "/admin/settings/fees", res) as {
      code: string;
      current: Record<string, unknown>;
    };
    expect(res.statusCode).toBe(409);
    expect(body.code).toBe("VERSION_CONFLICT");
    expectSchema("FeeSettings", body.current);
    expect(body.current).toMatchObject({ registration_fee: "55000.00", version: String(Number(stale) + 1) });
    expect((await t.settings.getEntry("fees")).value.registration_fee).toBe("55000.00");
  });

  it("AC F15-3: tanpa X-Reauth-Token ditolak 403 REAUTH_REQUIRED; tanpa If-Match 400", async () => {
    const current = await version("fees");
    const noReauth = await api.put(
      "/admin/settings/fees",
      { registration_fee: "1.00", card_fee: "1.00", renewal_fee: "1.00" },
      { token: manager.token, headers: { "if-match": current } },
    );
    expect(noReauth.statusCode).toBe(403);
    expect(expectOperation("put", "/admin/settings/fees", noReauth)).toMatchObject({
      code: "REAUTH_REQUIRED",
    });

    const noIfMatch = await api.put(
      "/admin/settings/fees",
      { registration_fee: "1.00", card_fee: "1.00", renewal_fee: "1.00" },
      await manager.sensitive(),
    );
    expect(noIfMatch.statusCode).toBe(400);
    expect(expectOperation("put", "/admin/settings/fees", noIfMatch)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { "If-Match": expect.any(Array) },
    });
    expect((await t.settings.getEntry("fees")).value.registration_fee).toBe("50000.00");
  });

  it.each([
    ["registration_fee", "50000"],
    ["card_fee", "-1.00"],
    ["renewal_fee", "1000000000000.00"],
    ["registration_fee", "1.5"],
  ])("ARCHITECTURE §2.5: nominal %s=%j ditolak 400 pada field-nya", async (field, value) => {
    const current = await version("fees");
    const res = await api.put(
      "/admin/settings/fees",
      { ...REFERENCE.fees, [field]: value },
      await manager.sensitive(current),
    );
    expect(res.statusCode).toBe(400);
    expect(expectOperation("put", "/admin/settings/fees", res)).toMatchObject({
      field_errors: { [field]: expect.any(Array) },
    });
  });

  it("nominal maksimum numeric(14,2) diterima", async () => {
    const current = await version("fees");
    const res = await api.put(
      "/admin/settings/fees",
      { registration_fee: "999999999999.99", card_fee: "0.00", renewal_fee: "0.00" },
      await manager.sensitive(current),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registration_total: "999999999999.99" });
  });
});

describe("PUT /admin/settings/min-app-version (AC F15-3, PRD 4.5, 8.4)", () => {
  it("PRD 8.4: menaikkan versi minimum platform tanpa tautan toko ditolak 400 pada platform itu", async () => {
    const current = await version("min_app_version");
    const res = await api.put(
      "/admin/settings/min-app-version",
      { android: "1.1.0", ios: "1.0.0" },
      await manager.sensitive(current),
    );
    expect(res.statusCode).toBe(400);
    expect(expectOperation("put", "/admin/settings/min-app-version", res)).toMatchObject({
      field_errors: { android: expect.any(Array) },
    });
  });

  it("AC F15-3: setelah tautan toko diisi, versi dinaikkan, diaudit, dan tampil di /public/config", async () => {
    await setSetting(t, "store_links", {
      android: "https://play.google.com/store/apps/details?id=id.kapdh",
      ios: null,
    });
    const current = await version("min_app_version");
    const res = await api.put(
      "/admin/settings/min-app-version",
      { android: "1.2.0", ios: "1.0.0" },
      await manager.sensitive(current),
    );
    const body = expectOperation("put", "/admin/settings/min-app-version", res);
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ android: "1.2.0", ios: "1.0.0", version: String(Number(current) + 1) });
    const audit = await lastSettingsAudit("min_app_version");
    expect(audit.after).toEqual({ value: { android: "1.2.0", ios: "1.0.0" }, version: Number(current) + 1 });
    const config = await api.get("/public/config");
    expect(config.json().min_app_version).toEqual({ android: "1.2.0", ios: "1.0.0" });
    // Gerbang versi aplikasi langsung memakai nilai baru (PRD 4.5: 426 UPGRADE_REQUIRED).
    const old = await api.post(
      "/auth/login",
      { email: "x@contoh.test", password: "Salah#2026" },
      { headers: { "x-app-platform": "android", "x-app-version": "1.1.0" } },
    );
    expect(old.statusCode).toBe(426);
    // Menurunkan versi tidak memerlukan tautan toko.
    const lowered = await api.put(
      "/admin/settings/min-app-version",
      { android: "1.0.0", ios: "1.0.0" },
      await manager.sensitive(Number(current) + 1),
    );
    expect(lowered.statusCode).toBe(200);
  });

  it.each([["1.2"], ["01.2.0"], ["1.2.0-beta"], ["v1.2.0"]])(
    "versi %j bukan semver MAJOR.MINOR.PATCH: 400",
    async (value) => {
      const current = await version("min_app_version");
      const res = await api.put(
        "/admin/settings/min-app-version",
        { android: value, ios: "1.0.0" },
        await manager.sensitive(current),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ field_errors: { android: expect.any(Array) } });
    },
  );
});

describe("PUT /admin/settings/maintenance (PRD 4.5, 8.4)", () => {
  it("PRD 4.5: mengaktifkan tanpa pesan atau dengan perkiraan selesai di masa lalu ditolak 400", async () => {
    const current = await version("maintenance");
    const noMessage = await api.put(
      "/admin/settings/maintenance",
      { active: true, message: "   ", until: null },
      await manager.sensitive(current),
    );
    expect(noMessage.statusCode).toBe(400);
    expect(noMessage.json()).toMatchObject({ field_errors: { message: expect.any(Array) } });
    const past = await api.put(
      "/admin/settings/maintenance",
      {
        active: true,
        message: "Pemeliharaan 1-2 jam. Bantuan: bantuan@kapdh.or.id",
        until: new Date(t.clock.now().getTime() - 60_000).toISOString(),
      },
      await manager.sensitive(current),
    );
    expect(past.statusCode).toBe(400);
    expect(expectOperation("put", "/admin/settings/maintenance", past)).toMatchObject({
      field_errors: { until: expect.any(Array) },
    });
  });

  it("PRD 4.5: maintenance aktif langsung tampil di /public/config dan menolak mutasi anggota 503; API admin tetap berjalan", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const current = await version("maintenance");
    const until = new Date(t.clock.now().getTime() + 2 * 3600_000).toISOString();
    const res = await api.put(
      "/admin/settings/maintenance",
      { active: true, message: "Pemeliharaan 1-2 jam. Bantuan: bantuan@kapdh.or.id", until },
      await manager.sensitive(current),
    );
    expect(expectOperation("put", "/admin/settings/maintenance", res)).toMatchObject({
      active: true,
      until,
      version: String(Number(current) + 1),
    });
    const config = await api.get("/public/config");
    expect(config.json().maintenance).toMatchObject({ active: true });
    const blocked = await api.post("/auth/login", { email: member.email, password: member.password });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ code: "MAINTENANCE" });
    // Mengakhiri maintenance tetap lewat API admin.
    const off = await api.put(
      "/admin/settings/maintenance",
      { active: false, message: null, until: null },
      await manager.sensitive(Number(current) + 1),
    );
    expect(off.statusCode).toBe(200);
    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(200);
  });

  it("D7-01 (PRD 4.5, AC F15-3): setelah token reauth awal kedaluwarsa, pengurus reautentikasi lewat POST /auth/reauth dan mematikan maintenance; unggahan pengurus diproses; anggota tetap 503", async () => {
    const keeper = await adminActor(t, {
      permissions: ["settings.manage", "payments.read", "payments.decide"],
      displayName: "Pengurus Pemeliharaan",
    });
    const member = await createAlumni(t, { status: "verified" });
    const memberToken = (await signInAlumni(t, member)).accessToken;
    const current = await version("maintenance");
    const on = await api.put(
      "/admin/settings/maintenance",
      { active: true, message: "Pemeliharaan server", until: null },
      await keeper.sensitive(current),
    );
    expect(on.statusCode, on.body).toBe(200);
    const onVersion = String(Number(current) + 1);

    // Token reauth yang dipakai saat mengaktifkan berlaku <= 10 menit; tanpa reauth baru, mematikan ditolak 403.
    t.clock.advance(11 * 60_000);
    const stale = await api.put(
      "/admin/settings/maintenance",
      { active: false, message: null, until: null },
      { token: keeper.token, headers: { "if-match": onVersion } },
    );
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: "REAUTH_REQUIRED" });

    // Anggota tidak mendapat pengecualian: reautentikasi dan unggahan tetap 503 MAINTENANCE.
    const memberReauth = await api.post(
      "/auth/reauth",
      { password: member.password },
      { token: memberToken },
    );
    expect([memberReauth.statusCode, memberReauth.json().code]).toEqual([503, "MAINTENANCE"]);
    const memberUpload = await postFile(t.app, memberToken, "payment_proof");
    expect([memberUpload.statusCode, memberUpload.json().code]).toEqual([503, "MAINTENANCE"]);

    // Pengurus: unggah bukti kerja (D13) dan reautentikasi sandi + TOTP diproses walau maintenance aktif.
    const upload = await postFile(t.app, keeper.token, "payment_proof");
    expect(upload.statusCode, upload.body).toBe(201);
    t.clock.advance(30_000); // langkah TOTP baru (langkah login tidak dapat dipakai ulang)
    const reauth = await api.post(
      "/auth/reauth",
      { password: keeper.admin.password, totp_code: totp(keeper.admin.totpSecret, t.clock.now()) },
      { token: keeper.token },
    );
    expect(reauth.statusCode, reauth.body).toBe(200);
    const reauthToken = (expectOperation("post", "/auth/reauth", reauth) as { reauth_token: string })
      .reauth_token;
    const off = await api.put(
      "/admin/settings/maintenance",
      { active: false, message: null, until: null },
      { token: keeper.token, headers: { "x-reauth-token": reauthToken, "if-match": onVersion } },
    );
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ active: false });
    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(200);
  });
});

describe("PUT /admin/settings/store-links (PRD 4.5, 5.2)", () => {
  it.each([
    ["android", "http://play.google.com/store/apps/details?id=x"],
    ["android", "https://evil.example/play.google.com/"],
    ["android", "https://play.google.com.evil.example/x"],
    ["ios", "https://play.google.com/store/apps/details?id=x"],
    ["ios", "javascript:alert(1)"],
  ])("PRD 5.2: tautan %s=%j ditolak 400", async (field, value) => {
    const current = await version("store_links");
    const res = await api.put(
      "/admin/settings/store-links",
      { android: null, ios: null, [field]: value },
      await manager.sensitive(current),
    );
    expect(res.statusCode).toBe(400);
    expect(expectOperation("put", "/admin/settings/store-links", res)).toMatchObject({
      field_errors: { [field]: expect.any(Array) },
    });
  });

  it("tautan https Google Play dan App Store disimpan; null mengosongkan", async () => {
    const current = await version("store_links");
    const links = {
      android: "https://play.google.com/store/apps/details?id=id.kapdh.app",
      ios: "https://apps.apple.com/id/app/kapdh/id123456",
    };
    const res = await api.put("/admin/settings/store-links", links, await manager.sensitive(current));
    expect(expectOperation("put", "/admin/settings/store-links", res)).toMatchObject(links);
    const cleared = await api.put(
      "/admin/settings/store-links",
      { android: null, ios: links.ios },
      await manager.sensitive(Number(current) + 1),
    );
    expect(expectOperation("put", "/admin/settings/store-links", cleared)).toMatchObject({ android: null });
  });
});

describe("PUT /admin/settings/payment-instructions (D13)", () => {
  it("D13: platform ganda atau tidak dikenal ditolak 400; daftar sah disimpan dengan alasan di audit", async () => {
    const current = await version("payment_instructions");
    const dup = await api.put(
      "/admin/settings/payment-instructions",
      { dues_hidden_platforms: ["ios", "ios"] },
      await manager.sensitive(current),
    );
    expect(dup.statusCode).toBe(400);
    expect(dup.json()).toMatchObject({ field_errors: { dues_hidden_platforms: expect.any(Array) } });
    const unknown = await api.put(
      "/admin/settings/payment-instructions",
      { dues_hidden_platforms: ["web"] },
      await manager.sensitive(current),
    );
    expect(unknown.statusCode).toBe(400);

    const res = await api.put(
      "/admin/settings/payment-instructions",
      { dues_hidden_platforms: ["ios"], reason: "Review App Store 3.1.1" },
      await manager.sensitive(current),
    );
    expect(expectOperation("put", "/admin/settings/payment-instructions", res)).toMatchObject({
      dues_hidden_platforms: ["ios"],
      version: String(Number(current) + 1),
    });
    expect((await lastSettingsAudit("payment_instructions")).reason).toBe("Review App Store 3.1.1");
    expect((await t.settings.getEntry("payment_instructions")).value.dues_hidden_platforms).toEqual(["ios"]);
  });
});

describe("PUT /admin/settings/support (PRD 8.3)", () => {
  it("PRD 8.3: email dinormalisasi; WhatsApp wajib E.164", async () => {
    const current = await version("support");
    const bad = await api.put(
      "/admin/settings/support",
      { email: "bantuan@kapdh.or.id", whatsapp: "08123456789" },
      await manager.sensitive(current),
    );
    expect(bad.statusCode).toBe(400);
    expect(expectOperation("put", "/admin/settings/support", bad)).toMatchObject({
      field_errors: { whatsapp: expect.any(Array) },
    });
    const res = await api.put(
      "/admin/settings/support",
      { email: "Bantuan@KAPDH.or.id", whatsapp: "+6281234567890" },
      await manager.sensitive(current),
    );
    expect(res.statusCode).toBe(200);
    expect(expectOperation("put", "/admin/settings/support", res)).toMatchObject({
      email: "bantuan@kapdh.or.id",
      whatsapp: "+6281234567890",
    });
    expect((await api.get("/public/config")).json().support).toEqual({
      email: "bantuan@kapdh.or.id",
      whatsapp: "+6281234567890",
    });
  });
});

describe("Otorisasi pengaturan (PRD 2.3, AC F15-1)", () => {
  it("AC F15-1: admin tanpa settings.manage ditolak 403 pada baca dan ubah walaupun URL diketahui", async () => {
    const payments = await adminActor(t, { permissions: ["payments.read", "payments.decide"] });
    for (const path of ["/admin/settings", "/admin/settings/fees"]) {
      const res = await api.get(path, { token: payments.token });
      expect(res.statusCode, path).toBe(403);
      expect(expectOperation("get", path, res)).toMatchObject({ code: "FORBIDDEN" });
    }
    const put = await api.put(
      "/admin/settings/fees",
      { ...REFERENCE.fees },
      await payments.sensitive(await version("fees")),
    );
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("token aplikasi alumni ditolak 403 FORBIDDEN; tanpa token 401", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const res = await api.get("/admin/settings", { token: session.accessToken });
    expect(res.statusCode).toBe(403);
    expect(expectOperation("get", "/admin/settings", res)).toMatchObject({ code: "FORBIDDEN" });
    const anon = await api.get("/admin/settings/fees");
    expect(anon.statusCode).toBe(401);
    expect(expectOperation("get", "/admin/settings/fees", anon)).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("Super Admin memiliki settings.manage tanpa penugasan eksplisit", async () => {
    const superAdmin = await adminActor(t, { role: "super_admin" });
    const res = await api.get("/admin/settings", { token: superAdmin.token });
    expect(res.statusCode).toBe(200);
  });
});
