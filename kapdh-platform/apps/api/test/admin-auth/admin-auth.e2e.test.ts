/**
 * Modul admin-auth (kontrak C1 admin-auth.yaml; F-02 admin, F-16, PRD 8.2, N-08): undangan admin, pendaftaran TOTP
 * sebelum aktivasi, login dua tahap dengan mfa_token sekali pakai, anti replay TOTP, backup code sekali pakai,
 * pembuatan ulang backup code dengan reautentikasi, ganti sandi admin, profil admin, dan kesesuaian dekorator akses
 * dengan `x-kapdh-access` kontrak.
 */
import { PERMISSION_VALUES } from "@kapdh/contracts";
import { admins, auditLogs, mfaTotp, outboxEvents, sessions, users } from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/core/db/types.js";
import {
  ADMIN_INVITE_TTL_MS,
  adminInviteTokenHash,
  decryptSecret,
  encryptSecret,
  newAdminInviteToken,
  newTotpSecret,
  totp,
} from "../../src/core/identity/crypto.js";
import { ADMIN_ENROLL_TTL_SECONDS } from "../../src/core/identity/token.service.js";
import { accessMismatches, expectOperation, spec } from "../support/contract.js";
import {
  createAdmin,
  createAlumni,
  type InvitedAdminFixture,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp, type TestClock, testEnv } from "../support/test-app.js";
import {
  acceptInvitation,
  activateInvitation,
  familyIdOf,
  freshTotp,
  jwtClaims,
  NEW_ADMIN_PASSWORD,
  reauthTokenFor,
  stepOf,
  wrongTotpFor,
} from "./helpers.js";

let t: TestApp;
let app: NestFastifyApplication;
let db: Db;
let clock: TestClock;

beforeAll(async () => {
  t = await createTestApp();
  ({ app, db, clock } = t);
});
afterAll(async () => {
  await app.close();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object, headers });
const authed = (token: string, headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...headers,
});
const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers: token ? authed(token, headers) : headers });

async function adminRow(adminId: string) {
  const [row] = await db.select().from(admins).where(eq(admins.id, adminId));
  return row!;
}
async function totpRow(userId: string) {
  const [row] = await db.select().from(mfaTotp).where(eq(mfaTotp.userId, userId));
  return row;
}
async function auditsOf(adminId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, adminId), eq(auditLogs.action, action)));
}
async function securityNotices(adminId: string, kind: string) {
  const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "admin.security_notice"));
  return rows.filter((r) => {
    const payload = r.payload as { admin_id: string; kind: string };
    return payload.admin_id === adminId && payload.kind === kind;
  });
}
const invited = (options: Parameters<typeof createAdmin>[1] = {}) =>
  createAdmin(t, { ...options, status: "invited" }) as Promise<InvitedAdminFixture>;

// ------------------------------------------------------------------------------------------------ kontrak

describe("ARCHITECTURE §4.3: dekorator AdminAuthController sesuai x-kapdh-access kontrak", () => {
  it("F-02/F-16: setiap operasi admin-auth.yaml diimplementasikan dengan dekorator yang sama persis", () => {
    const routes = routeAccessList(app).filter((r) => r.name.startsWith("AdminAuthController."));
    expect(accessMismatches(routes)).toEqual([]);
    const contractOperations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => ((op as { tags?: string[] }).tags ?? []).includes("Admin Auth"))
        .map(([method]) => `${method} ${path}`),
    );
    expect(contractOperations).toHaveLength(9);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(contractOperations.sort());
    // Pemetaan eksplisit: publik untuk alur pra-sesi, admin untuk sisanya, reauth hanya backup code.
    const byPath = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    for (const path of [
      "/admin/auth/login",
      "/admin/auth/mfa",
      "/admin/auth/invitations/preview",
      "/admin/auth/invitations/accept",
      "/admin/auth/totp/enroll",
      "/admin/auth/totp/confirm",
    ])
      expect(byPath.get(`post ${path}`)!.meta.isPublic, path).toBe(true);
    expect(byPath.get("get /admin/me")!.meta.audience).toBe("admin");
    expect(byPath.get("post /admin/auth/backup-codes")!.meta).toMatchObject({
      audience: "admin",
      reauth: true,
    });
    expect(byPath.get("post /admin/auth/password/change")!.meta).toMatchObject({
      audience: "admin",
      reauth: false,
    });
  });
});

// ------------------------------------------------------------------------------------------------ undangan

describe("F-16 / PRD 8.2: undangan admin dengan token sekali pakai", () => {
  it("F-16: pratinjau menampilkan peran, izin, pengundang dan email tersamar tanpa mengonsumsi token", async () => {
    const inviter = await createAdmin(t, { role: "super_admin", displayName: "Bayu Musthafa" });
    const fixture = await invited({
      permissions: ["payments.read", "members.read"],
      displayName: "Siti Pengurus",
    });
    await db.update(admins).set({ invitedByAdminId: inviter.adminId }).where(eq(admins.id, fixture.adminId));

    const res = await post("/admin/auth/invitations/preview", { invite_token: fixture.inviteToken });
    expect(res.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/invitations/preview", res);
    expect(res.json()).toMatchObject({
      display_name: "Siti Pengurus",
      role: "admin",
      permissions: PERMISSION_VALUES.filter((p) => p === "payments.read" || p === "members.read"),
      invited_by_display_name: "Bayu Musthafa",
      expires_at: (await adminRow(fixture.adminId)).inviteExpiresAt!.toISOString(),
    });
    expect(res.json().email_masked).toMatch(/^ad\*\*\*@contoh\.test$/);
    // Tidak dikonsumsi: pratinjau kedua tetap berhasil dan hash masih tersimpan.
    expect(
      (await post("/admin/auth/invitations/preview", { invite_token: fixture.inviteToken })).statusCode,
    ).toBe(200);
    expect((await adminRow(fixture.adminId)).inviteTokenHash).toBe(adminInviteTokenHash(fixture.inviteToken));

    // Super Admin undangan (bootstrap): seluruh izin, tanpa pengundang.
    const superInvite = await invited({ role: "super_admin" });
    const superPreview = await post("/admin/auth/invitations/preview", {
      invite_token: superInvite.inviteToken,
    });
    expect(superPreview.json()).toMatchObject({
      role: "super_admin",
      permissions: [...PERMISSION_VALUES],
      invited_by_display_name: null,
    });
  });

  it("F-16: token tidak dikenal, kedaluwarsa, atau sudah dipakai → 410 OTP_EXPIRED yang sama di preview dan accept", async () => {
    const unknown = newAdminInviteToken();
    for (const url of ["/admin/auth/invitations/preview", "/admin/auth/invitations/accept"]) {
      const res = await post(url, { invite_token: unknown, password: NEW_ADMIN_PASSWORD });
      expect(res.statusCode).toBe(410);
      expect(res.json().code).toBe("OTP_EXPIRED");
      expectOperation("post", url, res);
    }

    // Dipakai sekali: preview dan accept berikutnya 410.
    const used = await invited();
    await acceptInvitation(app, used.inviteToken);
    for (const url of ["/admin/auth/invitations/preview", "/admin/auth/invitations/accept"]) {
      const res = await post(url, { invite_token: used.inviteToken, password: NEW_ADMIN_PASSWORD });
      expect(res.statusCode).toBe(410);
      expect(res.json().message).toBe("Undangan tidak berlaku lagi. Minta undangan baru ke Super Admin.");
    }

    // Kedaluwarsa (72 jam): 410 dan sandi awal tidak berubah.
    const expired = await invited();
    const [before] = await db.select().from(users).where(eq(users.id, expired.userId));
    clock.advance(ADMIN_INVITE_TTL_MS + 1000);
    for (const url of ["/admin/auth/invitations/preview", "/admin/auth/invitations/accept"]) {
      const res = await post(url, { invite_token: expired.inviteToken, password: NEW_ADMIN_PASSWORD });
      expect(res.statusCode).toBe(410);
    }
    const [after] = await db.select().from(users).where(eq(users.id, expired.userId));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect((await adminRow(expired.adminId)).status).toBe("invited");

    // Akun admin yang dinonaktifkan di tingkat users: undangan tidak berlaku.
    const blocked = await invited();
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, blocked.userId));
    expect(
      (await post("/admin/auth/invitations/preview", { invite_token: blocked.inviteToken })).statusCode,
    ).toBe(410);
  });

  it("PRD 8.2 langkah 3: penerimaan mengganti sandi awal, mengonsumsi token, status tetap invited; audit tanpa rahasia", async () => {
    const fixture = await invited();
    // Sisa sesi (data rusak) milik admin undangan: dicabut saat undangan diterima (AC F02-2, pertahanan berlapis).
    const staleSessionId = uuidv7();
    await db.insert(sessions).values({
      id: staleSessionId,
      userId: fixture.userId,
      familyId: uuidv7(),
      refreshHash: `sisa-${staleSessionId}`,
      audience: "admin",
      mfaLevel: 2,
      expiresAt: new Date(clock.now().getTime() + 3600_000),
      createdAt: clock.now(),
    });
    const res = await post("/admin/auth/invitations/accept", {
      invite_token: fixture.inviteToken,
      password: NEW_ADMIN_PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/invitations/accept", res);
    const [stale] = await db.select().from(sessions).where(eq(sessions.id, staleSessionId));
    expect(stale!.revokedAt).toEqual(clock.now());
    expect(res.json()).toMatchObject({
      totp_enrollment_required: true,
      mfa_expires_at: new Date(clock.now().getTime() + ADMIN_ENROLL_TTL_SECONDS * 1000).toISOString(),
    });
    expect(jwtClaims(res.json().mfa_token)).toMatchObject({
      aud: "kapdh-admin-enroll",
      adm: fixture.adminId,
    });

    const admin = await adminRow(fixture.adminId);
    expect(admin).toMatchObject({
      status: "invited",
      inviteTokenHash: null,
      inviteExpiresAt: null,
      activatedAt: null,
    });
    const [user] = await db.select().from(users).where(eq(users.id, fixture.userId));
    expect(await bcrypt.compare(NEW_ADMIN_PASSWORD, user!.passwordHash)).toBe(true);
    expect(await bcrypt.compare(fixture.password, user!.passwordHash)).toBe(false);
    expect(user!.emailVerifiedAt).not.toBeNull();

    const [audit] = await auditsOf(fixture.adminId, "admin.invitation_accepted");
    expect(audit).toMatchObject({
      actorAdminId: fixture.adminId,
      entityType: "admin",
      after: { status: "invited", invitation_consumed: true, mfa_enrollment_required: true },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(fixture.inviteToken);
    expect(serialized).not.toContain(NEW_ADMIN_PASSWORD);
    expect(serialized).not.toContain(user!.passwordHash);
  });

  it("F-16: sandi baru wajib aturan PRD 2.5; penolakan tidak mengonsumsi token", async () => {
    const fixture = await invited();
    for (const password of ["pendek", "tanpaangka#", "TanpaSimbol2026", "x".repeat(73)]) {
      const res = await post("/admin/auth/invitations/accept", {
        invite_token: fixture.inviteToken,
        password,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.password).toBeDefined();
      expectOperation("post", "/admin/auth/invitations/accept", res);
    }
    const tooShortToken = await post("/admin/auth/invitations/preview", { invite_token: "pendek" });
    expect(tooShortToken.statusCode).toBe(400);
    expect(
      (await post("/admin/auth/invitations/preview", { invite_token: fixture.inviteToken })).statusCode,
    ).toBe(200);
  });

  it("F-16: dua penerimaan bersamaan dengan token yang sama → tepat satu 200, yang kalah 410", async () => {
    const fixture = await invited();
    const results = await Promise.all(
      ["Pertama#2026", "Kedua#2026x"].map((password) =>
        post("/admin/auth/invitations/accept", { invite_token: fixture.inviteToken, password }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    expect(await auditsOf(fixture.adminId, "admin.invitation_accepted")).toHaveLength(1);
  });

  it("F-16: batas laju per IP pada preview undangan → 429 RATE_LIMITED", async () => {
    const unknown = newAdminInviteToken();
    for (let i = 0; i < 30; i++)
      expect((await post("/admin/auth/invitations/preview", { invite_token: unknown })).statusCode).toBe(410);
    const limited = await post("/admin/auth/invitations/preview", { invite_token: unknown });
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/admin/auth/invitations/preview", limited);
  });
});

// ------------------------------------------------------------------------------------------------ pendaftaran TOTP

describe("AC F02-2 / F-16: pendaftaran TOTP wajib sebelum akses admin", () => {
  it("AC F02-2: admin yang sudah menerima undangan tetap tidak dapat login; token pendaftaran tidak membuka API admin", async () => {
    const fixture = await invited();
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);

    const wrong = await post("/admin/auth/login", { email: fixture.email, password: "Salah#2026x" });
    const login = await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD });
    expect(login.statusCode).toBe(401);
    expect(login.json().message).toBe(wrong.json().message);

    const me = await get("/admin/me", enrollToken);
    expect(me.statusCode).toBe(403);
    expect(me.json().code).toBe("MFA_REQUIRED");
    expectOperation("get", "/admin/me", me);
    const backup = await post("/admin/auth/backup-codes", {}, authed(enrollToken));
    expect(backup.statusCode).toBe(403);
    expect(backup.json().code).toBe("MFA_REQUIRED");
    const password = await post(
      "/admin/auth/password/change",
      { current_password: NEW_ADMIN_PASSWORD, new_password: "Baru#2026xx" },
      authed(enrollToken),
    );
    expect(password.json().code).toBe("MFA_REQUIRED");

    // Token pendaftaran bukan mfa_token login: /admin/auth/mfa → 401.
    const mfa = await post("/admin/auth/mfa", { mfa_token: enrollToken, totp_code: "123456" });
    expect(mfa.statusCode).toBe(401);
    expectOperation("post", "/admin/auth/mfa", mfa);
    expect((await adminRow(fixture.adminId)).status).toBe("invited");
  });

  it("AC F02-2: mfa_token login ditolak 401 di /totp/enroll dan /totp/confirm", async () => {
    const active = await createAdmin(t);
    const login = await post("/admin/auth/login", { email: active.email, password: active.password });
    const mfaToken = login.json().mfa_token as string;
    const enroll = await post("/admin/auth/totp/enroll", { mfa_token: mfaToken });
    expect(enroll.statusCode).toBe(401);
    expectOperation("post", "/admin/auth/totp/enroll", enroll);
    const confirm = await post("/admin/auth/totp/confirm", { mfa_token: mfaToken, totp_code: "123456" });
    expect(confirm.statusCode).toBe(401);
    expectOperation("post", "/admin/auth/totp/confirm", confirm);
    // Secret admin aktif tidak tersentuh.
    expect((await totpRow(active.userId))!.verifiedAt).not.toBeNull();
  });

  it("F-16: /totp/enroll membuat secret terenkripsi + otpauth URI; diulang menggantikan secret yang belum terverifikasi", async () => {
    const fixture = await invited();
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);
    const first = await post("/admin/auth/totp/enroll", { mfa_token: enrollToken });
    expect(first.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/totp/enroll", first);
    const body = first.json();
    expect(body).toMatchObject({
      issuer: "KAPDH Admin",
      account_name: fixture.email,
      algorithm: "SHA1",
      digits: 6,
      period_seconds: 30,
    });
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauth_uri).toBe(
      `otpauth://totp/KAPDH%20Admin:${encodeURIComponent(fixture.email)}?secret=${body.secret}` +
        "&issuer=KAPDH%20Admin&algorithm=SHA1&digits=6&period=30",
    );
    const stored = await totpRow(fixture.userId);
    expect(stored).toMatchObject({ verifiedAt: null, lastUsedStep: null, backupCodeHashes: [] });
    expect(stored!.secretEncrypted).not.toContain(body.secret);
    expect(decryptSecret(stored!.secretEncrypted, testEnv.TOTP_ENC_KEY)).toBe(body.secret);

    const second = (await post("/admin/auth/totp/enroll", { mfa_token: enrollToken })).json();
    expect(second.secret).not.toBe(body.secret);
    expect(decryptSecret((await totpRow(fixture.userId))!.secretEncrypted, testEnv.TOTP_ENC_KEY)).toBe(
      second.secret,
    );
    // Kode dari secret yang sudah diganti tidak diterima.
    const stale = await post("/admin/auth/totp/confirm", {
      mfa_token: enrollToken,
      totp_code: totp(body.secret, clock.now()),
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().field_errors.totp_code).toBeDefined();

    const started = await auditsOf(fixture.adminId, "admin.mfa_enrollment_started");
    expect(started).toHaveLength(2);
    expect(JSON.stringify(started)).not.toContain(body.secret);
    expect(JSON.stringify(started)).not.toContain(second.secret);
  });

  it("F-16: /totp/confirm sebelum /totp/enroll → 400 field totp_code; secret lama dari pendaftaran sebelumnya dibuang", async () => {
    const fixture = await invited();
    // Sisa secret belum terverifikasi dari pendaftaran sebelum undangan ulang (diketahui pemegang undangan lama).
    const leftover = newTotpSecret();
    await db.insert(mfaTotp).values({
      userId: fixture.userId,
      secretEncrypted: encryptSecret(leftover, testEnv.TOTP_ENC_KEY),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);
    expect(await totpRow(fixture.userId)).toBeUndefined();
    const res = await post("/admin/auth/totp/confirm", {
      mfa_token: enrollToken,
      totp_code: totp(leftover, clock.now()),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors.totp_code[0]).toContain("Pindai kode QR");
    expectOperation("post", "/admin/auth/totp/confirm", res);
    expect((await adminRow(fixture.adminId)).status).toBe("invited");
  });

  it("F-16 PRD 8.2: kode pertama yang benar mengaktifkan admin, menerbitkan 10 backup code sekali tampil dan sesi admin", async () => {
    const fixture = await invited({ role: "super_admin", displayName: "Super Kedua" });
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);
    const secret = (await post("/admin/auth/totp/enroll", { mfa_token: enrollToken })).json()
      .secret as string;

    const wrongCode = wrongTotpFor(secret, clock.now());
    const wrong = await post("/admin/auth/totp/confirm", { mfa_token: enrollToken, totp_code: wrongCode });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toBe("Kode salah. Sisa percobaan 4.");
    expect((await adminRow(fixture.adminId)).status).toBe("invited");

    const step = stepOf(clock.now());
    const res = await post("/admin/auth/totp/confirm", {
      mfa_token: enrollToken,
      totp_code: totp(secret, clock.now()),
    });
    expect(res.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/totp/confirm", res);
    const body = res.json();
    const cookie = String(res.headers["set-cookie"] ?? "");
    expect(cookie).toContain("kapdh_admin_rt=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(body.session.idle_timeout_seconds).toBe(1800);
    expect(body.session.refresh_token).toBeUndefined();
    expect(body.backup_codes).toHaveLength(10);
    expect(new Set(body.backup_codes).size).toBe(10);
    expect(body.backup_codes_generated_at).toBe(clock.now().toISOString());

    const admin = await adminRow(fixture.adminId);
    expect(admin).toMatchObject({ status: "active", activatedAt: clock.now(), inviteTokenHash: null });
    const stored = (await totpRow(fixture.userId))!;
    expect(stored.verifiedAt).toEqual(clock.now());
    expect(stored.lastUsedStep).toBe(step);
    expect(stored.backupCodeHashes).toHaveLength(10);
    for (const code of body.backup_codes as string[]) expect(stored.backupCodeHashes).not.toContain(code);

    for (const action of ["admin.mfa_enrolled", "admin.activated", "admin.login"]) {
      const rows = await auditsOf(fixture.adminId, action);
      expect(rows, action).toHaveLength(1);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(secret);
      for (const code of body.backup_codes as string[]) expect(serialized).not.toContain(code);
    }
    const [activatedAudit] = await auditsOf(fixture.adminId, "admin.activated");
    expect(activatedAudit).toMatchObject({
      actorAdminId: fixture.adminId,
      effectiveRole: "super_admin",
      before: { status: "invited" },
      after: { status: "active", activated_at: clock.now().toISOString(), role: "super_admin" },
    });
    const [enrolledAudit] = await auditsOf(fixture.adminId, "admin.mfa_enrolled");
    expect(enrolledAudit!.after).toMatchObject({ method: "totp", backup_codes_issued: 10 });
    expect(await securityNotices(fixture.adminId, "activated")).toHaveLength(1);

    const me = await get("/admin/me", body.session.access_token);
    expect(me.statusCode).toBe(200);
    expectOperation("get", "/admin/me", me);
    expect(me.json()).toMatchObject({
      admin_id: fixture.adminId,
      email: fixture.email,
      role: "super_admin",
      permissions: [...PERMISSION_VALUES],
      has_linked_alumni: false,
      backup_codes_remaining: 10,
      previous_login_at: null,
    });
  });

  it("F-16: pengulangan /totp/confirm atau /totp/enroll setelah aktivasi → 403 'Aktivasi sudah selesai'", async () => {
    const fixture = await invited();
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);
    const secret = (await post("/admin/auth/totp/enroll", { mfa_token: enrollToken })).json()
      .secret as string;
    expect(
      (
        await post("/admin/auth/totp/confirm", {
          mfa_token: enrollToken,
          totp_code: totp(secret, clock.now()),
        })
      ).statusCode,
    ).toBe(200);
    const retry = await post("/admin/auth/totp/confirm", {
      mfa_token: enrollToken,
      totp_code: totp(secret, new Date(clock.now().getTime() + 30_000)),
    });
    expect(retry.statusCode).toBe(403);
    expect(retry.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(retry.json().message).toContain("Aktivasi sudah selesai");
    expectOperation("post", "/admin/auth/totp/confirm", retry);
    const reenroll = await post("/admin/auth/totp/enroll", { mfa_token: enrollToken });
    expect(reenroll.statusCode).toBe(403);
    expectOperation("post", "/admin/auth/totp/enroll", reenroll);
    // Secret terverifikasi tidak diganti oleh pengulangan.
    expect(decryptSecret((await totpRow(fixture.userId))!.secretEncrypted, testEnv.TOTP_ENC_KEY)).toBe(
      secret,
    );
  });

  it("F-16: konfirmasi bersamaan dengan token yang sama → tepat satu aktivasi; yang kalah 403 'Aktivasi sudah selesai'", async () => {
    const fixture = await invited();
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);
    const secret = (await post("/admin/auth/totp/enroll", { mfa_token: enrollToken })).json()
      .secret as string;
    const code = totp(secret, clock.now());
    const results = await Promise.all(
      [1, 2].map(() => post("/admin/auth/totp/confirm", { mfa_token: enrollToken, totp_code: code })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect(await auditsOf(fixture.adminId, "admin.activated")).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, fixture.userId), isNull(sessions.revokedAt))),
    ).toHaveLength(1);
  });

  it("AC F02-2: token pendaftaran berlaku 30 menit, tidak diperpanjang, dan mati bila undangan diterbitkan ulang", async () => {
    const late = await invited();
    const lateToken = await acceptInvitation(app, late.inviteToken);
    expect((await post("/admin/auth/totp/enroll", { mfa_token: lateToken })).statusCode).toBe(200);
    clock.advance(ADMIN_ENROLL_TTL_SECONDS * 1000 + 1000);
    const expired = await post("/admin/auth/totp/enroll", { mfa_token: lateToken });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe("UNAUTHENTICATED");
    expect(
      (await post("/admin/auth/totp/confirm", { mfa_token: lateToken, totp_code: "123456" })).statusCode,
    ).toBe(401);
    expect((await adminRow(late.adminId)).status).toBe("invited");

    // Undangan ulang (Super Admin/bootstrap) menyetel token undangan baru: token pendaftaran lama 401.
    const reinvited = await invited();
    const oldToken = await acceptInvitation(app, reinvited.inviteToken);
    await db
      .update(admins)
      .set({
        inviteTokenHash: adminInviteTokenHash(newAdminInviteToken()),
        inviteExpiresAt: new Date(clock.now().getTime() + ADMIN_INVITE_TTL_MS),
      })
      .where(eq(admins.id, reinvited.adminId));
    expect((await post("/admin/auth/totp/enroll", { mfa_token: oldToken })).statusCode).toBe(401);

    // Sandi diganti (pemulihan) → pengikat HMAC password_hash tidak cocok → 401.
    const rebound = await invited();
    const reboundToken = await acceptInvitation(app, rebound.inviteToken);
    await db.update(users).set({ passwordHash: "$2a$04$tidakcocok" }).where(eq(users.id, rebound.userId));
    expect((await post("/admin/auth/totp/enroll", { mfa_token: reboundToken })).statusCode).toBe(401);

    // Token rusak → 401.
    expect((await post("/admin/auth/totp/enroll", { mfa_token: "x".repeat(40) })).statusCode).toBe(401);
  });

  it("AC F02-2 kontrak /totp/confirm: 5 kode salah dalam 15 menit per admin → 429; kode benar pun ditolak selama cooldown", async () => {
    const fixture = await invited();
    const enrollToken = await acceptInvitation(app, fixture.inviteToken);
    const secret = (await post("/admin/auth/totp/enroll", { mfa_token: enrollToken })).json()
      .secret as string;
    const wrongCode = wrongTotpFor(secret, clock.now());
    for (let left = 4; left >= 0; left--) {
      const res = await post("/admin/auth/totp/confirm", { mfa_token: enrollToken, totp_code: wrongCode });
      expect(res.statusCode).toBe(400);
    }
    const limited = await post("/admin/auth/totp/confirm", {
      mfa_token: enrollToken,
      totp_code: totp(secret, clock.now()),
    });
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/admin/auth/totp/confirm", limited);
    expect((await adminRow(fixture.adminId)).status).toBe("invited");
    // F-17: penguncian diaudit sekali (429 berikutnya tidak menambah baris audit).
    const locked = await auditsOf(fixture.adminId, "admin.mfa_locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({
      effectiveRole: "anonymous",
      after: { stage: "enrollment", failed_attempts: 5, window_minutes: 15 },
    });
    expect(JSON.stringify(locked)).not.toContain(wrongCode);
  });
});

// ------------------------------------------------------------------------------------------------ login dua tahap

describe("AC F02-2: login admin dua tahap, mfa_token sekali pakai, anti replay TOTP", () => {
  it("AC F02-2: 5 kode MFA salah → 400 dengan sisa percobaan lalu 429; penguncian diaudit sekali tanpa kode", async () => {
    const fixture = await createAdmin(t);
    const login = (
      await post("/admin/auth/login", { email: fixture.email, password: fixture.password })
    ).json();
    const wrong = wrongTotpFor(fixture.totpSecret, clock.now());
    for (let left = 4; left >= 0; left--) {
      const res = await post("/admin/auth/mfa", { mfa_token: login.mfa_token, totp_code: wrong });
      expect(res.statusCode).toBe(400);
      if (left > 0)
        expect(res.json().field_errors.totp_code).toEqual([`Kode salah. Sisa percobaan ${left}.`]);
    }
    for (let i = 0; i < 2; i++) {
      const limited = await post("/admin/auth/mfa", {
        mfa_token: login.mfa_token,
        totp_code: totp(fixture.totpSecret, clock.now()),
      });
      expect(limited.statusCode).toBe(429);
      expectOperation("post", "/admin/auth/mfa", limited);
    }
    const locked = await auditsOf(fixture.adminId, "admin.mfa_locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]!.after).toMatchObject({ stage: "login", failed_attempts: 5 });
    expect(JSON.stringify(locked)).not.toContain(wrong);
    expect(await auditsOf(fixture.adminId, "admin.login")).toHaveLength(0);
  });

  it("AC F02-2 RFC 6238 §5.2: kode TOTP yang dipakai saat aktivasi tidak dapat diputar ulang untuk login", async () => {
    const fixture = await invited();
    const activated = await activateInvitation(t, fixture.inviteToken);
    const login = await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD });
    expect(login.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/login", login);
    expect(login.json().totp_enrollment_required).toBe(false);
    const replay = await post("/admin/auth/mfa", {
      mfa_token: login.json().mfa_token,
      totp_code: totp(activated.secret, clock.now()),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().field_errors.totp_code).toBeDefined();
    // Langkah sebelumnya (dalam jendela ±1) juga ditolak karena tidak lebih baru dari last_used_step.
    const previous = await post("/admin/auth/mfa", {
      mfa_token: login.json().mfa_token,
      totp_code: totp(activated.secret, new Date(clock.now().getTime() - 30_000)),
    });
    expect(previous.statusCode).toBe(400);
    const fresh = freshTotp(clock, activated.secret, activated.lastStep);
    const ok = await post("/admin/auth/mfa", { mfa_token: login.json().mfa_token, totp_code: fresh.code });
    expect(ok.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/mfa", ok);
    expect((await totpRow(fixture.userId))!.lastUsedStep).toBe(fresh.step);
  });

  it("AC F02-2: mfa_token sekali pakai — dipakai ulang setelah sesi terbentuk → 401; kode yang dikirim tidak dikonsumsi", async () => {
    const fixture = await invited();
    const activated = await activateInvitation(t, fixture.inviteToken);
    const login = (
      await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD })
    ).json();
    const first = freshTotp(clock, activated.secret, activated.lastStep);
    expect(
      (await post("/admin/auth/mfa", { mfa_token: login.mfa_token, totp_code: first.code })).statusCode,
    ).toBe(200);

    const second = freshTotp(clock, activated.secret, first.step);
    const reuseTotp = await post("/admin/auth/mfa", { mfa_token: login.mfa_token, totp_code: second.code });
    expect(reuseTotp.statusCode).toBe(401);
    expect(reuseTotp.json().code).toBe("UNAUTHENTICATED");
    expectOperation("post", "/admin/auth/mfa", reuseTotp);
    // Langkah kode tidak tercatat (transaksi dibatalkan): kode itu masih dapat dipakai dengan mfa_token baru.
    expect((await totpRow(fixture.userId))!.lastUsedStep).toBe(first.step);

    const reuseBackup = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      backup_code: activated.backupCodes[0],
    });
    expect(reuseBackup.statusCode).toBe(401);
    expect((await totpRow(fixture.userId))!.backupCodeHashes).toHaveLength(10);

    const relogin = (
      await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD })
    ).json();
    expect(
      (await post("/admin/auth/mfa", { mfa_token: relogin.mfa_token, totp_code: second.code })).statusCode,
    ).toBe(200);
    // Kode salah TIDAK mengonsumsi mfa_token (kontrak: tetap di layar MFA).
    const third = (
      await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD })
    ).json();
    expect(
      (
        await post("/admin/auth/mfa", {
          mfa_token: third.mfa_token,
          totp_code: wrongTotpFor(activated.secret, clock.now()),
        })
      ).statusCode,
    ).toBe(400);
    const next = freshTotp(clock, activated.secret, second.step);
    expect(
      (await post("/admin/auth/mfa", { mfa_token: third.mfa_token, totp_code: next.code })).statusCode,
    ).toBe(200);
    expect(await auditsOf(fixture.adminId, "admin.login")).toHaveLength(4);
  });

  it("F-02: backup code sekali pakai (HMAC, atomik): berhasil sekali, kedua kali 400; sisa terlihat di /admin/me", async () => {
    const fixture = await invited();
    const activated = await activateInvitation(t, fixture.inviteToken);
    const code = activated.backupCodes[3]!;
    const login = (
      await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD })
    ).json();
    // Masukan dinormalisasi: huruf kecil dan tanpa tanda hubung tetap diterima.
    const used = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      backup_code: code.toLowerCase().replace("-", ""),
    });
    expect(used.statusCode).toBe(200);
    const me = await get("/admin/me", used.json().access_token);
    expect(me.json().backup_codes_remaining).toBe(9);
    const [loginAudit] = (await auditsOf(fixture.adminId, "admin.login")).filter(
      (row) => (row.after as { mfa_method?: string }).mfa_method === "backup_code",
    );
    expect(loginAudit!.after).toMatchObject({ mfa_method: "backup_code", backup_codes_remaining: 9 });
    expect(JSON.stringify(loginAudit)).not.toContain(code);

    const again = (
      await post("/admin/auth/login", { email: fixture.email, password: NEW_ADMIN_PASSWORD })
    ).json();
    const reused = await post("/admin/auth/mfa", { mfa_token: again.mfa_token, backup_code: code });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().field_errors.backup_code).toBeDefined();
    expectOperation("post", "/admin/auth/mfa", reused);
  });
});

// ------------------------------------------------------------------------------------------------ backup code & sandi

describe("F-02: pembuatan ulang backup code dengan reautentikasi", () => {
  it("F-02: tanpa/tingkat-1/keluarga lain X-Reauth-Token → 403 REAUTH_REQUIRED; berhasil mengganti seluruh kode lama", async () => {
    const fixture = await createAdmin(t, { displayName: "Admin Backup" });
    const session = await signInAdmin(t, fixture);
    const other = await signInAdmin(t, fixture);

    const missing = await post("/admin/auth/backup-codes", {}, authed(session.accessToken));
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe("REAUTH_REQUIRED");
    expectOperation("post", "/admin/auth/backup-codes", missing);
    const levelOne = await reauthTokenFor(t, fixture.userId, session.accessToken, 1);
    expect(
      (
        await post(
          "/admin/auth/backup-codes",
          {},
          authed(session.accessToken, { "x-reauth-token": levelOne }),
        )
      ).json().code,
    ).toBe("REAUTH_REQUIRED");
    const otherFamily = await reauthTokenFor(t, fixture.userId, other.accessToken);
    expect(
      (
        await post(
          "/admin/auth/backup-codes",
          {},
          authed(session.accessToken, { "x-reauth-token": otherFamily }),
        )
      ).json().code,
    ).toBe("REAUTH_REQUIRED");

    // Backup code lama yang dikenal (disetel langsung) tidak berlaku setelah pembuatan ulang.
    const before = (await totpRow(fixture.userId))!;
    const reauth = await reauthTokenFor(t, fixture.userId, session.accessToken);
    const res = await post(
      "/admin/auth/backup-codes",
      {},
      authed(session.accessToken, { "x-reauth-token": reauth }),
    );
    expect(res.statusCode).toBe(200);
    expectOperation("post", "/admin/auth/backup-codes", res);
    const codes = res.json().backup_codes as string[];
    expect(codes).toHaveLength(10);
    expect(res.json().generated_at).toBe(clock.now().toISOString());
    const after = (await totpRow(fixture.userId))!;
    expect(after.backupCodeHashes).toHaveLength(10);
    expect(after.backupCodeHashes.some((h) => before.backupCodeHashes.includes(h))).toBe(false);
    expect(after.secretEncrypted).toBe(before.secretEncrypted);

    const [audit] = await auditsOf(fixture.adminId, "admin.backup_codes_regenerated");
    expect(audit).toMatchObject({ actorAdminId: fixture.adminId });
    for (const code of codes) expect(JSON.stringify(audit)).not.toContain(code);
    expect(await securityNotices(fixture.adminId, "backup_codes_regenerated")).toHaveLength(1);

    // Kode baru berlaku untuk login, sekali.
    const login = (
      await post("/admin/auth/login", { email: fixture.email, password: fixture.password })
    ).json();
    expect(
      (await post("/admin/auth/mfa", { mfa_token: login.mfa_token, backup_code: codes[0] })).statusCode,
    ).toBe(200);
  });

  it("F-02 negatif authz: token mobile 403, tanpa token 401, admin dinonaktifkan 403", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const mobile = await signInAlumni(t, member);
    const res = await post("/admin/auth/backup-codes", {}, authed(mobile.accessToken));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    expect((await post("/admin/auth/backup-codes", {})).statusCode).toBe(401);

    const fixture = await createAdmin(t);
    const session = await signInAdmin(t, fixture);
    const reauth = await reauthTokenFor(t, fixture.userId, session.accessToken);
    await db
      .update(admins)
      .set({ status: "disabled", disabledAt: clock.now() })
      .where(eq(admins.id, fixture.adminId));
    const disabled = await post(
      "/admin/auth/backup-codes",
      {},
      authed(session.accessToken, { "x-reauth-token": reauth }),
    );
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().code).toBe("FORBIDDEN");
  });
});

describe("AC F02-4: ganti sandi admin", () => {
  it("AC F02-4: sandi lama wajib; sesi admin lain dicabut, sesi ini tetap; audit dan pemberitahuan tanpa sandi", async () => {
    const fixture = await createAdmin(t);
    const current = await signInAdmin(t, fixture);
    const other = await signInAdmin(t, fixture);
    const url = "/admin/auth/password/change";
    const headers = authed(current.accessToken);

    const wrong = await post(url, { current_password: "Salah#2026x", new_password: "Baru#2026xx" }, headers);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().field_errors.current_password).toEqual(["Sandi saat ini salah."]);
    expectOperation("post", url, wrong);
    const weak = await post(url, { current_password: fixture.password, new_password: "lemah" }, headers);
    expect(weak.statusCode).toBe(400);
    expect(weak.json().field_errors.new_password).toBeDefined();
    const same = await post(
      url,
      { current_password: fixture.password, new_password: fixture.password },
      headers,
    );
    expect(same.statusCode).toBe(400);
    expect(same.json().field_errors.new_password).toBeDefined();

    const ok = await post(url, { current_password: fixture.password, new_password: "Baru#2026xx" }, headers);
    expect(ok.statusCode).toBe(204);
    expectOperation("post", url, ok);

    expect((await get("/admin/me", current.accessToken)).statusCode).toBe(200);
    expect((await get("/admin/me", other.accessToken)).statusCode).toBe(401);
    const otherFamily = await familyIdOf(db, other.accessToken);
    const [revoked] = await db.select().from(sessions).where(eq(sessions.familyId, otherFamily));
    expect(revoked!.revokedAt).not.toBeNull();

    expect(
      (await post("/admin/auth/login", { email: fixture.email, password: fixture.password })).statusCode,
    ).toBe(401);
    expect(
      (await post("/admin/auth/login", { email: fixture.email, password: "Baru#2026xx" })).statusCode,
    ).toBe(200);

    const [audit] = await auditsOf(fixture.adminId, "admin.password_changed");
    expect(audit!.after).toMatchObject({ other_sessions_revoked: 1 });
    expect(JSON.stringify(audit)).not.toContain("Baru#2026xx");
    expect(await securityNotices(fixture.adminId, "password_changed")).toHaveLength(1);
  });

  it("AC F02-4 PRD 2.5: sandi lama salah dihitung ke batas kegagalan login → 429 setelah 10 kegagalan", async () => {
    const fixture = await createAdmin(t);
    const session = await signInAdmin(t, fixture);
    const body = { current_password: "Salah#2026x", new_password: "Baru#2026xx" };
    for (let i = 0; i < 10; i++)
      expect((await post("/admin/auth/password/change", body, authed(session.accessToken))).statusCode).toBe(
        400,
      );
    const limited = await post("/admin/auth/password/change", body, authed(session.accessToken));
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/admin/auth/password/change", limited);
    // Batas yang sama dengan login admin.
    expect(
      (await post("/admin/auth/login", { email: fixture.email, password: fixture.password })).statusCode,
    ).toBe(429);
  });

  it("AC F02-4 negatif authz: token mobile 403 FORBIDDEN, mfa_token 403 MFA_REQUIRED, tanpa token 401", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const mobile = await signInAlumni(t, member);
    const body = { current_password: member.password, new_password: "Baru#2026xx" };
    const forbidden = await post("/admin/auth/password/change", body, authed(mobile.accessToken));
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("FORBIDDEN");
    const admin = await createAdmin(t);
    const login = (await post("/admin/auth/login", { email: admin.email, password: admin.password })).json();
    const mfa = await post("/admin/auth/password/change", body, authed(login.mfa_token));
    expect(mfa.json().code).toBe("MFA_REQUIRED");
    expect((await post("/admin/auth/password/change", body)).statusCode).toBe(401);
  });
});

describe("F-16 / AC F02-5: profil admin", () => {
  it("F-16: GET /admin/me memuat field wajib; akun alumni tertaut ditandai; token mobile 403, tanpa token 401", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const fixture = await createAdmin(t, {
      linkedAlumniUserId: member.userId,
      permissions: ["payments.read"],
    });
    const session = await signInAdmin(t, fixture);
    const me = await get("/admin/me", session.accessToken);
    expect(me.statusCode).toBe(200);
    expectOperation("get", "/admin/me", me);
    expect(me.json()).toMatchObject({
      email: fixture.email,
      role: "admin",
      permissions: ["payments.read"],
      has_linked_alumni: true,
      backup_codes_remaining: 0,
    });
    const mobile = await signInAlumni(t, member);
    const forbidden = await get("/admin/me", mobile.accessToken);
    expect(forbidden.statusCode).toBe(403);
    expectOperation("get", "/admin/me", forbidden);
    const anonymous = await get("/admin/me");
    expect(anonymous.statusCode).toBe(401);
    expectOperation("get", "/admin/me", anonymous);
  });

  it("AC F02-5: polling latar dan refresh tidak memperpanjang aktivitas; idle 30 menit mengakhiri sesi admin", async () => {
    const refresh = async (cookie: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { kapdh_admin_rt: cookie },
        headers: { origin: testEnv.ADMIN_ORIGIN },
      });
      expect(res.statusCode, res.body).toBe(200);
      const next = /kapdh_admin_rt=([^;]+)/.exec(String(res.headers["set-cookie"] ?? ""))![1]!;
      return { accessToken: res.json().access_token as string, cookie: next };
    };
    const background = { "x-background-request": "1" };

    const idle = await signInAdmin(t, await createAdmin(t));
    clock.advance(14 * 60_000);
    expect((await get("/admin/me", idle.accessToken, background)).statusCode).toBe(200);
    const second = await refresh(idle.refreshCookie);
    clock.advance(14 * 60_000);
    expect((await get("/admin/me", second.accessToken, background)).statusCode).toBe(200);
    const third = await refresh(second.cookie);
    // 31 menit tanpa request pengguna: access token masih berlaku, sesi ditolak karena idle.
    clock.advance(3 * 60_000);
    const expired = await get("/admin/me", third.accessToken, background);
    expect(expired.statusCode).toBe(401);
    expectOperation("get", "/admin/me", expired);

    // Pembanding: request pengguna (tanpa header latar) memperbarui aktivitas.
    const active = await signInAdmin(t, await createAdmin(t));
    clock.advance(14 * 60_000);
    expect((await get("/admin/me", active.accessToken)).statusCode).toBe(200);
    const renewed = await refresh(active.refreshCookie);
    clock.advance(14 * 60_000);
    expect((await get("/admin/me", renewed.accessToken)).statusCode).toBe(200);
    const again = await refresh(renewed.cookie);
    clock.advance(3 * 60_000);
    expect((await get("/admin/me", again.accessToken, background)).statusCode).toBe(200);
  });
});
