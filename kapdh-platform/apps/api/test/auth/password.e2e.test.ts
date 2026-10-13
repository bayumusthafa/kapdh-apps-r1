/**
 * Pemulihan dan penggantian sandi alumni (F-02, AC F02-4; PRD 2.5 non-enumerasi; kontrak forgotPassword,
 * verifyPasswordResetOtp, resetPassword, changePassword, resendOtp, getOtpChallengeStatus).
 */
import {
  auditLogs,
  deviceTokens,
  notifications,
  otpCodes,
  otpDecoys,
  outboxEvents,
  sessions,
  users,
} from "@kapdh/database";
import { and, eq, isNull } from "drizzle-orm";
import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { maskEmail } from "../../src/core/identity/email.js";
import { PasswordVerifier } from "../../src/core/identity/password-verifier.js";
import { expectOperation } from "../support/contract.js";
import {
  type AlumniFixture,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
  uniqueEmail,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
let api: ReturnType<typeof httpClient>;

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
});
afterAll(async () => {
  await t.app.close();
});

const NEW_PASSWORD = "Baru#Kapdh2026";
const sentTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

async function forgot(email: string) {
  const res = await api.post("/auth/password/forgot", { email });
  expect(res.statusCode, res.body).toBe(202);
  expectOperation("post", "/auth/password/forgot", res);
  return res.json() as {
    challenge_id: string;
    purpose: string;
    email_masked: string;
    expires_at: string;
    resend_available_at: string;
    attempts_left: number;
    max_attempts: number;
  };
}

/** Lupa sandi → kode dari email → reset_token. */
async function resetGrant(member: Pick<AlumniFixture, "email">) {
  const challenge = await forgot(member.email);
  const code = t.mailer.last(member.email)!;
  const res = await api.post("/auth/password/forgot/verify", { challenge_id: challenge.challenge_id, code });
  expect(res.statusCode, res.body).toBe(200);
  expectOperation("post", "/auth/password/forgot/verify", res);
  return { challenge, grant: res.json() as { reset_token: string; expires_at: string } };
}

const wrongCode = (right: string) => (right === "000000" ? "111111" : "000000");

describe("AC F02-4: pemulihan sandi dengan OTP", () => {
  it("AC F02-4: OTP pemulihan valid → sandi baru tersimpan, seluruh sesi dicabut, OTP dikonsumsi", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const phone = await signInAlumni(t, member);
    const tablet = await signInAlumni(t, member);
    const [before] = await t.db.select().from(users).where(eq(users.id, member.userId));

    const { challenge, grant } = await resetGrant(member);
    expect(challenge.purpose).toBe("password_reset");
    expect(sentTo(member.email).at(-1)!.purpose).toBe("password_reset");
    // reset_token: audience khusus, 10 menit, terikat akun + challenge; pengikat bukan hash sandi.
    const claims = decodeJwt(grant.reset_token);
    expect(claims).toMatchObject({
      aud: "kapdh-password-reset",
      sub: member.userId,
      cid: challenge.challenge_id,
    });
    expect(claims.exp! - claims.iat!).toBe(600);
    expect(JSON.stringify(claims)).not.toContain(before!.passwordHash);
    const [consumed] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challenge.challenge_id));
    expect(consumed!.consumedAt).not.toBeNull();

    const reset = await api.post("/auth/password/reset", {
      reset_token: grant.reset_token,
      new_password: NEW_PASSWORD,
    });
    expect(reset.statusCode, reset.body).toBe(204);
    expectOperation("post", "/auth/password/reset", reset);

    // Seluruh sesi dicabut: access token dan refresh token lama tidak berlaku (session_version naik).
    for (const session of [phone, tablet]) {
      expect((await api.get("/me", { token: session.accessToken })).statusCode).toBe(401);
      expect((await api.post("/auth/refresh", { refresh_token: session.refreshToken })).statusCode).toBe(401);
    }
    const [after] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(after!.sessionVersion).toBe(before!.sessionVersion + 1);
    expect(after!.passwordHash).not.toBe(before!.passwordHash);
    const live = await t.db.select().from(sessions).where(eq(sessions.userId, member.userId));
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
    // Pencabutan karena reset bukan pemakaian ulang refresh token.
    const reuse = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "session.refresh_reuse_detected"), eq(auditLogs.entityId, member.userId)),
      );
    expect(reuse).toHaveLength(0);

    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(401);
    const login = await api.post("/auth/login", { email: member.email, password: NEW_PASSWORD });
    expect(login.json().next).toBe("home");

    // Notifikasi keamanan wajib (kategori security) lewat inbox + outbox, tanpa rahasia.
    const [notice] = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(notice).toMatchObject({
      category: "security",
      title: "Sandi akun dipulihkan",
      data: { event: "password_reset", route: "/account/sessions" },
    });
    expect(notice!.body).toContain("WIB");
    expect(JSON.stringify(notice)).not.toContain(grant.reset_token);
    const outbox = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.topic, "notification.created"));
    expect(
      outbox.some((row) => (row.payload as { notification_id: string }).notification_id === notice!.id),
    ).toBe(true);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "account.password_reset"), eq(auditLogs.entityId, member.userId)));
    expect(audit).toMatchObject({ effectiveRole: "alumni", actorUserId: member.userId });
    expect(audit!.after).toMatchObject({ sessions_revoked: 2 });
    expect(JSON.stringify(audit)).not.toContain(grant.reset_token);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it("AC F02-4: reset_token sekali pakai; kode yang sudah dikonsumsi tidak dapat ditukar lagi", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { challenge, grant } = await resetGrant(member);
    const code = t.mailer.last(member.email)!;
    expect(
      (await api.post("/auth/password/reset", { reset_token: grant.reset_token, new_password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(204);
    const again = await api.post("/auth/password/reset", {
      reset_token: grant.reset_token,
      new_password: "Lain#Kapdh2026",
    });
    expect(again.statusCode).toBe(410);
    expect(again.json().code).toBe("OTP_EXPIRED");
    expectOperation("post", "/auth/password/reset", again);
    const reverify = await api.post("/auth/password/forgot/verify", {
      challenge_id: challenge.challenge_id,
      code,
    });
    expect(reverify.statusCode).toBe(410);
    expectOperation("post", "/auth/password/forgot/verify", reverify);
    // Sandi kedua tidak pernah tersimpan.
    expect((await api.post("/auth/login", { email: member.email, password: NEW_PASSWORD })).json().next).toBe(
      "home",
    );
  });

  it("reset_token kedaluwarsa (10 menit), dirusak, atau audience lain → 410", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { grant } = await resetGrant(member);
    const [header, payload, signature] = grant.reset_token.split(".");
    const tampered = `${header}.${payload}.${signature!.slice(0, -2)}xx`;
    expect(
      (await api.post("/auth/password/reset", { reset_token: tampered, new_password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(410);
    const access = (await signInAlumni(t, member)).accessToken;
    expect(
      (await api.post("/auth/password/reset", { reset_token: access, new_password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(410);
    t.clock.advance(10 * 60_000 + 1000);
    const expired = await api.post("/auth/password/reset", {
      reset_token: grant.reset_token,
      new_password: NEW_PASSWORD,
    });
    expect(expired.statusCode).toBe(410);
    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(200);
  });

  it("reset_token batal bila sandi sudah diganti lewat jalur lain lebih dahulu (pengikat password_hash)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { grant } = await resetGrant(member);
    const session = await signInAlumni(t, member);
    const changed = await api.post(
      "/auth/password/change",
      { current_password: member.password, new_password: "Ganti#Kapdh2026" },
      { token: session.accessToken },
    );
    expect(changed.statusCode, changed.body).toBe(204);
    const res = await api.post("/auth/password/reset", {
      reset_token: grant.reset_token,
      new_password: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(410);
    expect(
      (await api.post("/auth/login", { email: member.email, password: "Ganti#Kapdh2026" })).statusCode,
    ).toBe(200);
  });

  it("PRD 2.5: sandi baru di luar aturan (termasuk > 72 byte) → 400 field_errors.new_password, token tetap berlaku", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { grant } = await resetGrant(member);
    for (const weak of ["pendek", "tanpasimbol2026A", `Kapdh#2026${"é".repeat(32)}`]) {
      const res = await api.post("/auth/password/reset", {
        reset_token: grant.reset_token,
        new_password: weak,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.new_password).toBeDefined();
    }
    expect(
      (await api.post("/auth/password/reset", { reset_token: grant.reset_token, new_password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(204);
  });

  it("PRD 2.5: kode salah → 400 dengan sisa percobaan; kelima salah → 410; kode benar sesudahnya tetap 410", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const challenge = await forgot(member.email);
    const right = t.mailer.last(member.email)!;
    for (let left = 4; left >= 1; left--) {
      const res = await api.post("/auth/password/forgot/verify", {
        challenge_id: challenge.challenge_id,
        code: wrongCode(right),
      });
      expect(res.statusCode).toBe(400);
      expectOperation("post", "/auth/password/forgot/verify", res);
      expect(res.json().field_errors.code).toEqual([`Kode salah. Sisa percobaan ${left}.`]);
    }
    expect(
      (
        await api.post("/auth/password/forgot/verify", {
          challenge_id: challenge.challenge_id,
          code: wrongCode(right),
        })
      ).statusCode,
    ).toBe(410);
    const late = await api.post("/auth/password/forgot/verify", {
      challenge_id: challenge.challenge_id,
      code: right,
    });
    expect(late.statusCode).toBe(410);
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challenge.challenge_id));
    expect(row).toMatchObject({ attempts: 5, consumedAt: null });
  });

  it("kontrak verifyPasswordResetOtp: challenge signup tidak dapat ditukar menjadi reset_token (410 tanpa percobaan)", async () => {
    const member = await createAlumni(t, { status: "pending_otp" });
    const login = await api.post("/auth/login", { email: member.email, password: member.password });
    const challengeId = login.json().challenge.challenge_id as string;
    const res = await api.post("/auth/password/forgot/verify", {
      challenge_id: challengeId,
      code: t.mailer.last(member.email)!,
    });
    expect(res.statusCode).toBe(410);
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challengeId));
    expect(row).toMatchObject({ attempts: 0, consumedAt: null });
  });

  it("PRD 2.5: cooldown kegagalan login tidak menutup pemulihan, dan reset membuka cooldown itu", async () => {
    const member = await createAlumni(t, { status: "verified" });
    for (let i = 0; i < 10; i++)
      await api.post("/auth/login", { email: member.email, password: "Salah#2026x" });
    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(429);
    const { grant } = await resetGrant(member);
    expect(
      (await api.post("/auth/password/reset", { reset_token: grant.reset_token, new_password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(204);
    expect((await api.post("/auth/login", { email: member.email, password: NEW_PASSWORD })).statusCode).toBe(
      200,
    );
  });

  it("PRD 2.2: anggota suspended (akun active) tetap dapat memulihkan sandi", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const { grant } = await resetGrant(member);
    expect(
      (await api.post("/auth/password/reset", { reset_token: grant.reset_token, new_password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(204);
  });

  it("akun yang dinonaktifkan setelah OTP diverifikasi tidak dapat menyimpan sandi baru (410)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { grant } = await resetGrant(member);
    await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, member.userId));
    const res = await api.post("/auth/password/reset", {
      reset_token: grant.reset_token,
      new_password: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(410);
  });
});

describe("PRD 2.5: lupa sandi tidak mengungkap apakah email terdaftar", () => {
  /** Bentuk challenge yang harus identik untuk email apa pun (nilai id berbeda). */
  function shape(challenge: Awaited<ReturnType<typeof forgot>>, typed: string) {
    expect(challenge).toEqual({
      challenge_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      purpose: "password_reset",
      email_masked: maskEmail(typed.toLowerCase()),
      expires_at: new Date(t.clock.now().getTime() + 10 * 60_000).toISOString(),
      resend_available_at: new Date(t.clock.now().getTime() + 60_000).toISOString(),
      attempts_left: 5,
      max_attempts: 5,
    });
  }

  it("email tidak terdaftar, pending_otp, disabled, deletion_pending dan admin → 202 berbentuk sama tanpa email", async () => {
    const active = await createAlumni(t, { status: "verified" });
    const pending = await createAlumni(t, { status: "pending_otp" });
    const disabled = await createAlumni(t, { status: "verified", accountStatus: "disabled" });
    const deleting = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
    const admin = await createAdmin(t, { role: "admin" });
    const unknown = uniqueEmail("tidak-terdaftar");

    shape(await forgot(active.email), active.email);
    expect(sentTo(active.email)).toHaveLength(1);
    for (const email of [unknown, pending.email, disabled.email, deleting.email, admin.email]) {
      const sentBefore = sentTo(email).length;
      shape(await forgot(email.toUpperCase()), email);
      expect(sentTo(email)).toHaveLength(sentBefore);
    }
    // Tidak ada challenge nyata untuk akun yang tidak memenuhi syarat; challenge pengganti tanpa email mentah.
    for (const fixture of [pending, disabled, deleting]) {
      const rows = await t.db
        .select()
        .from(otpCodes)
        .where(and(eq(otpCodes.userId, fixture.userId), eq(otpCodes.purpose, "password_reset")));
      expect(rows).toHaveLength(0);
    }
    const decoys = await t.db.select().from(otpDecoys);
    expect(JSON.stringify(decoys)).not.toContain(unknown);
  });

  it("challenge pengganti: status, cooldown kirim ulang, penggantian dan percobaan sama dengan challenge nyata", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const unknown = uniqueEmail("hantu");
    const real = await forgot(member.email);
    const decoy = await forgot(unknown);
    const pairs = [real, decoy];

    // Status awal identik bentuknya.
    for (const c of pairs) {
      const status = await api.post("/auth/otp/status", { challenge_id: c.challenge_id });
      expect(status.statusCode).toBe(200);
      expectOperation("post", "/auth/otp/status", status);
      expect(status.json()).toEqual(c);
    }
    // Kirim ulang sebelum 60 detik → 429 dengan sisa tunggu yang sama.
    const early = await Promise.all(
      pairs.map((c) => api.post("/auth/otp/resend", { challenge_id: c.challenge_id })),
    );
    expect(early.map((r) => [r.statusCode, r.json().retry_after_seconds])).toEqual([
      [429, 60],
      [429, 60],
    ]);
    // Percobaan kode salah: sisa percobaan sama.
    const wrong = wrongCode(t.mailer.last(member.email)!);
    for (const c of pairs) {
      const res = await api.post("/auth/password/forgot/verify", {
        challenge_id: c.challenge_id,
        code: wrong,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.code).toEqual(["Kode salah. Sisa percobaan 4."]);
    }
    t.clock.advance(61_000);
    const sentBefore = sentTo(member.email).length;
    const renewed = await Promise.all(
      pairs.map((c) => api.post("/auth/otp/resend", { challenge_id: c.challenge_id })),
    );
    for (const [i, res] of renewed.entries()) {
      expect(res.statusCode).toBe(200);
      expectOperation("post", "/auth/otp/resend", res);
      expect(res.json().challenge_id).not.toBe(pairs[i]!.challenge_id);
      expect(res.json()).toMatchObject({ purpose: "password_reset", attempts_left: 5 });
    }
    // Kode baru hanya dikirim untuk akun nyata.
    expect(sentTo(member.email)).toHaveLength(sentBefore + 1);
    expect(sentTo(unknown)).toHaveLength(0);
    // Challenge lama: status dan kirim ulang 410 untuk keduanya.
    for (const c of pairs) {
      expect((await api.post("/auth/otp/status", { challenge_id: c.challenge_id })).statusCode).toBe(410);
      expect((await api.post("/auth/otp/resend", { challenge_id: c.challenge_id })).statusCode).toBe(410);
    }
    // Challenge pengganti: lima kode salah lalu 410, seperti challenge nyata; status tetap 200 dengan sisa 0.
    const decoyId = renewed[1]!.json().challenge_id as string;
    for (let left = 4; left >= 1; left--)
      expect(
        (await api.post("/auth/password/forgot/verify", { challenge_id: decoyId, code: "123456" })).json()
          .field_errors.code,
      ).toEqual([`Kode salah. Sisa percobaan ${left}.`]);
    expect(
      (await api.post("/auth/password/forgot/verify", { challenge_id: decoyId, code: "123456" })).statusCode,
    ).toBe(410);
    const exhausted = await api.post("/auth/otp/status", { challenge_id: decoyId });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json().attempts_left).toBe(0);
    // Kedaluwarsa: status tetap 200 (kirim ulang masih diterima) untuk keduanya.
    t.clock.advance(10 * 60_000 + 1000);
    for (const res of renewed) {
      const status = await api.post("/auth/otp/status", { challenge_id: res.json().challenge_id });
      expect(status.statusCode).toBe(200);
      expect(new Date(status.json().expires_at).getTime()).toBeLessThan(t.clock.now().getTime());
    }
  });

  it("PRD 2.5: batas 5 kirim per jam per email identik untuk email terdaftar dan tidak terdaftar", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const unknown = uniqueEmail("kuota");
    for (const email of [member.email, unknown]) {
      for (let i = 0; i < 5; i++) {
        await forgot(email);
        t.clock.advance(61_000);
      }
      const limited = await api.post("/auth/password/forgot", { email });
      expect(limited.statusCode).toBe(429);
      expectOperation("post", "/auth/password/forgot", limited);
      expect(limited.json().code).toBe("RATE_LIMITED");
    }
    expect(sentTo(member.email)).toHaveLength(5);
    expect(sentTo(unknown)).toHaveLength(0);
  });

  it("permintaan ulang dalam cooldown mengembalikan challenge aktif yang sama tanpa email baru", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const unknown = uniqueEmail("ganda");
    for (const email of [member.email, unknown]) {
      const first = await forgot(email);
      const sent = sentTo(email).length;
      const second = await forgot(email);
      expect(second.challenge_id).toBe(first.challenge_id);
      expect(sentTo(email)).toHaveLength(sent);
    }
  });

  it("validasi: email tidak valid → 400 field_errors.email", async () => {
    const res = await api.post("/auth/password/forgot", { email: "bukan-email" });
    expect(res.statusCode).toBe(400);
    expectOperation("post", "/auth/password/forgot", res);
    expect(res.json().field_errors.email).toBeDefined();
  });
});

describe("AC F02-4: ganti sandi mensyaratkan sandi lama", () => {
  it("AC F02-4: sandi lama benar → sandi baru tersimpan, sesi lain dan token push-nya dicabut, sesi ini tetap", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const current = await signInAlumni(t, member);
    const other = await signInAlumni(t, member);
    const [otherRow] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, String(decodeJwt(other.accessToken).sid)));
    const tokenId = uuidv7();
    await t.db.insert(deviceTokens).values({
      id: tokenId,
      userId: member.userId,
      sessionId: otherRow!.id,
      platform: "android",
      token: `fcm-uji-${tokenId}`,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    const [before] = await t.db.select().from(users).where(eq(users.id, member.userId));

    const res = await api.post(
      "/auth/password/change",
      { current_password: member.password, new_password: NEW_PASSWORD },
      { token: current.accessToken },
    );
    expect(res.statusCode, res.body).toBe(204);
    expectOperation("post", "/auth/password/change", res);

    expect((await api.get("/me", { token: current.accessToken })).statusCode).toBe(200);
    expect((await api.get("/me", { token: other.accessToken })).statusCode).toBe(401);
    expect((await api.post("/auth/refresh", { refresh_token: other.refreshToken })).statusCode).toBe(401);
    expect((await api.post("/auth/refresh", { refresh_token: current.refreshToken })).statusCode).toBe(200);
    const [token] = await t.db.select().from(deviceTokens).where(eq(deviceTokens.id, tokenId));
    expect(token!.revokedAt).not.toBeNull();
    const [after] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(after!.sessionVersion).toBe(before!.sessionVersion);
    expect((await api.post("/auth/login", { email: member.email, password: NEW_PASSWORD })).statusCode).toBe(
      200,
    );

    const [notice] = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(notice).toMatchObject({ category: "security", data: { event: "password_changed" } });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "account.password_changed"), eq(auditLogs.entityId, member.userId)));
    expect(audit).toMatchObject({ effectiveRole: "alumni", after: { other_sessions_revoked: 1 } });
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it("sandi lama salah → 400 field_errors.current_password dan dihitung ke batas kegagalan login (429)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    for (let i = 0; i < 10; i++) {
      const res = await api.post(
        "/auth/password/change",
        { current_password: "Salah#2026x", new_password: NEW_PASSWORD },
        { token: session.accessToken },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.current_password).toBeDefined();
    }
    const limited = await api.post(
      "/auth/password/change",
      { current_password: member.password, new_password: NEW_PASSWORD },
      { token: session.accessToken },
    );
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/auth/password/change", limited);
    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(429);
  });

  it("sandi baru tidak memenuhi PRD 2.5 → 400 field_errors.new_password tanpa mengubah sandi", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const res = await api.post(
      "/auth/password/change",
      { current_password: member.password, new_password: "lemah" },
      { token: session.accessToken },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().field_errors.new_password).toBeDefined();
    expect(
      (await api.post("/auth/login", { email: member.email, password: member.password })).statusCode,
    ).toBe(200);
  });

  it("PRD 2.2: anggota suspended dan expired tetap dapat mengganti sandi (member_access any)", async () => {
    for (const status of ["suspended", "expired"] as const) {
      const member = await createAlumni(t, { status });
      const session = await signInAlumni(t, member);
      const res = await api.post(
        "/auth/password/change",
        { current_password: member.password, new_password: NEW_PASSWORD },
        { token: session.accessToken },
      );
      expect(res.statusCode, status).toBe(204);
    }
  });

  it("negatif: token admin → 403 FORBIDDEN; tanpa token → 401", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const forbidden = await api.post(
      "/auth/password/change",
      { current_password: admin.password, new_password: NEW_PASSWORD },
      { token: session.accessToken },
    );
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("FORBIDDEN");
    expectOperation("post", "/auth/password/change", forbidden);
    const anonymous = await api.post("/auth/password/change", {
      current_password: "x",
      new_password: NEW_PASSWORD,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("AC F02-4: login yang menilai sandi lama tidak memperoleh sesi setelah reset/ganti sandi (TOCTOU)", () => {
  /**
   * Menjalankan `between` tepat setelah login menilai sandi dengan bcrypt (di luar transaksi) dan SEBELUM transaksi
   * penerbitan sesi: jendela tempat reset/ganti sandi dapat commit (seluruh durasi bcrypt di produksi).
   */
  function afterPasswordCheck(between: () => Promise<void>) {
    const verifier = t.app.get(PasswordVerifier);
    const original = verifier.verify.bind(verifier);
    return vi.spyOn(verifier, "verify").mockImplementationOnce(async (...args) => {
      const user = await original(...args);
      await between();
      return user;
    });
  }

  const liveSessionsOf = (userId: string) =>
    t.db
      .select({ id: sessions.id, familyId: sessions.familyId })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

  it("AC F02-4: reset sandi commit di antara bcrypt dan penerbitan sesi → 401 generik, tanpa sesi baru", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const { grant } = await resetGrant(member);
    let reset = 0;
    const spy = afterPasswordCheck(async () => {
      reset = (
        await api.post("/auth/password/reset", { reset_token: grant.reset_token, new_password: NEW_PASSWORD })
      ).statusCode;
    });
    const login = await api.post("/auth/login", { email: member.email, password: member.password });
    spy.mockRestore();

    expect(reset).toBe(204);
    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({ code: "UNAUTHENTICATED", message: "Email atau password salah." });
    expectOperation("post", "/auth/login", login);
    expect(await liveSessionsOf(member.userId)).toHaveLength(0);
    expect((await api.post("/auth/login", { email: member.email, password: NEW_PASSWORD })).json().next).toBe(
      "home",
    );
  });

  it("AC F02-4: ganti sandi commit di antara bcrypt dan penerbitan sesi → 401, hanya sesi pengganti yang hidup", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const owner = await signInAlumni(t, member);
    let change = 0;
    const spy = afterPasswordCheck(async () => {
      change = (
        await api.post(
          "/auth/password/change",
          { current_password: member.password, new_password: NEW_PASSWORD },
          { token: owner.accessToken },
        )
      ).statusCode;
    });
    const login = await api.post("/auth/login", { email: member.email, password: member.password });
    spy.mockRestore();

    expect(change).toBe(204);
    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({ code: "UNAUTHENTICATED", message: "Email atau password salah." });
    const [ownerRow] = await t.db
      .select({ familyId: sessions.familyId })
      .from(sessions)
      .where(eq(sessions.id, String(decodeJwt(owner.accessToken).sid)));
    const live = await liveSessionsOf(member.userId);
    expect(live.map((row) => row.familyId)).toEqual([ownerRow!.familyId]);
    expect((await api.get("/me", { token: owner.accessToken })).statusCode).toBe(200);
  });

  it("akun dinonaktifkan di antara bcrypt dan penerbitan sesi → 401 generik, tanpa sesi", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const spy = afterPasswordCheck(async () => {
      await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, member.userId));
    });
    const login = await api.post("/auth/login", { email: member.email, password: member.password });
    spy.mockRestore();
    expect(login.statusCode).toBe(401);
    expect(await liveSessionsOf(member.userId)).toHaveLength(0);
  });
});
