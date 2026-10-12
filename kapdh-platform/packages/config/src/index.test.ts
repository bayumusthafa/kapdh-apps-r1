import { describe, expect, it } from "vitest";
import { loadServerEnv, parseSigningKeys } from "./index.js";

const base = {
  DATABASE_URL: "postgres://kapdh:kapdh@localhost:5432/kapdh",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "x".repeat(32),
  OTP_HMAC_SECRET: "y".repeat(32),
  QR_SIGNING_KEYS: "k1:" + "z".repeat(32),
  TOTP_ENC_KEY: "a".repeat(64),
};

describe("loadServerEnv", () => {
  it("menerima environment lengkap", () => {
    expect(loadServerEnv(base).PORT).toBe(3000);
  });
  it("menolak environment tanpa DATABASE_URL", () => {
    expect(() => loadServerEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
  it("menolak kunci dev di production", () => {
    expect(() =>
      loadServerEnv({ ...base, NODE_ENV: "production", QR_SIGNING_KEYS: "dev-1:" + "z".repeat(32) }),
    ).toThrow();
  });
  it("mewajibkan SMTP di production", () => {
    expect(() => loadServerEnv({ ...base, NODE_ENV: "production" })).toThrow(/SMTP_URL/);
  });
  it("mengurai daftar kunci QR", () => {
    expect(parseSigningKeys("k1:" + "a".repeat(32))[0]?.keyId).toBe("k1");
  });
});
