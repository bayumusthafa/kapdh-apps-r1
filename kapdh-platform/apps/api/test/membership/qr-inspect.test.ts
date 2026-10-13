import { SignJWT } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { forgotOtpAppLink, MemoryMailer, otpMailText } from "../../src/core/adapters/mailer.js";
import { QR_AUDIENCE, QR_ISSUER, QrTokenService } from "../../src/core/qr/qr-token.service.js";
import { TestClock, testEnv } from "../support/test-app.js";

/**
 * Tambahan aditif core untuk slice membership: QrTokenService.inspect (langkah 1 urutan verifyKta: tanda tangan
 * diperiksa, exp lewat TIDAK ditolak tetapi ditandai) dan teks email pemulihan sandi oleh pengurus (AC F16-4).
 */

const DAY_MS = 24 * 3600_000;

function service(clock = new TestClock(), keys = testEnv.QR_SIGNING_KEYS) {
  return { clock, qr: new QrTokenService({ ...testEnv, QR_SIGNING_KEYS: keys }, clock) };
}

describe("QrTokenService.inspect (kontrak verifyKta langkah 1; AC F06-3)", () => {
  it("AC F06-3: token sah → klaim terverifikasi; setelah exp tetap terbaca dengan expired=true, sedangkan verify() menolak", async () => {
    const { clock, qr } = service();
    const userId = uuidv7();
    const membershipExpiresAt = new Date(clock.now().getTime() + 2 * DAY_MS);
    const signed = (await qr.sign({ userId, memberSeq: 42, membershipExpiresAt }))!;
    expect(await qr.inspect(signed.token)).toMatchObject({ userId, seq: 42, expired: false, keyId: "k1" });

    clock.advance(3 * DAY_MS);
    expect(await qr.verify(signed.token)).toBeNull();
    const inspected = await qr.inspect(signed.token);
    expect(inspected).toMatchObject({ userId, seq: 42, expired: true });
    expect(inspected!.expiresAt).toEqual(new Date(Math.floor(membershipExpiresAt.getTime() / 1000) * 1000));
  });

  it("AC F06-3: tanda tangan/kunci/issuer/audience/bentuk klaim salah → null tanpa membaca data", async () => {
    const { clock, qr } = service();
    const signed = (await qr.sign({
      userId: uuidv7(),
      memberSeq: 7,
      membershipExpiresAt: new Date(clock.now().getTime() + 30 * DAY_MS),
    }))!;
    const secret = new TextEncoder().encode(testEnv.QR_SIGNING_KEYS.split(":")[1]);
    const now = Math.floor(clock.now().getTime() / 1000);
    const build = (
      claims: Record<string, unknown>,
      options: { kid?: string; iss?: string; aud?: string } = {},
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", kid: options.kid ?? "k1", typ: "JWT" })
        .setIssuer(options.iss ?? QR_ISSUER)
        .setAudience(options.aud ?? QR_AUDIENCE)
        .setSubject(String(claims.sub ?? uuidv7()))
        .setIssuedAt(Number(claims.iat ?? now))
        .setExpirationTime(Number(claims.exp ?? now + 3600))
        .sign(secret);
    const rejected = [
      `${signed.token.slice(0, -3)}abc`,
      "bukan.token.jwt",
      await build({ seq: 7 }, { kid: "lain" }),
      await build({ seq: 7 }, { iss: "lain" }),
      await build({ seq: 7 }, { aud: "lain" }),
      await build({ seq: 0 }),
      await build({ seq: "7" }),
      await build({ seq: 7, sub: "bukan-uuid" }),
      await build({ seq: 7, iat: now + 3600, exp: now + 7200 }),
      await build({ seq: 7, iat: now, exp: now + 8 * 24 * 3600 }),
    ];
    for (const token of rejected) expect(await qr.inspect(token)).toBeNull();
  });

  it("AC F06-3, PRD 3.5 rotasi kunci: token yang ditandatangani kunci lama tetap terbaca selama kuncinya masih terdaftar", async () => {
    const clock = new TestClock();
    const old = service(clock, "k1:" + "q".repeat(32));
    const signed = (await old.qr.sign({
      userId: uuidv7(),
      memberSeq: 3,
      membershipExpiresAt: new Date(clock.now().getTime() + 30 * DAY_MS),
    }))!;
    const rotated = service(clock, `k2:${"r".repeat(32)},k1:${"q".repeat(32)}`);
    expect(await rotated.qr.inspect(signed.token)).toMatchObject({ keyId: "k1", expired: false });
    const removed = service(clock, `k2:${"r".repeat(32)}`);
    expect(await removed.qr.inspect(signed.token)).toBeNull();
  });
});

describe("Email OTP pemulihan oleh pengurus (AC F16-4)", () => {
  it("AC F16-4: memuat kode dan SATU tautan kanonik kapdh://app/forgot/otp?challenge_id=; email OTP biasa tidak berubah", async () => {
    const challengeId = uuidv7();
    const text = otpMailText("123456", { adminInitiatedChallengeId: challengeId });
    expect(text).toContain("Kode Anda: 123456");
    expect(text).toContain(forgotOtpAppLink(challengeId));
    expect(forgotOtpAppLink(challengeId)).toBe(`kapdh://app/forgot/otp?challenge_id=${challengeId}`);
    expect(text.match(/kapdh:\/\//g)).toHaveLength(1);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain(`code=`);
    expect(otpMailText("654321")).toBe(
      "Kode Anda: 654321\n\nKode berlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk pengurus KAPDH.",
    );
    const mailer = new MemoryMailer();
    await mailer.sendOtp("a@contoh.test", "111222", "signup");
    expect(mailer.sent[0]).toEqual({
      to: "a@contoh.test",
      code: "111222",
      purpose: "signup",
      text: otpMailText("111222"),
    });
  });
});
