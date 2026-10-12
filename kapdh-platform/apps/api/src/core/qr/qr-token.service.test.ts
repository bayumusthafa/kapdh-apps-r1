import type { ApiEnv } from "@kapdh/config";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { Clock } from "../adapters/clock.js";
import { memberSeqOf, QR_MAX_TTL_SECONDS, qrBindingMatches, QrTokenService } from "./qr-token.service.js";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(40);

class Jam implements Clock {
  constructor(public current: Date) {}
  now() {
    return new Date(this.current);
  }
}

function service(keys: string, clock: Clock) {
  return new QrTokenService({ QR_SIGNING_KEYS: keys, PUBLIC_WEB_URL: "https://kapdh.test" } as ApiEnv, clock);
}

const DAY = 24 * 3600_000;

describe("QrTokenService (PRD 3.5, 3.6; ARCHITECTURE §3.2)", () => {
  const userId = uuidv7();
  const start = new Date("2026-10-13T02:00:00Z");

  it("klaim iss/aud/sub/seq/iat/exp dengan kid kunci pertama; exp = min(iat + 7 hari, expires_at)", async () => {
    const clock = new Jam(start);
    const qr = service(`k2:${SECRET_B},k1:${SECRET_A}`, clock);
    const longMember = await qr.sign({
      userId,
      memberSeq: 7,
      membershipExpiresAt: new Date(start.getTime() + 300 * DAY),
    });
    const header = decodeProtectedHeader(longMember!.token);
    const claims = decodeJwt(longMember!.token);
    expect(header).toMatchObject({ alg: "HS256", kid: "k2" });
    expect(claims).toMatchObject({ iss: "kapdh-api", aud: "kapdh-kta", sub: userId, seq: 7 });
    expect(claims.exp! - claims.iat!).toBe(QR_MAX_TTL_SECONDS);
    // Token tidak memuat kontak, nomor lengkap, atau secret.
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "seq", "sub"]);

    const expiring = new Date(start.getTime() + 2 * DAY);
    const short = await qr.sign({ userId, memberSeq: 7, membershipExpiresAt: expiring });
    expect(short!.expiresAt).toEqual(expiring);
    expect(await qr.sign({ userId, memberSeq: 7, membershipExpiresAt: start })).toBeNull();

    const verified = await qr.verify(longMember!.token);
    expect(verified).toMatchObject({ userId, seq: 7, keyId: "k2", issuedAt: start });
  });

  it("rotasi kunci: token lama (kid k1) tetap sah setelah k2 menjadi penanda tangan; kunci dicabut → ditolak", async () => {
    const clock = new Jam(start);
    const before = service(`k1:${SECRET_A}`, clock);
    const old = (await before.sign({
      userId,
      memberSeq: 3,
      membershipExpiresAt: new Date(start.getTime() + 90 * DAY),
    }))!;
    const rotated = service(`k2:${SECRET_B},k1:${SECRET_A}`, clock);
    expect(rotated.activeKeyId).toBe("k2");
    expect(await rotated.verify(old.token)).toMatchObject({ keyId: "k1", seq: 3 });
    const revoked = service(`k2:${SECRET_B}`, clock);
    expect(await revoked.verify(old.token)).toBeNull();
  });

  it("AC F06-3: token diubah, kedaluwarsa, audience/issuer lain, alg lain, atau umur > 7 hari → null", async () => {
    const clock = new Jam(start);
    const qr = service(`k1:${SECRET_A}`, clock);
    const { token } = (await qr.sign({
      userId,
      memberSeq: 9,
      membershipExpiresAt: new Date(start.getTime() + 90 * DAY),
    }))!;
    const [h, p, s] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(token), seq: 10 })).toString("base64url");
    expect(await qr.verify(`${h}.${forgedPayload}.${s}`)).toBeNull();
    expect(await qr.verify(`${h}.${p}.${s!.slice(0, -2)}xx`)).toBeNull();
    expect(await qr.verify("")).toBeNull();
    expect(await qr.verify("x".repeat(3000))).toBeNull();

    const key = new TextEncoder().encode(SECRET_A);
    const iat = Math.floor(start.getTime() / 1000);
    const custom = (
      claims: Record<string, unknown>,
      options: { aud?: string; iss?: string; exp?: number; kid?: string } = {},
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", kid: options.kid ?? "k1" })
        .setIssuer(options.iss ?? "kapdh-api")
        .setAudience(options.aud ?? "kapdh-kta")
        .setSubject(userId)
        .setIssuedAt(iat)
        .setExpirationTime(options.exp ?? iat + 3600)
        .sign(key);
    expect(await qr.verify(await custom({ seq: 9 }, { aud: "kapdh-mobile" }))).toBeNull();
    expect(await qr.verify(await custom({ seq: 9 }, { iss: "pihak-lain" }))).toBeNull();
    expect(await qr.verify(await custom({ seq: 9 }, { kid: "tidak-ada" }))).toBeNull();
    expect(await qr.verify(await custom({ seq: 9 }, { exp: iat + QR_MAX_TTL_SECONDS + 60 }))).toBeNull();
    expect(await qr.verify(await custom({ seq: "9" }))).toBeNull();
    expect(await qr.verify(await custom({ seq: 9 }))).toMatchObject({ seq: 9 });
    // alg none tidak pernah diterima.
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${p}.`;
    expect(await qr.verify(none)).toBeNull();

    clock.current = new Date(start.getTime() + QR_MAX_TTL_SECONDS * 1000 + 1000);
    expect(await qr.verify(token)).toBeNull();
  });

  it("isi QR memakai fragmen #t= sehingga token tidak terkirim ke server web (PRD 3.6)", () => {
    const qr = service(`k1:${SECRET_A}`, new Jam(start));
    expect(qr.qrContent("12.01.01.7", "abc.def.ghi")).toBe("https://kapdh.test/kta/12.01.01.7#t=abc.def.ghi");
  });

  it("AC F05-6: keterikatan memakai user_id + N, bukan prefix; N dari URL wajib sama", () => {
    const claims = { userId, seq: 7 };
    expect(qrBindingMatches(claims, { userId, memberSeq: 7 })).toBe(true);
    // Setelah koreksi 12.02.01.7 → 12.01.01.7, token lama tetap terikat ke anggota yang sama.
    expect(qrBindingMatches(claims, { userId, memberSeq: 7 }, "12.01.01.7")).toBe(true);
    expect(qrBindingMatches(claims, { userId, memberSeq: 7 }, "12.01.01.8")).toBe(false);
    expect(qrBindingMatches(claims, { userId: uuidv7(), memberSeq: 7 })).toBe(false);
    expect(qrBindingMatches(claims, { userId, memberSeq: null })).toBe(false);
    expect(memberSeqOf("30.01.02.12345")).toBe(12345);
    expect(memberSeqOf("30.01.02.0")).toBeNull();
    expect(memberSeqOf("3.01.02.1")).toBeNull();
  });
});
