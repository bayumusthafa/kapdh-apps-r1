import { alumni, auditLogs, membershipEvents, payments, users } from "@kapdh/database";
import { MEMBERSHIP_LABEL } from "@kapdh/shared";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { MembershipKernel } from "../../src/core/membership/membership.kernel.js";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { QR_AUDIENCE, QR_ISSUER, QrTokenService } from "../../src/core/qr/qr-token.service.js";
import { expectOperation } from "../support/contract.js";
import { createAlumni, createMembershipPayment, setSetting, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminWith, approveMembershipPayment, getCard, parseQr, verifyKta } from "./helpers.js";

/**
 * KTA digital (F-05) dan verifikasi KTA publik (F-06): label status kartu, QR bertanda tangan hanya untuk kartu aktif,
 * batas cache offline dari server, dan urutan penilaian verifikasi kontrak public.yaml (AC F05-1..F05-6,
 * F06-1..F06-4, F12-4).
 */

let t: TestApp;
const DAY_MS = 24 * 3600_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

async function member(options: Parameters<typeof createAlumni>[1] = {}) {
  const fixture = await createAlumni(t, options);
  const session = await signInAlumni(t, fixture);
  return { fixture, token: session.accessToken };
}

function suspend(userId: string) {
  return runAsSystem(() =>
    t.db.transaction((tx) =>
      t.app.get(MembershipKernel).suspend(tx, userId, {
        reason: "Pelanggaran ketentuan komunitas (uji)",
        memberMessage: "Akun Anda dibatasi sementara.",
        actorAdminId: null,
      }),
    ),
  );
}

describe("GET /me/card (F-05)", () => {
  it("AC F05-1: kartu Tidak Aktif dengan ajakan bayar setelah OTP; registration paid → nomor sama, Aktif, QR terverifikasi online", async () => {
    const { fixture, token } = await member({ status: "unverified" });
    const inactive = await getCard(t, token);
    expect(inactive).toMatchObject({
      status_label: "inactive",
      member_number: fixture.memberNumber,
      qr: null,
      expires_at: null,
      action: "pay_registration",
      open_payment_id: null,
      offline_valid_until: null,
      renewal_opens_at: null,
    });

    // Iuran pendaftaran terbuka → tombol Bayar melanjutkan payment yang sama.
    const pending = await createMembershipPayment(t, {
      userId: fixture.userId,
      type: "registration",
      status: "pending",
    });
    expect(await getCard(t, token)).toMatchObject({
      action: "continue_payment",
      open_payment_id: pending.id,
    });

    // Persetujuan pengurus (alur payments): payment paid + MembershipKernel.applyPaidPayment pada satu transaksi.
    const approvedAt = t.clock.now();
    await t.db
      .update(payments)
      .set({ status: "paid", decidedAt: approvedAt })
      .where(eq(payments.id, pending.id));
    await runAsSystem(() =>
      t.db.transaction((tx) =>
        t.app.get(MembershipKernel).applyPaidPayment(tx, { id: pending.id }, approvedAt),
      ),
    );
    const active = await getCard(t, token);
    expect(active.status_label).toBe("active");
    expect(active.member_number).toBe(fixture.memberNumber);
    expect(active.expires_at).toBe(addCalendarMonthsJakarta(approvedAt, 12).toISOString());
    expect(active.action).toBeNull();
    expect(active.qr).not.toBeNull();
    const qr = parseQr(active.qr!.url);
    expect(qr.memberNumber).toBe(fixture.memberNumber);
    expect(active.qr!.url.startsWith(`${t.env.PUBLIC_WEB_URL}/kta/`)).toBe(true);
    const { body } = await verifyKta(t, qr.memberNumber, qr.token);
    expect(body).toMatchObject({
      result: "active",
      expiring: false,
      checked_at: t.clock.now().toISOString(),
    });
  });

  it("AC F05-2, F05-3: offline_valid_until = min(synced_at + 7 hari, expires_at, token QR); tanpa QR = tidak boleh tampil aktif offline", async () => {
    const verified = await getCard(t, (await member({ status: "verified" })).token);
    const synced = new Date(verified.synced_at).getTime();
    expect(verified.synced_at).toBe(t.clock.now().toISOString());
    // Umur token maksimal 7 hari (PRD 3.5).
    expect(new Date(verified.qr!.token_expires_at).getTime()).toBe(synced + 7 * DAY_MS);
    expect(verified.offline_valid_until).toBe(new Date(synced + 7 * DAY_MS).toISOString());

    // Sisa masa 3 hari: token dan batas offline dipangkas expires_at.
    const short = await member({ status: "expiring" });
    const expiresAt = new Date(t.clock.now().getTime() + 3 * DAY_MS);
    await t.db.update(alumni).set({ expiresAt }).where(eq(alumni.userId, short.fixture.userId));
    const expiring = await getCard(t, short.token);
    expect(expiring.status_label).toBe("expiring");
    expect(expiring.qr!.token_expires_at).toBe(expiresAt.toISOString());
    expect(expiring.offline_valid_until).toBe(expiresAt.toISOString());

    // Expired: tidak ada QR dan tidak boleh tampil aktif secara offline.
    const expired = await getCard(t, (await member({ status: "expired" })).token);
    expect(expired).toMatchObject({ status_label: "expired", qr: null, offline_valid_until: null });
  });

  it("AC F05-4: anggota disuspend setelah sinkronisasi → kartu suspended tanpa QR, verifikasi publik Tidak aktif", async () => {
    const { fixture, token } = await member({ status: "verified" });
    const before = await getCard(t, token);
    const qr = parseQr(before.qr!.url);
    expect((await verifyKta(t, qr.memberNumber, qr.token)).body.result).toBe("active");

    await suspend(fixture.userId);
    // Sesi dicabut saat suspend; setelah login ulang kartu dari server menggantikan cache aktif.
    expect((await httpClient(t.app).get("/me/card", { token })).statusCode).toBe(401);
    const relogin = await signInAlumni(t, fixture);
    const after = await getCard(t, relogin.accessToken);
    expect(after).toMatchObject({
      status_label: "suspended",
      qr: null,
      action: null,
      open_payment_id: null,
      offline_valid_until: null,
    });
    // Kartu offline tidak dapat melewati suspend: verifikasi selalu memakai status server (AC F12-4).
    const { body } = await verifyKta(t, qr.memberNumber, qr.token);
    expect(body).toMatchObject({ result: "inactive", member: null, expiring: false });
  });

  it("AC F05-5: renewal paid → nomor tetap, expires_at periode baru; token lama tunduk expiry dan status terbaru", async () => {
    const { fixture, token } = await member({ status: "expiring" });
    const old = await getCard(t, token);
    const oldQr = parseQr(old.qr!.url);
    await approveMembershipPayment(t, fixture.userId, "renewal");
    const renewed = await getCard(t, token);
    expect(renewed.member_number).toBe(old.member_number);
    // AC F07-1: periode baru dimulai dari expires_at lama.
    expect(renewed.expires_at).toBe(addCalendarMonthsJakarta(new Date(old.expires_at!), 12).toISOString());
    expect(renewed.status_label).toBe("active");

    // Token lama (7 hari) masih sah sampai exp-nya; setelah lewat tidak pernah Aktif dan, karena bukan token yang
    // dipangkas masa keanggotaan, hasilnya invalid_token (pemeriksa meminta QR baru).
    t.clock.advance(11 * DAY_MS);
    const stale = await verifyKta(t, oldQr.memberNumber, oldQr.token);
    expect(stale.body).toMatchObject({ result: "invalid_token", member: null });
    // Access token 15 menit sudah habis setelah jam dimajukan: masuk ulang lalu sinkron kartu baru.
    const relogin = await signInAlumni(t, fixture);
    const fresh = parseQr((await getCard(t, relogin.accessToken)).qr!.url);
    expect((await verifyKta(t, fresh.memberNumber, fresh.token)).body.result).toBe("active");
  });

  it("AC F05-6: koreksi kelas keluar 12.02.01.N → 12.01.01.N, N tetap, audit nomor lama/baru, QR baru; nomor dari klien ditolak", async () => {
    const { fixture, token } = await member({
      status: "verified",
      cohort: 12,
      classIn: 1,
      classOut: 4,
      gender: "male",
    });
    const seq = fixture.memberSeq!;
    expect(fixture.memberNumber).toBe(`12.02.01.${seq}`);
    const oldQr = parseQr((await getCard(t, token)).qr!.url);
    const { token: adminToken } = await adminWith(t, ["members.read", "members.manage"]);
    const api = httpClient(t.app);
    const detail = (await api.get(`/admin/members/${fixture.userId}`, { token: adminToken })).json() as {
      version: string;
    };

    // Nomor dari klien ditolak 400 dan tidak ada field yang berubah.
    const forged = await api.patch(
      `/admin/members/${fixture.userId}`,
      { reason: "Koreksi data", member_number: `12.01.01.${seq}`, class_out: 6 },
      { token: adminToken, headers: { "if-match": detail.version } },
    );
    expect(forged.statusCode).toBe(400);
    expect(expectOperation("patch", "/admin/members/{userId}", forged)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { member_number: [expect.any(String)] },
    });
    const [unchanged] = await t.db.select().from(alumni).where(eq(alumni.userId, fixture.userId));
    expect(unchanged!.memberNumber).toBe(`12.02.01.${seq}`);

    const corrected = await api.patch(
      `/admin/members/${fixture.userId}`,
      { reason: "Koreksi kelas keluar sesuai ijazah", class_out: 6 },
      { token: adminToken, headers: { "if-match": detail.version } },
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(expectOperation("patch", "/admin/members/{userId}", corrected)).toMatchObject({
      member_number: `12.01.01.${seq}`,
      education_status: "01",
      class_out: 6,
    });
    const [row] = await t.db.select().from(alumni).where(eq(alumni.userId, fixture.userId));
    expect(row!.memberSeq).toBe(seq);
    const [event] = await t.db
      .select()
      .from(membershipEvents)
      .where(
        and(eq(membershipEvents.userId, fixture.userId), eq(membershipEvents.kind, "number_correction")),
      );
    expect(event).toMatchObject({
      beforeMemberNumber: `12.02.01.${seq}`,
      afterMemberNumber: `12.01.01.${seq}`,
      reason: "Koreksi kelas keluar sesuai ijazah",
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, fixture.userId), eq(auditLogs.action, "member.number_corrected")));
    expect(audit!.before).toMatchObject({ member_number: `12.02.01.${seq}` });
    expect(audit!.after).toMatchObject({ member_number: `12.01.01.${seq}` });

    // QR lama (URL bernomor lama) "perlu diperbarui"; kartu berikutnya memuat nomor dan QR baru yang Aktif.
    expect((await verifyKta(t, oldQr.memberNumber, oldQr.token)).body.result).toBe("invalid_token");
    const newQr = parseQr((await getCard(t, token)).qr!.url);
    expect(newQr.memberNumber).toBe(`12.01.01.${seq}`);
    expect((await verifyKta(t, newQr.memberNumber, newQr.token)).body.result).toBe("active");

    // N tidak dapat dipakai anggota lain (immutable + unik, PRD 3.5).
    const other = await createAlumni(t, { status: "verified" });
    await expect(
      t.db.update(alumni).set({ memberSeq: seq }).where(eq(alumni.userId, other.userId)),
    ).rejects.toThrow();
  });

  it("PRD 2.2, 3.5: expired berlabel KTA Kedaluwarsa tanpa QR dengan ajakan Perpanjang; isi kartu minimum tanpa kontak", async () => {
    const { token } = await member({ status: "expired", city: "Garut" });
    const card = await getCard(t, token);
    expect(card).toMatchObject({
      status_label: "expired",
      qr: null,
      action: "renew",
      city: "Garut",
      cohort: 29,
      cohort_code: "KAPDH 29",
      graduation_year: 2025,
    });
    expect(MEMBERSHIP_LABEL.expired).toBe("KTA Kedaluwarsa");
    expect(card.renewal_opens_at).not.toBeNull();
    for (const key of ["email", "phone", "address"]) expect(card).not.toHaveProperty(key);
  });

  it("Akses: tanpa sesi 401, token admin 403; kartu tidak dicache perantara", async () => {
    const api = httpClient(t.app);
    expect((await api.get("/me/card")).statusCode).toBe(401);
    const { token: adminToken } = await adminWith(t, ["members.read"]);
    const asAdmin = await api.get("/me/card", { token: adminToken });
    expect(asAdmin.statusCode).toBe(403);
    const { token } = await member({ status: "verified" });
    const res = await api.get("/me/card", { token });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("POST /public/kta/verify (F-06)", () => {
  async function activeQr(status: "verified" | "expiring" = "verified") {
    const m = await member({ status, fullName: "Ahmad Pemeriksa", cohort: 25 });
    const card = await getCard(t, m.token);
    return { ...m, card, qr: parseQr(card.qr!.url) };
  }

  it("AC F06-1: token valid anggota aktif → Aktif + checked_at + identitas minimum; expiring tetap Aktif dengan tanggal habis", async () => {
    const { card, qr } = await activeQr("verified");
    const { res, body } = await verifyKta(t, qr.memberNumber, qr.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({
      result: "active",
      checked_at: t.clock.now().toISOString(),
      expiring: false,
      member: {
        full_name: "Ahmad Pemeriksa",
        cohort_code: "KAPDH 25",
        member_number: qr.memberNumber,
        expires_at: card.expires_at,
        avatar_url: null,
      },
    });

    const expiring = await activeQr("expiring");
    const result = await verifyKta(t, expiring.qr.memberNumber, expiring.qr.token);
    expect(result.body).toMatchObject({
      result: "active",
      expiring: true,
      member: { expires_at: expiring.card.expires_at },
    });
  });

  it("AC F06-1: foto anggota aktif sebagai URL anonim berumur pendek yang dapat dibuka pemeriksa", async () => {
    const { fixture, token } = await member({ status: "verified" });
    const avatar = await uploadTestFile(t, token, "avatar");
    await t.db.update(alumni).set({ avatarFileId: avatar.id }).where(eq(alumni.userId, fixture.userId));
    const qr = parseQr((await getCard(t, token)).qr!.url);
    const { body } = await verifyKta(t, qr.memberNumber, qr.token);
    const url = body.member!.avatar_url!;
    expect(url.startsWith(`${t.env.API_PUBLIC_URL}/api/v1/files/content/`)).toBe(true);
    const content = await t.app.inject({ method: "GET", url: url.slice(t.env.API_PUBLIC_URL.length) });
    expect(content.statusCode).toBe(200);
  });

  it("AC F06-2: belum bayar, suspended, disabled, deletion_pending → Tidak aktif tanpa alasan; akun terhapus → Tidak ditemukan", async () => {
    const qrService = t.app.get(QrTokenService);
    // Belum membayar iuran pendaftaran: token sah (mis. terbit sebelum data berubah) tetap Tidak aktif.
    const unverified = await createAlumni(t, { status: "unverified" });
    const signed = await qrService.sign({
      userId: unverified.userId,
      memberSeq: unverified.memberSeq!,
      membershipExpiresAt: new Date(t.clock.now().getTime() + 30 * DAY_MS),
    });
    expect((await verifyKta(t, unverified.memberNumber!, signed!.token)).body).toMatchObject({
      result: "inactive",
      member: null,
      expiring: false,
    });

    const suspended = await activeQr();
    await suspend(suspended.fixture.userId);
    const suspendedResult = await verifyKta(t, suspended.qr.memberNumber, suspended.qr.token);
    expect(suspendedResult.body).toEqual({
      result: "inactive",
      checked_at: expect.any(String),
      expiring: false,
      member: null,
    });
    expect(suspendedResult.res.body).not.toMatch(/Pelanggaran|dibatasi/);

    for (const status of ["disabled", "deletion_pending"] as const) {
      const m = await activeQr();
      await t.db.update(users).set({ status }).where(eq(users.id, m.fixture.userId));
      expect((await verifyKta(t, m.qr.memberNumber, m.qr.token)).body.result, status).toBe("inactive");
    }

    // Termasuk setelah penghapusan akun, juga bila token sudah lewat exp.
    const deleted = await activeQr();
    await t.db.update(users).set({ status: "deleted" }).where(eq(users.id, deleted.fixture.userId));
    expect((await verifyKta(t, deleted.qr.memberNumber, deleted.qr.token)).body).toMatchObject({
      result: "not_found",
      member: null,
    });
    t.clock.advance(8 * DAY_MS);
    expect((await verifyKta(t, deleted.qr.memberNumber, deleted.qr.token)).body.result).toBe("not_found");
  });

  it("AC F06-2: masa habis → Kedaluwarsa (token terpangkas expires_at); identitas hanya 30 hari setelah exp", async () => {
    const m = await member({ status: "expiring" });
    const expiresAt = new Date(t.clock.now().getTime() + 2 * DAY_MS);
    await t.db.update(alumni).set({ expiresAt }).where(eq(alumni.userId, m.fixture.userId));
    const qr = parseQr((await getCard(t, m.token)).qr!.url);

    t.clock.set(new Date(expiresAt.getTime() + DAY_MS));
    const expired = await verifyKta(t, qr.memberNumber, qr.token);
    expect(expired.body).toMatchObject({
      result: "expired",
      expiring: false,
      member: { member_number: qr.memberNumber, expires_at: expiresAt.toISOString(), avatar_url: null },
    });

    t.clock.set(new Date(expiresAt.getTime() + 31 * DAY_MS));
    expect((await verifyKta(t, qr.memberNumber, qr.token)).body).toMatchObject({
      result: "expired",
      member: null,
    });
  });

  it("AC F06-3: token diubah, kunci tidak dikenal, issuer/audience salah, nomor lain, atau token 7 hari lewat → QR tidak valid, tidak pernah Aktif", async () => {
    const { fixture, qr } = await activeQr();
    const [header, payload, signature] = qr.token.split(".") as [string, string, string];
    const tampered = `${header}.${payload}.${signature.slice(0, -2)}${signature.endsWith("A") ? "BB" : "AA"}`;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, seq: 999999 })).toString("base64url");
    const forged = `${header}.${forgedPayload}.${signature}`;
    const now = Math.floor(t.clock.now().getTime() / 1000);
    const sign = (kid: string, secret: string, iss = QR_ISSUER, aud = QR_AUDIENCE) =>
      new SignJWT({ seq: fixture.memberSeq })
        .setProtectedHeader({ alg: "HS256", kid, typ: "JWT" })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject(fixture.userId)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(new TextEncoder().encode(secret));
    const testSecret = t.env.QR_SIGNING_KEYS.split(":")[1]!;
    const cases = {
      tampered,
      forged,
      unknownKid: await sign("k-lain", "z".repeat(32)),
      wrongIssuer: await sign("k1", testSecret, "penerbit-lain"),
      wrongAudience: await sign("k1", testSecret, QR_ISSUER, "kapdh-access"),
    };
    for (const [name, token] of Object.entries(cases))
      expect((await verifyKta(t, qr.memberNumber, token)).body, name).toEqual({
        result: "invalid_token",
        checked_at: expect.any(String),
        expiring: false,
        member: null,
      });
    // Nomor berbeda dari nomor terkini akun (URL /kta/<nomor> diubah).
    const otherNumber = qr.memberNumber.replace(/\.(\d+)$/, (_m, n: string) => `.${Number(n) + 1000}`);
    expect((await verifyKta(t, otherNumber, qr.token)).body.result).toBe("invalid_token");
    // Token 7 hari biasa yang sudah lewat → invalid_token walau anggota masih aktif.
    t.clock.advance(7 * DAY_MS + 1000);
    expect((await verifyKta(t, qr.memberNumber, qr.token)).body.result).toBe("invalid_token");
  });

  it("AC F06-4: batas laju per IP dan per token → 429 RATE_LIMITED dengan retry_after_seconds; token sampah tidak menghabiskan kuota nomor", async () => {
    const api = httpClient(t.app);
    const { qr, fixture } = await activeQr();
    // 30 token sampah untuk nomor korban: tidak pernah lolos langkah 1 sehingga kuota nomor utuh.
    for (let i = 0; i < 30; i++) {
      const res = await api.post("/public/kta/verify", {
        member_number: qr.memberNumber,
        token: `sampah-${i}-${"x".repeat(20)}`,
      });
      expect(res.json().result).toBe("invalid_token");
    }
    expect((await verifyKta(t, qr.memberNumber, qr.token)).body.result).toBe("active");

    // Per token: token yang sama dipindai berulang kali dibatasi.
    t.rateLimits.clear();
    for (let i = 0; i < 20; i++)
      expect((await verifyKta(t, qr.memberNumber, qr.token)).res.statusCode).toBe(200);
    const limited = await verifyKta(t, qr.memberNumber, qr.token);
    expect(limited.res.statusCode).toBe(429);
    expect(limited.body).toMatchObject({ code: "RATE_LIMITED", retry_after_seconds: expect.any(Number) });

    // Per nomor (hanya token bertanda tangan sah): dua token berbeda untuk nomor yang sama.
    t.rateLimits.clear();
    const qrService = t.app.get(QrTokenService);
    const tokenA = qr.token;
    t.clock.advance(1000);
    const tokenB = (await qrService.sign({
      userId: fixture.userId,
      memberSeq: fixture.memberSeq!,
      membershipExpiresAt: fixture.expiresAt!,
    }))!.token;
    for (let i = 0; i < 30; i++)
      expect((await verifyKta(t, qr.memberNumber, i % 2 === 0 ? tokenA : tokenB)).res.statusCode).toBe(200);
    expect((await verifyKta(t, qr.memberNumber, tokenB)).res.statusCode).toBe(429);

    // Per IP untuk semua request.
    t.rateLimits.clear();
    for (let i = 0; i < 60; i++)
      await api.post("/public/kta/verify", {
        member_number: qr.memberNumber,
        token: `ip-${i}-${"y".repeat(20)}`,
      });
    const ipLimited = await api.post("/public/kta/verify", {
      member_number: qr.memberNumber,
      token: `ip-akhir-${"y".repeat(20)}`,
    });
    expect(ipLimited.statusCode).toBe(429);
    expectOperation("post", "/public/kta/verify", ipLimited);
  });

  it("PRD 4.5: tetap dilayani selama maintenance; body di luar skema ditolak 400", async () => {
    const { qr } = await activeQr();
    await setSetting(t, "maintenance", { active: true, message: "Pemeliharaan (uji)", until: null });
    try {
      expect((await verifyKta(t, qr.memberNumber, qr.token)).body.result).toBe("active");
    } finally {
      await setSetting(t, "maintenance", { active: false, message: null, until: null });
    }
    const api = httpClient(t.app);
    const extra = await api.post("/public/kta/verify", {
      member_number: qr.memberNumber,
      token: qr.token,
      x: 1,
    });
    expect(extra.statusCode).toBe(400);
    expectOperation("post", "/public/kta/verify", extra);
    const badNumber = await api.post("/public/kta/verify", { member_number: "12-01-01-7", token: qr.token });
    expect(badNumber.statusCode).toBe(400);
  });
});
