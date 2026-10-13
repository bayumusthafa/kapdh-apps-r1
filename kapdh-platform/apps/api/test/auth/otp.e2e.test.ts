/**
 * Keadaan challenge OTP dan koreksi email akun pending_otp (PRD 2.2, 2.5, AC F01-2, F01-3, F16-4; kontrak
 * getOtpChallengeStatus, correctPendingEmail, resendOtp).
 */
import { auditLogs, otpCodes, users } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimitService } from "../../src/core/rate-limit/rate-limit.service.js";
import { OtpChallengeService } from "../../src/modules/auth/otp-challenge.service.js";
import { expectOperation } from "../support/contract.js";
import {
  createAlumni,
  publishLegalVersions,
  TEST_CONSENT_VERSION,
  uniqueEmail,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
let api: ReturnType<typeof httpClient>;

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  await publishLegalVersions(t);
});
afterAll(async () => {
  await t.app.close();
});

const PASSWORD = "Kapdh#2026";
const sentTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

async function register(email = uniqueEmail("daftar")) {
  const res = await api.post("/auth/register", {
    full_name: "Siti Aminah",
    gender: "female",
    email,
    password: PASSWORD,
    cohort: 25,
    class_in: 1,
    class_out: 6,
    accept_policy_version: TEST_CONSENT_VERSION,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { email, challenge: res.json() as { challenge_id: string; purpose: string } };
}

const status = (challengeId: string) => api.post("/auth/otp/status", { challenge_id: challengeId });

describe("kontrak getOtpChallengeStatus: baca keadaan challenge tanpa efek samping", () => {
  it("AC F01-3: 200 selama kirim ulang masih menerima challenge (termasuk kedaluwarsa/percobaan habis); tanpa email", async () => {
    const { email, challenge } = await register();
    const sent = sentTo(email).length;
    const first = await status(challenge.challenge_id);
    expect(first.statusCode).toBe(200);
    expectOperation("post", "/auth/otp/status", first);
    expect(first.json()).toMatchObject({
      challenge_id: challenge.challenge_id,
      purpose: "signup",
      attempts_left: 5,
      max_attempts: 5,
    });
    // Tidak mengirim email, tidak mengganti/mengonsumsi kode, tidak menambah percobaan.
    expect(sentTo(email)).toHaveLength(sent);
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challenge.challenge_id));
    expect(row).toMatchObject({ attempts: 0, consumedAt: null, supersededAt: null });

    const right = t.mailer.last(email)!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      await api.post("/auth/otp/verify", { challenge_id: challenge.challenge_id, code: wrong });
    const exhausted = await status(challenge.challenge_id);
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json().attempts_left).toBe(0);
    t.clock.advance(10 * 60_000 + 1000);
    const expired = await status(challenge.challenge_id);
    expect(expired.statusCode).toBe(200);
    expect(new Date(expired.json().expires_at).getTime()).toBeLessThan(t.clock.now().getTime());
    // Kirim ulang memang masih menerima challenge ini.
    const resent = await api.post("/auth/otp/resend", { challenge_id: challenge.challenge_id });
    expect(resent.statusCode).toBe(200);
    // Challenge lama kini diganti → 410 untuk status seperti kirim ulang.
    const replaced = await status(challenge.challenge_id);
    expect(replaced.statusCode).toBe(410);
    expectOperation("post", "/auth/otp/status", replaced);
  });

  it("410 untuk challenge yang sudah dipakai, tidak dikenal, atau akunnya tidak lagi pending_otp", async () => {
    const { email, challenge } = await register();
    const verified = await api.post("/auth/otp/verify", {
      challenge_id: challenge.challenge_id,
      code: t.mailer.last(email)!,
    });
    expect(verified.statusCode).toBe(200);
    expect((await status(challenge.challenge_id)).json().code).toBe("OTP_EXPIRED");
    expect((await status(uuidv7())).statusCode).toBe(410);
    const other = await register();
    await t.db.update(users).set({ status: "active" }).where(eq(users.email, other.email));
    expect((await status(other.challenge.challenge_id)).statusCode).toBe(410);
    const invalid = await api.post("/auth/otp/status", { challenge_id: "bukan-uuid" });
    expect(invalid.statusCode).toBe(400);
    expectOperation("post", "/auth/otp/status", invalid);
  });

  it("AC F16-4: challenge password_reset dibaca tanpa mengganti kode yang baru diterima", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const challenge = (await api.post("/auth/password/forgot", { email: member.email })).json();
    const code = t.mailer.last(member.email)!;
    const res = await status(challenge.challenge_id);
    expect(res.json()).toEqual(challenge);
    const verify = await api.post("/auth/password/forgot/verify", {
      challenge_id: challenge.challenge_id,
      code,
    });
    expect(verify.statusCode).toBe(200);
  });

  it("batas per IP terpisah dari batas kirim OTP: 60 per 15 menit lalu 429", async () => {
    const { challenge } = await register();
    for (let i = 0; i < 60; i++) expect((await status(challenge.challenge_id)).statusCode).toBe(200);
    const limited = await status(challenge.challenge_id);
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/auth/otp/status", limited);
    // Kirim ulang tidak terpengaruh batas status.
    t.clock.advance(61_000);
    expect((await api.post("/auth/otp/resend", { challenge_id: challenge.challenge_id })).statusCode).toBe(
      200,
    );
  });
});

describe("PRD 2.2: koreksi email akun pending_otp lewat alur terverifikasi", () => {
  const correct = (body: Record<string, unknown>) => api.post("/auth/email-correction", body);

  it("AC F01-2: email baru menerima challenge email_change; email lama tidak dapat lagi mengaktifkan akun", async () => {
    const { email, challenge } = await register();
    const oldCode = t.mailer.last(email)!;
    const newEmail = uniqueEmail("benar");
    const res = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: ` ${newEmail.toUpperCase()} `,
    });
    expect(res.statusCode, res.body).toBe(200);
    expectOperation("post", "/auth/email-correction", res);
    expect(res.json()).toMatchObject({ purpose: "email_change", attempts_left: 5 });
    expect(res.json().email_masked).toBe(`${newEmail.slice(0, 2)}***@contoh.test`);
    expect(sentTo(newEmail).at(-1)).toMatchObject({ purpose: "email_change" });

    // Kode untuk email lama batal.
    expect(
      (await api.post("/auth/otp/verify", { challenge_id: challenge.challenge_id, code: oldCode }))
        .statusCode,
    ).toBe(410);
    const [user] = await t.db.select().from(users).where(eq(users.email, newEmail));
    expect(user).toMatchObject({ status: "pending_otp" });
    // Login akun pending memakai challenge email_change yang aktif.
    const login = await api.post("/auth/login", { email: newEmail, password: PASSWORD });
    expect(login.json()).toMatchObject({
      next: "verify_otp",
      challenge: { challenge_id: res.json().challenge_id },
    });
    // Aktivasi dengan kode email baru (AC F01-2).
    const verified = await api.post("/auth/otp/verify", {
      challenge_id: res.json().challenge_id,
      code: t.mailer.last(newEmail)!,
    });
    expect(verified.statusCode).toBe(200);
    const [active] = await t.db.select().from(users).where(eq(users.id, user!.id));
    expect(active).toMatchObject({ status: "active", email: newEmail });
    expect(active!.emailVerifiedAt).not.toBeNull();
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "account.email_corrected"), eq(auditLogs.entityId, user!.id)));
    expect(audit).toMatchObject({ effectiveRole: "alumni", actorUserId: user!.id });
    expect(JSON.stringify(audit)).not.toContain(oldCode);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it("challenge kedaluwarsa tetap dapat dipakai sebagai bukti kepemilikan (belum dikonsumsi)", async () => {
    const { challenge } = await register();
    t.clock.advance(10 * 60_000 + 1000);
    const res = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: uniqueEmail("x"),
    });
    expect(res.statusCode).toBe(200);
  });

  it("sandi salah → 400 field_errors.password dan dihitung ke batas kegagalan login (429 setelah 10)", async () => {
    const { email, challenge } = await register();
    for (let i = 0; i < 10; i++) {
      const res = await correct({
        challenge_id: challenge.challenge_id,
        password: "Salah#2026x",
        new_email: uniqueEmail("y"),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().field_errors.password).toBeDefined();
    }
    const limited = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: uniqueEmail("y"),
    });
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/auth/email-correction", limited);
    // Email tidak berubah.
    expect(await t.db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  });

  it("email baru sudah terdaftar → 409 field_errors.new_email; email sama → 400; email tidak valid → 400", async () => {
    const taken = await createAlumni(t, { status: "verified" });
    const { email, challenge } = await register();
    const conflict = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: taken.email,
    });
    expect(conflict.statusCode).toBe(409);
    expectOperation("post", "/auth/email-correction", conflict);
    expect(conflict.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { new_email: ["Email sudah terdaftar"] },
    });
    const same = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: email,
    });
    expect(same.statusCode).toBe(400);
    expect(same.json().field_errors.new_email).toBeDefined();
    const invalid = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: "bukan",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().field_errors.new_email).toBeDefined();
  });

  it("410 bila challenge sudah dipakai/tidak dikenal/bukan aktivasi atau akun sudah aktif", async () => {
    const { email, challenge } = await register();
    await api.post("/auth/otp/verify", { challenge_id: challenge.challenge_id, code: t.mailer.last(email)! });
    const consumed = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: uniqueEmail("z"),
    });
    expect(consumed.statusCode).toBe(410);
    expectOperation("post", "/auth/email-correction", consumed);
    expect(
      (await correct({ challenge_id: uuidv7(), password: PASSWORD, new_email: uniqueEmail("z") })).statusCode,
    ).toBe(410);
    const member = await createAlumni(t, { status: "verified" });
    const reset = (await api.post("/auth/password/forgot", { email: member.email })).json();
    expect(
      (
        await correct({
          challenge_id: reset.challenge_id,
          password: member.password,
          new_email: uniqueEmail("z"),
        })
      ).statusCode,
    ).toBe(410);
  });

  it("PRD 2.5: batas kirim OTP ke email baru (5 per jam per email) → 429 tanpa mengubah email", async () => {
    const target = uniqueEmail("target");
    // Kuota email target habis (mis. lima challenge sebelumnya ke alamat ini).
    const key = t.app.get(OtpChallengeService).emailKey(target);
    const limits = t.app.get(RateLimitService);
    for (let i = 0; i < 5; i++) await limits.consume(`otp:${key}`, 5, 3600_000);
    const { email, challenge } = await register();
    const res = await correct({
      challenge_id: challenge.challenge_id,
      password: PASSWORD,
      new_email: target,
    });
    expect(res.statusCode).toBe(429);
    expectOperation("post", "/auth/email-correction", res);
    expect(await t.db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
    expect(sentTo(target)).toHaveLength(0);
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challenge.challenge_id));
    expect(row!.supersededAt).toBeNull();
  });
});

describe("AC F01-4 / PRD 2.5: registrasi ulang akun pending_otp", () => {
  const attackerBody = (email: string) => ({
    full_name: "Nama Penyerang",
    gender: "male",
    email,
    password: "Penyerang#2026",
    cohort: 20,
    class_in: 1,
    class_out: 6,
    accept_policy_version: TEST_CONSENT_VERSION,
  });

  it("PRD 2.5: kuota kirim habis → registrasi ulang ditolak 429 SEBELUM penulisan (sandi, profil, challenge tetap)", async () => {
    const { email, challenge } = await register();
    const [before] = await t.db.select().from(users).where(eq(users.email, email));
    t.clock.advance(61_000);
    const key = t.app.get(OtpChallengeService).emailKey(email);
    const limits = t.app.get(RateLimitService);
    for (let i = 0; i < 4; i++) await limits.consume(`otp:${key}`, 5, 3600_000);
    const res = await api.post("/auth/register", attackerBody(email));
    expect(res.statusCode).toBe(429);
    expectOperation("post", "/auth/register", res);
    const [after] = await t.db.select().from(users).where(eq(users.email, email));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.policyAcceptedAt?.toISOString()).toBe(before!.policyAcceptedAt?.toISOString());
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, challenge.challenge_id));
    expect(row!.supersededAt).toBeNull();
    // Pemilik tetap dapat memverifikasi kode pertama (kedaluwarsa 10 menit belum lewat) dengan sandinya sendiri.
    const verify = await api.post("/auth/otp/verify", {
      challenge_id: challenge.challenge_id,
      code: t.mailer.last(email)!,
    });
    expect(verify.statusCode).toBe(200);
    expect((await api.post("/auth/login", { email, password: PASSWORD })).json().next).toBe("home");
  });

  it("AC F01-4: registrasi ulang setelah akun aktif ditolak 409 dan tidak mengubah sandi akun aktif", async () => {
    const { email, challenge } = await register();
    await api.post("/auth/otp/verify", { challenge_id: challenge.challenge_id, code: t.mailer.last(email)! });
    const [before] = await t.db.select().from(users).where(eq(users.email, email));
    t.clock.advance(61_000);
    const res = await api.post("/auth/register", attackerBody(email));
    expect(res.statusCode).toBe(409);
    expect(res.json().field_errors.email).toBeDefined();
    const [after] = await t.db.select().from(users).where(eq(users.email, email));
    expect(after!.passwordHash).toBe(before!.passwordHash);
  });
});
