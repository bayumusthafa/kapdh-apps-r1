/**
 * Primitif identitas core (ARCHITECTURE §4.2 core/identity) di jalur PGlite: batas kegagalan atomik (PRD 2.5 / D1,
 * AC F02-2), anggaran registrasi sebelum bcrypt (PRD 5.1), rotasi refresh vs pencabutan biasa (AC F02-3, F02-5,
 * F-17), dan token sekali pakai turunan OTP (kontrak C1).
 */
import { auditLogs, sessions } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { totp } from "../../src/core/identity/crypto.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import { RateLimitService } from "../../src/core/rate-limit/rate-limit.service.js";
import {
  createAdmin,
  createAlumni,
  publishLegalVersions,
  signInAdmin,
  signInAlumni,
  TEST_CONSENT_VERSION,
} from "../support/factories.js";
import { createTestApp, type TestApp, testEnv } from "../support/test-app.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await publishLegalVersions(t);
});
afterAll(async () => {
  await t.app.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const post = (
  url: string,
  payload: object,
  remoteAddress = "203.0.113.7",
  headers: Record<string, string> = {},
) => t.app.inject({ method: "POST", url: `/api/v1${url}`, payload, remoteAddress, headers });

function tally(responses: { statusCode: number; json(): { code?: string } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const res of responses) {
    const key = `${res.statusCode}:${res.json().code ?? "ok"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("PasswordVerifier: jatah kegagalan dicadangkan atomik sebelum bcrypt (PRD 2.5 / D1, AC F02-2)", () => {
  it("40 login alumni paralel dengan sandi salah: tepat 10 dinilai, 30 ditolak 429 tanpa bcrypt", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const compare = vi.spyOn(bcrypt, "compare");
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        post("/auth/login", { email: member.email, password: `Salah#${i}x` }),
      ),
    );
    expect(tally(responses)).toEqual({ "401:UNAUTHENTICATED": 10, "429:RATE_LIMITED": 30 });
    expect(compare).toHaveBeenCalledTimes(10);
    const limited = responses.find((r) => r.statusCode === 429)!;
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("login berhasil tidak memakai anggaran IP (60 login sukses dari satu IP tetap 200)", async () => {
    const members = await Promise.all(
      Array.from({ length: 6 }, () => createAlumni(t, { status: "verified" })),
    );
    for (let round = 0; round < 10; round++)
      for (const member of members) {
        const res = await post(
          "/auth/login",
          { email: member.email, password: member.password },
          "203.0.113.8",
        );
        expect(res.statusCode, `putaran ${round}`).toBe(200);
      }
  });

  it("sandi benar mereset penghitung email; kegagalan sebelumnya tidak menumpuk", async () => {
    const member = await createAlumni(t, { status: "verified" });
    for (let i = 0; i < 9; i++)
      expect((await post("/auth/login", { email: member.email, password: "Salah#2026x" })).statusCode).toBe(
        401,
      );
    expect((await post("/auth/login", { email: member.email, password: member.password })).statusCode).toBe(
      200,
    );
    for (let i = 0; i < 9; i++)
      expect((await post("/auth/login", { email: member.email, password: "Salah#2026x" })).statusCode).toBe(
        401,
      );
    expect((await post("/auth/login", { email: member.email, password: member.password })).statusCode).toBe(
      200,
    );
  });

  it("kontrak adminVerifyMfa: 12 kode salah paralel dengan satu mfa_token → tepat 5 dinilai (400), 7 ditolak 429", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const login = await post("/admin/auth/login", { email: admin.email, password: admin.password });
    const accepted = new Set(
      [-30_000, 0, 30_000].map((offset) =>
        totp(admin.totpSecret, new Date(t.clock.now().getTime() + offset)),
      ),
    );
    const codes: string[] = [];
    for (let n = 0; codes.length < 12; n++) {
      const code = String(n).padStart(6, "0");
      if (!accepted.has(code)) codes.push(code);
    }
    const responses = await Promise.all(
      codes.map((code) => post("/admin/auth/mfa", { mfa_token: login.json().mfa_token, totp_code: code })),
    );
    expect(tally(responses)).toEqual({ "400:VALIDATION_ERROR": 5, "429:RATE_LIMITED": 7 });
  });

  it("kode TOTP benar mengembalikan jatah: kegagalan sebelumnya tetap dihitung, keberhasilan tidak", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const login = (await post("/admin/auth/login", { email: admin.email, password: admin.password })).json();
    const wrong = totp(admin.totpSecret, new Date(t.clock.now().getTime() + 10 * 60_000));
    for (const left of [4, 3])
      expect(
        (await post("/admin/auth/mfa", { mfa_token: login.mfa_token, totp_code: wrong })).json().message,
      ).toBe(`Kode salah. Sisa percobaan ${left}.`);
    const ok = await post("/admin/auth/mfa", {
      mfa_token: login.mfa_token,
      totp_code: totp(admin.totpSecret, t.clock.now()),
    });
    expect(ok.statusCode).toBe(200);
    // Keberhasilan tidak memakan jatah: kegagalan berikutnya adalah yang ketiga.
    const again = (await post("/admin/auth/login", { email: admin.email, password: admin.password })).json();
    expect(
      (await post("/admin/auth/mfa", { mfa_token: again.mfa_token, totp_code: wrong })).json().message,
    ).toBe("Kode salah. Sisa percobaan 2.");
  });

  it("verifikasi OTP: batas kegagalan per IP dicadangkan atomik (55 tebakan paralel → tepat 50 dinilai)", async () => {
    const members = await Promise.all(
      Array.from({ length: 11 }, () => createAlumni(t, { status: "pending_otp" })),
    );
    const challenges: string[] = [];
    for (const member of members) {
      const res = await post(
        "/auth/login",
        { email: member.email, password: member.password },
        "203.0.113.20",
      );
      expect(res.json().next).toBe("verify_otp");
      challenges.push(res.json().challenge.challenge_id as string);
    }
    // 5 tebakan salah per challenge (tidak pernah melewati 5 percobaan per challenge).
    const guesses = challenges.flatMap((challengeId) =>
      Array.from({ length: 5 }, () => ({ challengeId, code: "000000" })),
    );
    const codes = new Map(members.map((m, i) => [challenges[i]!, t.mailer.last(m.email)!]));
    const responses = await Promise.all(
      guesses.map(({ challengeId, code }) =>
        post(
          "/auth/otp/verify",
          { challenge_id: challengeId, code: codes.get(challengeId) === code ? "111111" : code },
          "203.0.113.20",
        ),
      ),
    );
    const counts = tally(responses);
    expect(counts["429:RATE_LIMITED"]).toBe(5);
    expect((counts["400:VALIDATION_ERROR"] ?? 0) + (counts["410:OTP_EXPIRED"] ?? 0)).toBe(50);
  });
});

describe("Anggaran registrasi per IP dicadangkan sebelum bcrypt (PRD 2.5, 5.1)", () => {
  it("anggaran habis → 429 tanpa hash/compare bcrypt dan tanpa akun baru", async () => {
    const limits = t.app.get(RateLimitService);
    // Mengisi anggaran 120/jam IP ini sampai habis (setara 120 percobaan registrasi sebelumnya).
    for (let i = 0; i < 120; i++) await limits.consume("register-ip:203.0.113.30", 120, 3600_000);
    const hash = vi.spyOn(bcrypt, "hash");
    const compare = vi.spyOn(bcrypt, "compare");
    const res = await post(
      "/auth/register",
      {
        full_name: "Alumni Anggaran",
        gender: "female",
        email: `anggaran-${Date.now()}@contoh.test`,
        password: "Kapdh#2026",
        cohort: 20,
        class_in: 1,
        class_out: 6,
        accept_policy_version: TEST_CONSENT_VERSION,
      },
      "203.0.113.30",
    );
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.",
    });
    expect(hash).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });
});

describe("Rotasi refresh vs pencabutan biasa (AC F02-3, F02-5, F-17)", () => {
  async function reuseAudits(userId: string) {
    return t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "session.refresh_reuse_detected"), eq(auditLogs.entityId, userId)));
  }

  it("AC F02-5: refresh kedua setelah idle admin (tab lain/ulangan) → 401 tanpa kejadian keamanan; keluarga dicabut", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    t.clock.advance(31 * 60_000);
    const refresh = () =>
      t.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: { kapdh_admin_rt: session.refreshCookie },
        headers: { origin: testEnv.ADMIN_ORIGIN },
      });
    expect((await refresh()).statusCode).toBe(401);
    expect((await refresh()).statusCode).toBe(401);
    expect(await reuseAudits(admin.userId)).toHaveLength(0);
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, admin.userId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("AC F02-5: idle terdeteksi AuthGuard mencabut seluruh keluarga sesi admin", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    // Refresh bukan aktivitas (AC F02-5): last_activity_at baris baru tetap waktu masuk.
    t.clock.advance(20 * 60_000);
    const rotated = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { kapdh_admin_rt: session.refreshCookie },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(rotated.statusCode).toBe(200);
    // Access token baru masih berlaku (15 menit) tetapi idle sudah 31 menit.
    t.clock.advance(11 * 60_000);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/admin/me",
      headers: { authorization: `Bearer ${rotated.json().access_token}` },
    });
    expect(res.statusCode).toBe(401);
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, admin.userId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(await reuseAudits(admin.userId)).toHaveLength(0);
  });

  it("refresh token yang dicabut logout (bukan rotasi) → 401 tanpa kejadian keamanan", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const logout = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(logout.statusCode).toBe(204);
    expect((await post("/auth/refresh", { refresh_token: session.refreshToken })).statusCode).toBe(401);
    expect(await reuseAudits(member.userId)).toHaveLength(0);
  });

  it("AC F02-3: token yang SUDAH DIROTASI dipakai lagi tetap mencabut keluarga dan diaudit", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const first = await post("/auth/refresh", { refresh_token: session.refreshToken });
    expect(first.statusCode).toBe(200);
    expect((await post("/auth/refresh", { refresh_token: session.refreshToken })).statusCode).toBe(401);
    expect(await reuseAudits(member.userId)).toHaveLength(1);
    expect((await post("/auth/refresh", { refresh_token: first.json().refresh_token })).statusCode).toBe(401);
  });
});

describe("TokenService: token sekali pakai turunan OTP (kontrak C1 auth.yaml, account.yaml)", () => {
  it("audience terpisah, cid + pengikat, 10 menit, klaim inti tidak dapat ditimpa", async () => {
    const tokens = t.app.get(TokenService);
    const signed = await tokens.signOneTime("web_deletion", {
      userId: "0199a1b2-0000-7000-8000-000000000001",
      challengeId: "0199a1b2-0000-7000-8000-000000000002",
      bindings: { sv: 3, st: "active" },
    });
    const claims = await tokens.verifyOneTime(signed.token, "web_deletion");
    expect(claims).toMatchObject({
      userId: "0199a1b2-0000-7000-8000-000000000001",
      challengeId: "0199a1b2-0000-7000-8000-000000000002",
      bindings: { sv: 3, st: "active" },
    });
    expect(decodeJwt(signed.token).aud).toBe("kapdh-web-deletion");
    // Audience lain, access token, dan token kedaluwarsa ditolak.
    expect(await tokens.verifyOneTime(signed.token, "password_reset")).toBeNull();
    expect(await tokens.verifyAccess(signed.token)).toBeNull();
    expect(await tokens.verifyReauth(signed.token)).toBeNull();
    t.clock.advance(10 * 60_000 + 1000);
    expect(await tokens.verifyOneTime(signed.token, "web_deletion")).toBeNull();
    expect(() =>
      tokens.signOneTime("password_reset", { userId: "u", challengeId: "c", bindings: { sub: "lain" } }),
    ).toThrow(/klaim pengikat sub/);
  });
});
