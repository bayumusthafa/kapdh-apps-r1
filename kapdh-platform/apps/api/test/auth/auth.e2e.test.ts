import {
  admins,
  alumni,
  auditLogs,
  deviceTokens,
  mfaTotp,
  notificationDeliveries,
  notifications,
  otpCodes,
  sessions,
  users,
} from "@kapdh/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import { backupCodeHash, newBackupCode, totp } from "../../src/modules/auth/crypto.js";
import { expectOperation } from "../support/contract.js";
import {
  type AdminFixture,
  createAdmin,
  publishLegalVersions,
  setSetting,
  signInAdmin,
  TEST_CONSENT_VERSION,
} from "../support/factories.js";
import { createTestApp, type TestApp, type TestClock, testEnv } from "../support/test-app.js";

let t: TestApp;
let app: NestFastifyApplication;
let db: Db;
let mailer: MemoryMailer;
let clock: TestClock;

beforeAll(async () => {
  t = await createTestApp();
  ({ app, db, mailer, clock } = t);
  // Registrasi hanya terbuka setelah kebijakan privasi dan ketentuan terbit (F-01, PRD 8.2 langkah 4).
  await publishLegalVersions(t);
});
afterAll(async () => {
  await app.close();
});

const PASSWORD = "Kapdh#2026";
let emailSeq = 0;
const newEmail = () => `alumni${++emailSeq}@contoh.id`;

function registerBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Ahmad Islam",
    gender: "male",
    email,
    password: PASSWORD,
    cohort: 29,
    class_in: 1,
    class_out: 6,
    accept_policy_version: TEST_CONSENT_VERSION,
    ...overrides,
  };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object, headers });
const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

async function registerAndVerify(email = newEmail()) {
  const reg = await post("/auth/register", registerBody(email));
  const code = mailer.last(email)!;
  const ver = await post("/auth/otp/verify", { challenge_id: reg.json().challenge_id, code });
  return { email, session: ver.json().session as { access_token: string; refresh_token: string } };
}

describe("F-01 registrasi dan verifikasi email", () => {
  it("AC F01-1: satu akun pending_otp dibuat dan kode tidak dikirim ke klien", async () => {
    const email = newEmail();
    const res = await post("/auth/register", registerBody(email));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.challenge_id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(mailer.last(email)!);
    expect(body.attempts_left).toBe(5);
    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending_otp");
  });

  it("menolak sandi yang tidak memenuhi aturan dan kelas keluar sebelum kelas masuk", async () => {
    const res = await post(
      "/auth/register",
      registerBody(newEmail(), { password: "kapdh2026", class_in: 5, class_out: 3 }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.json().field_errors)).toEqual(expect.arrayContaining(["password", "class_out"]));
  });

  it("menolak angkatan melebihi angkatan terbaru", async () => {
    const res = await post("/auth/register", registerBody(newEmail(), { cohort: 31 }));
    expect(res.statusCode).toBe(400);
  });

  it("AC F01-2: OTP benar mengaktifkan akun, mengalokasikan nomor anggota, dan KTA belum aktif", async () => {
    const { email, session } = await registerAndVerify();
    expect(session.access_token).toBeTruthy();
    expect(session.refresh_token).toBeTruthy();
    const me = await get("/me", session.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(email);
    expect(me.json().effective_status).toBe("unverified");
    expect(me.json().member_number).toMatch(/^29\.01\.01\.[1-9]\d*$/);
    expect(me.json().profile).toMatchObject({
      graduation_year: 2025,
      entry_year: 2019,
      exit_year: 2025,
      education_status: "01",
    });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "account.activated"));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it("nomor urut berbeda untuk setiap anggota dan tidak pernah sama", async () => {
    const a = await registerAndVerify();
    const b = await registerAndVerify();
    const na = (await get("/me", a.session.access_token)).json().member_number as string;
    const nb = (await get("/me", b.session.access_token)).json().member_number as string;
    expect(na.split(".")[3]).not.toBe(nb.split(".")[3]);
  });

  it("AC F01-3: lima kode salah membuat challenge tidak berlaku", async () => {
    const email = newEmail();
    const { challenge_id } = (await post("/auth/register", registerBody(email))).json();
    const right = mailer.last(email)!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      const r = await post("/auth/otp/verify", { challenge_id, code: wrong });
      expect(r.statusCode).toBe(400);
      expect(r.json().message).toContain(`Sisa percobaan ${5 - i}`);
    }
    expect((await post("/auth/otp/verify", { challenge_id, code: wrong })).statusCode).toBe(410);
    const after = await post("/auth/otp/verify", { challenge_id, code: right });
    expect(after.statusCode).toBe(410);
    expect(after.json().code).toBe("OTP_EXPIRED");
  });

  it("AC F01-3: kode kedaluwarsa setelah 10 menit", async () => {
    const email = newEmail();
    const { challenge_id } = (await post("/auth/register", registerBody(email))).json();
    clock.advance(10 * 60_000 + 1);
    expect((await post("/auth/otp/verify", { challenge_id, code: mailer.last(email)! })).statusCode).toBe(
      410,
    );
  });

  it("AC F01-3: kirim ulang mematuhi cooldown 60 detik dan membatalkan kode lama", async () => {
    const email = newEmail();
    const first = (await post("/auth/register", registerBody(email))).json();
    const oldCode = mailer.last(email)!;
    const early = await post("/auth/otp/resend", { challenge_id: first.challenge_id });
    expect(early.statusCode).toBe(429);
    expect(early.json().retry_after_seconds).toBeGreaterThan(0);
    clock.advance(61_000);
    const second = await post("/auth/otp/resend", { challenge_id: first.challenge_id });
    expect(second.statusCode).toBe(200);
    expect(
      (await post("/auth/otp/verify", { challenge_id: first.challenge_id, code: oldCode })).statusCode,
    ).toBe(410);
    expect(
      (
        await post("/auth/otp/verify", {
          challenge_id: second.json().challenge_id,
          code: mailer.last(email)!,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("AC F01-4: registrasi ulang tidak membuat akun ganda dan challenge lama batal", async () => {
    const email = newEmail();
    const first = (await post("/auth/register", registerBody(email))).json();
    clock.advance(61_000);
    const second = (await post("/auth/register", registerBody(email, { password: "Lain#2026x" }))).json();
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
    expect(second.challenge_id).not.toBe(first.challenge_id);
    // Pemilik challenge pertama tidak bisa mengaktifkan akun dengan sandi yang sudah diganti (pre-account hijacking).
    expect(
      (await post("/auth/otp/verify", { challenge_id: first.challenge_id, code: "123456" })).statusCode,
    ).toBe(410);
  });

  it("email yang sudah aktif ditolak dengan 409", async () => {
    const { email } = await registerAndVerify();
    const res = await post("/auth/register", registerBody(email));
    expect(res.statusCode).toBe(409);
  });
});

describe("F-02 login, refresh, dan sesi", () => {
  it("login akun pending_otp diarahkan ke verifikasi tanpa token", async () => {
    const email = newEmail();
    await post("/auth/register", registerBody(email));
    const res = await post("/auth/login", { email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("verify_otp");
    expect(res.json().session).toBeUndefined();
  });

  it("AC F02-1: login valid menerbitkan access token 15 menit", async () => {
    const { email } = await registerAndVerify();
    const res = await post("/auth/login", { email: email.toUpperCase(), password: PASSWORD });
    expect(res.json().next).toBe("home");
    const s = res.json().session;
    const ttl = new Date(s.access_expires_at).getTime() - clock.now().getTime();
    // exp JWT dibulatkan ke detik
    expect(ttl).toBeGreaterThan(15 * 60_000 - 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    clock.advance(15 * 60_000 + 1000);
    expect((await get("/me", s.access_token)).statusCode).toBe(401);
  });

  it("sandi salah tidak membedakan email terdaftar atau tidak", async () => {
    const { email } = await registerAndVerify();
    const a = await post("/auth/login", { email, password: "Salah#2026" });
    const b = await post("/auth/login", { email: "tidakada@contoh.id", password: "Salah#2026" });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it("10 kegagalan login dalam 15 menit memicu cooldown", async () => {
    const { email } = await registerAndVerify();
    for (let i = 0; i < 10; i++) await post("/auth/login", { email, password: "Salah#2026" });
    const blocked = await post("/auth/login", { email, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    clock.advance(15 * 60_000 + 1000);
    expect((await post("/auth/login", { email, password: PASSWORD })).statusCode).toBe(200);
  });

  it("AC F02-3: refresh berotasi; refresh token lama dipakai ulang mencabut seluruh keluarga sesi", async () => {
    const { session } = await registerAndVerify();
    const r1 = await post("/auth/refresh", { refresh_token: session.refresh_token });
    expect(r1.statusCode).toBe(200);
    const newPair = r1.json();
    expect(newPair.refresh_token).not.toBe(session.refresh_token);
    const userId = (await get("/me", newPair.access_token)).json().user_id as string;

    const reuse = await post("/auth/refresh", { refresh_token: session.refresh_token });
    expect(reuse.statusCode).toBe(401);
    // F-17: pemakaian ulang tercatat sebagai kejadian keamanan (aktor anonim, entitas pemilik akun).
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "session.refresh_reuse_detected"), eq(auditLogs.entityId, userId)));
    expect(audit).toMatchObject({
      effectiveRole: "anonymous",
      actorUserId: null,
      after: { sessions_revoked: 1 },
    });
    // Token hasil rotasi ikut dicabut.
    expect((await post("/auth/refresh", { refresh_token: newPair.refresh_token })).statusCode).toBe(401);
    expect((await get("/me", newPair.access_token)).statusCode).toBe(401);
  });

  it("AC F02-6: keluar semua perangkat membuat access token lama ditolak", async () => {
    const { email, session } = await registerAndVerify();
    const other = (await post("/auth/login", { email, password: PASSWORD })).json().session;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout-all",
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(res.statusCode).toBe(204);
    expect((await get("/me", session.access_token)).statusCode).toBe(401);
    expect((await get("/me", other.access_token)).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refresh_token: other.refresh_token })).statusCode).toBe(401);
  });

  it("logout mencabut sesi saat ini", async () => {
    const { session } = await registerAndVerify();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect((await get("/me", session.access_token)).statusCode).toBe(401);
  });

  it("AC F02-6: keluar semua perangkat tercatat di audit dengan aktor pengguna", async () => {
    const { session } = await registerAndVerify();
    const res = await post("/auth/logout-all", {}, { authorization: `Bearer ${session.access_token}` });
    expect(res.statusCode).toBe(204);
    // request_id audit = request_id server pada header respons (korelasi N-14).
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "session.logout_all"),
          eq(auditLogs.requestId, String(res.headers["x-request-id"])),
        ),
      );
    expect(row?.effectiveRole).toBe("alumni");
    expect(row?.actorUserId).toBeTruthy();
    expect(row?.entityId).toBe(row?.actorUserId);
    expect(row?.createdAt.toISOString()).toBe(clock.now().toISOString());
  });

  it("PRD 2.5: sandi lebih dari 72 byte ditolak (tidak dipotong bcrypt)", async () => {
    const { email } = await registerAndVerify();
    // 72 byte pertama sama dengan sandi asli: bcrypt memotong, server harus menolak.
    const long = PASSWORD + "x".repeat(72 - Buffer.byteLength(PASSWORD)) + "LEBIH";
    const res = await post("/auth/login", { email, password: long });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Email atau password salah.");
  });

  it("PRD 2.2, F-14: akun deletion_pending tidak memperoleh sesi (next deletion_pending) dan token lamanya ditolak", async () => {
    const { email, session } = await registerAndVerify();
    await db.update(users).set({ status: "deletion_pending" }).where(eq(users.email, email));
    expect((await get("/me", session.access_token)).statusCode).toBe(401);
    const login = await post("/auth/login", { email, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().next).toBe("deletion_pending");
    expect(login.json().session).toBeUndefined();
    expect((await post("/auth/login", { email, password: "Salah#2026" })).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refresh_token: session.refresh_token })).statusCode).toBe(401);
  });

  it("PRD 2.2: akun disabled → next account_disabled tanpa sesi; sandi salah tetap 401", async () => {
    const { email, session } = await registerAndVerify();
    await db.update(users).set({ status: "disabled" }).where(eq(users.email, email));
    const login = await post("/auth/login", { email, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: "account_disabled" });
    expect((await post("/auth/login", { email, password: "Salah#2026" })).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refresh_token: session.refresh_token })).statusCode).toBe(401);
  });

  it("access token ditolak setelah sesi refresh kedaluwarsa (sessions.expires_at)", async () => {
    const { email, session } = await registerAndVerify();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    await db.update(sessions).set({ expiresAt: clock.now() }).where(eq(sessions.userId, user!.id));
    expect((await get("/me", session.access_token)).statusCode).toBe(401);
  });
});

describe("PRD 2.5: OTP atomik dan registrasi ulang", () => {
  it("percobaan OTP dicadangkan atomik: percobaan ke-6 tetap 410 dan attempts tidak melewati 5", async () => {
    const email = newEmail();
    const { challenge_id } = (await post("/auth/register", registerBody(email))).json();
    const wrong = mailer.last(email) === "000000" ? "111111" : "000000";
    const results = await Promise.all(
      Array.from({ length: 7 }, () => post("/auth/otp/verify", { challenge_id, code: wrong })),
    );
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(4);
    expect(results.filter((r) => r.statusCode === 410)).toHaveLength(3);
    const [row] = await db.select().from(otpCodes).where(eq(otpCodes.id, challenge_id));
    expect(row!.attempts).toBe(5);
  });

  it("registrasi ulang dengan sandi sama saat cooldown mengembalikan challenge yang sama tanpa email baru", async () => {
    const email = newEmail();
    const first = (await post("/auth/register", registerBody(email))).json();
    const sentBefore = mailer.sent.filter((m) => m.to === email).length;
    const again = await post("/auth/register", registerBody(email, { full_name: "Ahmad Islam Koreksi" }));
    expect(again.statusCode).toBe(201);
    expect(again.json().challenge_id).toBe(first.challenge_id);
    expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(sentBefore);
    // Koreksi profil tetap tersimpan.
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const [profile] = await db.select().from(alumni).where(eq(alumni.userId, user!.id));
    expect(profile!.fullName).toBe("Ahmad Islam Koreksi");
  });

  it("registrasi ulang dengan sandi berbeda sebelum cooldown 60 detik ditolak 429 tanpa mengubah sandi", async () => {
    const email = newEmail();
    const first = (await post("/auth/register", registerBody(email))).json();
    const res = await post("/auth/register", registerBody(email, { password: "Lain#2026x" }));
    expect(res.statusCode).toBe(429);
    expect(res.json().retry_after_seconds).toBeGreaterThan(0);
    // Challenge pertama tetap berlaku dengan sandi pertama.
    const ver = await post("/auth/otp/verify", {
      challenge_id: first.challenge_id,
      code: mailer.last(email)!,
    });
    expect(ver.statusCode).toBe(200);
    expect((await post("/auth/login", { email, password: PASSWORD })).statusCode).toBe(200);
  });

  it("PRD 4.3: Idempotency-Key yang sama memutar ulang hasil registrasi; payload berbeda 409 IDEMPOTENCY_CONFLICT", async () => {
    const email = newEmail();
    const key = uuidv7();
    const first = await post("/auth/register", registerBody(email), { "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    const replay = await post("/auth/register", registerBody(email), { "idempotency-key": key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());
    expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(1);
    const conflict = await post("/auth/register", registerBody(email, { cohort: 20 }), {
      "idempotency-key": key,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const invalid = await post("/auth/register", registerBody(newEmail()), {
      "idempotency-key": "bukan-uuid",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().field_errors["Idempotency-Key"]).toBeDefined();
  });

  it("PRD 2.1: angkatan terbaru mengikuti tahun Asia/Jakarta", async () => {
    const original = clock.now();
    // 31 Desember 18:00 UTC = 1 Januari 01:00 WIB: angkatan 2027 - 1996 = 31 sudah boleh.
    clock.set(new Date("2026-12-31T18:00:00Z"));
    try {
      const res = await post("/auth/register", registerBody(newEmail(), { cohort: 31 }));
      expect(res.statusCode).toBe(201);
    } finally {
      clock.set(original);
    }
  });
});

describe("F-02 admin dengan TOTP", () => {
  let admin: AdminFixture;

  beforeAll(async () => {
    admin = await createAdmin({ db, clock }, { role: "super_admin", displayName: "Bayu Musthafa" });
  });

  /** Login dua tahap memakai langkah TOTP baru setiap kali (server menolak replay langkah yang sama). */
  async function adminSession() {
    const login = (await post("/admin/auth/login", { email: admin.email, password: admin.password })).json();
    let step = Math.floor(clock.now().getTime() / 30_000);
    if (admin.lastTotpStep !== undefined && step <= admin.lastTotpStep) {
      clock.advance((admin.lastTotpStep - step + 1) * 30_000);
      step = Math.floor(clock.now().getTime() / 30_000);
    }
    const res = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      totp_code: totp(admin.totpSecret, clock.now()),
    });
    expect(res.statusCode).toBe(200);
    admin.lastTotpStep = step;
    return { body: res.json(), cookie: String(res.headers["set-cookie"] ?? "") };
  }

  it("AC F02-2: token tahap sandi tidak bisa memanggil API admin", async () => {
    const login = await post("/admin/auth/login", { email: admin.email, password: admin.password });
    expect(login.statusCode).toBe(200);
    const res = await get("/admin/me", login.json().mfa_token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("MFA_REQUIRED");
  });

  it("akun admin tidak bisa masuk lewat login alumni, dan sebaliknya", async () => {
    expect((await post("/auth/login", { email: admin.email, password: admin.password })).statusCode).toBe(
      401,
    );
    const { email } = await registerAndVerify();
    expect((await post("/admin/auth/login", { email, password: PASSWORD })).statusCode).toBe(401);
  });

  it("TOTP benar menerbitkan sesi admin, cookie HttpOnly, dan izin efektif", async () => {
    const { body, cookie } = await adminSession();
    expect(body.idle_timeout_seconds).toBe(1800);
    expect(cookie).toContain("kapdh_admin_rt=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const me = await get("/admin/me", body.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe("super_admin");
    expect(me.json().permissions).toContain("payments.decide");
  });

  it("AC F02-2: TOTP salah = 400 dengan sisa percobaan (mfa_token tetap berlaku); 5 kegagalan → 429", async () => {
    const fixture = await createAdmin({ db, clock });
    const login = (
      await post("/admin/auth/login", { email: fixture.email, password: fixture.password })
    ).json();
    const wrong = totp(fixture.totpSecret, new Date(clock.now().getTime() + 10 * 60_000));
    for (let left = 4; left >= 0; left--) {
      const res = await post("/admin/auth/mfa", { mfa_token: login.mfa_token, totp_code: wrong });
      expect(res.statusCode).toBe(400);
      expectOperation("post", "/admin/auth/mfa", res);
      expect(res.json().code).toBe("VALIDATION_ERROR");
      expect(res.json().field_errors.totp_code).toHaveLength(1);
      if (left > 0) expect(res.json().message).toBe(`Kode salah. Sisa percobaan ${left}.`);
    }
    const limited = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      totp_code: totp(fixture.totpSecret, clock.now()),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().retry_after_seconds).toBeGreaterThan(0);
  });

  it("kontrak AdminMfaRequest: tepat satu kode; tanpa kode atau keduanya → 400; mfa_token rusak → 401", async () => {
    const login = (await post("/admin/auth/login", { email: admin.email, password: admin.password })).json();
    expect((await post("/admin/auth/mfa", { mfa_token: login.mfa_token })).statusCode).toBe(400);
    const both = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      totp_code: "123456",
      backup_code: "ABCD-EFGH",
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().field_errors.totp_code).toBeDefined();
    const broken = await post("/admin/auth/mfa", { mfa_token: "x".repeat(40), totp_code: "123456" });
    expect(broken.statusCode).toBe(401);
    expect(broken.json().code).toBe("UNAUTHENTICATED");
  });

  it("kontrak adminLogin: admin invited, disabled, atau tanpa TOTP terverifikasi → 401 sama dengan sandi salah", async () => {
    const wrongPassword = await post("/admin/auth/login", { email: admin.email, password: "Salah#2026x" });
    const invited = await createAdmin({ db, clock }, { status: "invited" });
    const disabled = await createAdmin({ db, clock }, { status: "disabled" });
    const unenrolled = await createAdmin({ db, clock });
    await db.update(mfaTotp).set({ verifiedAt: null }).where(eq(mfaTotp.userId, unenrolled.userId));
    for (const fixture of [invited, disabled, unenrolled]) {
      const res = await post("/admin/auth/login", { email: fixture.email, password: fixture.password });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe(wrongPassword.json().message);
    }
    // Sandi benar pada admin yang belum aktif dihitung sebagai kegagalan (tidak dapat dibedakan lewat rate limit).
    for (let i = 0; i < 9; i++)
      await post("/admin/auth/login", { email: unenrolled.email, password: unenrolled.password });
    expect(
      (await post("/admin/auth/login", { email: unenrolled.email, password: unenrolled.password }))
        .statusCode,
    ).toBe(429);
    clock.advance(15 * 60_000 + 1000);
  });

  it("RFC 6238 §5.2: kode TOTP yang sama tidak dapat diputar ulang untuk sesi kedua", async () => {
    await adminSession();
    const login = (await post("/admin/auth/login", { email: admin.email, password: admin.password })).json();
    const replay = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      totp_code: totp(admin.totpSecret, clock.now()),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().field_errors.totp_code).toBeDefined();
  });

  it("F-02: backup code hanya berlaku sekali, termasuk pada permintaan bersamaan", async () => {
    const fixture = await createAdmin({ db, clock });
    const code = newBackupCode();
    await db
      .update(mfaTotp)
      .set({ backupCodeHashes: [backupCodeHash(testEnv.OTP_HMAC_SECRET, code)] })
      .where(eq(mfaTotp.userId, fixture.userId));
    const tokens = await Promise.all(
      [1, 2].map(
        async () =>
          (await post("/admin/auth/login", { email: fixture.email, password: fixture.password })).json()
            .mfa_token as string,
      ),
    );
    const results = await Promise.all(
      tokens.map((mfa_token) => post("/admin/auth/mfa", { mfa_token, backup_code: code.toLowerCase() })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.statusCode === 400)!.json().field_errors.backup_code).toBeDefined();
    const [row] = await db.select().from(mfaTotp).where(eq(mfaTotp.userId, fixture.userId));
    expect(row!.backupCodeHashes).toEqual([]);
  });

  it("F-16: GET /admin/me memuat email, akun tertaut, sisa backup code dan login sebelumnya", async () => {
    const fixture = await createAdmin({ db, clock }, { displayName: "Admin Profil" });
    const first = await signInAdmin({ app, clock }, fixture);
    const firstMe = await get("/admin/me", first.accessToken);
    expect(firstMe.statusCode).toBe(200);
    expectOperation("get", "/admin/me", firstMe);
    expect(firstMe.json()).toMatchObject({
      email: fixture.email,
      has_linked_alumni: false,
      previous_login_at: null,
    });
    expect(firstMe.json().backup_codes_remaining).toBeGreaterThanOrEqual(0);
    const firstLoginAt = clock.now().toISOString();
    clock.advance(60_000);
    const second = await signInAdmin({ app, clock }, fixture);
    const secondMe = await get("/admin/me", second.accessToken);
    expect(secondMe.json().previous_login_at).toBe(firstLoginAt);
  });

  it("token admin tidak bisa memanggil endpoint anggota", async () => {
    const { body } = await adminSession();
    expect((await get("/me", body.access_token)).statusCode).toBe(403);
  });

  it("AC F02-5: sesi admin berakhir setelah idle 30 menit; polling latar tidak memperpanjang", async () => {
    const { body } = await adminSession();
    clock.advance(20 * 60_000);
    // Permintaan latar tidak dihitung aktivitas.
    expect((await get("/admin/me", body.access_token, { "x-background-request": "1" })).statusCode).toBe(401);
    // Access token 15 menit sudah habis pada titik ini; uji idle memakai token baru.
    const fresh = await adminSession();
    clock.advance(10 * 60_000);
    expect(
      (await get("/admin/me", fresh.body.access_token, { "x-background-request": "1" })).statusCode,
    ).toBe(200);
    clock.advance(4 * 60_000);
    expect(
      (await get("/admin/me", fresh.body.access_token, { "x-background-request": "1" })).statusCode,
    ).toBe(200);
    clock.advance(17 * 60_000);
    const res = await get("/admin/me", fresh.body.access_token);
    expect(res.statusCode).toBe(401);
  });

  it("refresh admin lewat cookie wajib Origin web admin", async () => {
    const { cookie } = await adminSession();
    const token = /kapdh_admin_rt=([^;]+)/.exec(cookie)![1]!;
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: token },
      headers: { origin: "https://evil.example" },
    });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: token },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().refresh_token).toBeUndefined();
    expect(String(ok.headers["set-cookie"])).toContain("kapdh_admin_rt=");
  });

  it("AC F16-3: admin yang dinonaktifkan tidak bisa refresh walau cookie masih berlaku", async () => {
    const fixture = await createAdmin({ db, clock });
    const session = await signInAdmin({ app, clock }, fixture);
    await db
      .update(admins)
      .set({ status: "disabled", disabledAt: clock.now() })
      .where(eq(admins.id, fixture.adminId));
    expect((await get("/admin/me", session.accessToken)).statusCode).toBe(403);
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: session.refreshCookie },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(refreshed.statusCode).toBe(401);
  });
});

describe("Kesesuaian kontrak final C1: persetujuan, slot aktivasi, dan pencabutan token push", () => {
  it("F-01: accept_policy_version wajib berpola dan sama dengan versi terbit terkini; usang → 409 dengan current", async () => {
    const malformed = await post(
      "/auth/register",
      registerBody(newEmail(), { accept_policy_version: "2026-10" }),
    );
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().field_errors.accept_policy_version).toBeDefined();

    const stale = await post(
      "/auth/register",
      registerBody(newEmail(), { accept_policy_version: "privacy:1;terms:2" }),
    );
    expect(stale.statusCode).toBe(409);
    expectOperation("post", "/auth/register", stale);
    expect(stale.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { policy_version: TEST_CONSENT_VERSION, privacy_version: "1", terms_version: "1" },
    });

    // Versi usang mendahului pemeriksaan email (kontrak register): email terdaftar tetap mendapat 409 versi.
    const { email } = await registerAndVerify();
    const staleTaken = await post(
      "/auth/register",
      registerBody(email, { accept_policy_version: "privacy:9;terms:9" }),
    );
    expect(staleTaken.json().code).toBe("VERSION_CONFLICT");

    // Versi persetujuan yang tersimpan = versi terkini saat transaksi (users.policy_version).
    const fresh = newEmail();
    expect((await post("/auth/register", registerBody(fresh))).statusCode).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.email, fresh));
    expect(row!.policyVersion).toBe(TEST_CONSENT_VERSION);
    expect(row!.policyAcceptedAt?.toISOString()).toBe(clock.now().toISOString());
  });

  it("PRD 8.2: selama dokumen legal belum terbit pendaftaran ditolak 409 dengan policy_version null", async () => {
    await setSetting(t, "legal", { privacy_version: null, terms_version: "1", community_version: null });
    try {
      const closed = await post("/auth/register", registerBody(newEmail()));
      expect(closed.statusCode).toBe(409);
      expectOperation("post", "/auth/register", closed);
      expect(closed.json().current).toEqual({
        policy_version: null,
        privacy_version: null,
        terms_version: "1",
      });
    } finally {
      await publishLegalVersions(t);
    }
  });

  it("kontrak verifyOtp: challenge bertujuan lain (password_reset) → 410 tanpa memakai jatah percobaannya", async () => {
    const { email } = await registerAndVerify();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const id = uuidv7();
    await db.insert(otpCodes).values({
      id,
      userId: user!.id,
      purpose: "password_reset",
      codeHmac: "0".repeat(64),
      expiresAt: new Date(clock.now().getTime() + 10 * 60_000),
      resendAvailableAt: clock.now(),
      createdAt: clock.now(),
    });
    const res = await post("/auth/otp/verify", { challenge_id: id, code: "123456" });
    expect(res.statusCode).toBe(410);
    expectOperation("post", "/auth/otp/verify", res);
    const [row] = await db.select().from(otpCodes).where(eq(otpCodes.id, id));
    expect(row!.attempts).toBe(0);
    expect(row!.consumedAt).toBeNull();
  });

  it("kontrak resendOtp: challenge signup milik akun yang sudah aktif → 410 (tanpa email baru)", async () => {
    const email = newEmail();
    const reg = (await post("/auth/register", registerBody(email))).json();
    // Akun diaktifkan lewat jalur lain sementara challenge pertama belum dikonsumsi.
    await db.update(users).set({ status: "active" }).where(eq(users.email, email));
    clock.advance(61_000);
    const sent = mailer.sent.filter((m) => m.to === email).length;
    const res = await post("/auth/otp/resend", { challenge_id: reg.challenge_id });
    expect(res.statusCode).toBe(410);
    expectOperation("post", "/auth/otp/resend", res);
    expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(sent);
  });

  it("kontrak login pending_otp: challenge aktivasi aktif dipakai ulang; kedaluwarsa → satu challenge baru", async () => {
    const email = newEmail();
    const reg = (await post("/auth/register", registerBody(email))).json();
    const again = await post("/auth/login", { email, password: PASSWORD });
    expect(again.json()).toMatchObject({ next: "verify_otp", challenge: { challenge_id: reg.challenge_id } });
    expect(again.json().challenge.max_attempts).toBe(5);
    clock.advance(10 * 60_000 + 1000);
    const renewed = await post("/auth/login", { email, password: PASSWORD });
    expectOperation("post", "/auth/login", renewed);
    expect(renewed.json().challenge.challenge_id).not.toBe(reg.challenge_id);
    expect(renewed.json().challenge.purpose).toBe("signup");
    const active = await db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.userId, (await db.select().from(users).where(eq(users.email, email)))[0]!.id)));
    expect(active.filter((r) => !r.supersededAt && !r.consumedAt)).toHaveLength(1);
  });

  /** Token push + notifikasi + pengiriman push pending untuk sesi tertentu (data sintetis). */
  async function pushFixture(userId: string, sessionId: string) {
    const now = clock.now();
    const tokenId = uuidv7();
    const notificationId = uuidv7();
    const deliveryId = uuidv7();
    await db.insert(deviceTokens).values({
      id: tokenId,
      userId,
      sessionId,
      platform: "android",
      token: `fcm-uji-${tokenId}`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(notifications).values({
      id: notificationId,
      userId,
      category: "payment",
      title: "Uji",
      dedupKey: `u:${userId}:uji-${notificationId}`,
      createdAt: now,
    });
    await db.insert(notificationDeliveries).values({
      id: deliveryId,
      notificationId,
      channel: "push",
      deviceTokenId: tokenId,
      createdAt: now,
      updatedAt: now,
    });
    return { tokenId, deliveryId };
  }

  async function sessionIdOf(accessToken: string): Promise<string> {
    const [, payload] = accessToken.split(".");
    return String(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")).sid);
  }

  it("AC F13-5: rotasi refresh memindahkan ikatan token push; logout mencabut keluarga + token, push pending batal", async () => {
    const { session } = await registerAndVerify();
    const userId = (await get("/me", session.access_token)).json().user_id as string;
    const firstSessionId = await sessionIdOf(session.access_token);
    const push = await pushFixture(userId, firstSessionId);

    const rotated = (await post("/auth/refresh", { refresh_token: session.refresh_token })).json();
    const secondSessionId = await sessionIdOf(rotated.access_token);
    const [moved] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, push.tokenId));
    expect(moved!.sessionId).toBe(secondSessionId);
    expect(moved!.revokedAt).toBeNull();

    // Perangkat lain milik akun yang sama tidak terpengaruh logout satu perangkat.
    const other = (
      await post("/auth/login", {
        email: (await get("/me", rotated.access_token)).json().email,
        password: PASSWORD,
      })
    ).json().session;
    const otherPush = await pushFixture(userId, await sessionIdOf(other.access_token));

    const out = await post("/auth/logout", {}, { authorization: `Bearer ${rotated.access_token}` });
    expect(out.statusCode).toBe(204);
    const family = await db.select().from(sessions).where(eq(sessions.userId, userId));
    const [first] = family.filter((row) => row.id === firstSessionId);
    expect(family.filter((row) => row.familyId === first!.familyId && !row.revokedAt)).toHaveLength(0);
    const [revoked] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, push.tokenId));
    expect(revoked!.revokedAt?.toISOString()).toBe(clock.now().toISOString());
    const [cancelled] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, push.deliveryId));
    expect(cancelled).toMatchObject({ status: "cancelled", errorClass: "token_revoked" });

    const [untouched] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, otherPush.tokenId));
    expect(untouched!.revokedAt).toBeNull();
    expect((await get("/me", other.access_token)).statusCode).toBe(200);

    // Keluar semua perangkat mencabut token tersisa dan membatalkan push pending-nya.
    expect(
      (await post("/auth/logout-all", {}, { authorization: `Bearer ${other.access_token}` })).statusCode,
    ).toBe(204);
    const [all] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, otherPush.tokenId));
    expect(all!.revokedAt).not.toBeNull();
    const [allDelivery] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, otherPush.deliveryId));
    expect(allDelivery).toMatchObject({ status: "cancelled", errorClass: "token_revoked" });
  });
});
