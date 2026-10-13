import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateOtp,
  hotp,
  otpHmac,
  totp,
  verifyTotp,
} from "./crypto.js";

describe("TOTP RFC 6238", () => {
  // Vektor uji RFC 6238 Lampiran B (SHA-1, secret ASCII "12345678901234567890"), 8 digit.
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("t=%i", (t, expected) => {
    expect(totp(secret, new Date(t * 1000), 8)).toBe(expected);
  });
  it("menerima kode langkah sebelumnya dan menolak kode lama", () => {
    const now = new Date(1_800_000_000_000);
    const prev = totp(secret, new Date(now.getTime() - 30_000));
    expect(verifyTotp(secret, prev, now)).toBe(true);
    const old = totp(secret, new Date(now.getTime() - 120_000));
    expect(verifyTotp(secret, old, now)).toBe(old === totp(secret, now));
  });
  it("hotp RFC 4226 counter 0", () => {
    expect(hotp(Buffer.from("12345678901234567890"), 0)).toBe("755224");
  });
});

describe("utilitas", () => {
  it("base32 bolak-balik", () => {
    const b = Buffer.from([0, 1, 2, 250, 255, 7]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
  it("OTP selalu 6 digit", () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });
  it("HMAC OTP terikat challenge", () => {
    expect(otpHmac("s".repeat(32), "c1", "123456")).not.toBe(otpHmac("s".repeat(32), "c2", "123456"));
  });
  it("enkripsi secret TOTP", () => {
    const key = "ab".repeat(32);
    const enc = encryptSecret("JBSWY3DPEHPK3PXP", key);
    expect(enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc, key)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret(enc, "cd".repeat(32))).toThrow();
  });
});
