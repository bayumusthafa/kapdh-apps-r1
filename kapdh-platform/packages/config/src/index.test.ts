import { describe, expect, it } from "vitest";
import {
  loadApiEnv,
  loadDevelopmentEnvFile,
  loadServerEnv,
  loadWorkerEnv,
  parseFcmServiceAccount,
  parseSigningKeys,
} from "./index.js";

const base = {
  DATABASE_URL: "postgres://kapdh:kapdh@localhost:5432/kapdh",
  FILE_URL_SECRET: "f".repeat(32),
};
const api = {
  ...base,
  JWT_ACCESS_SECRET: "x".repeat(32),
  OTP_HMAC_SECRET: "y".repeat(32),
  QR_SIGNING_KEYS: "k1:" + "z".repeat(32),
  TOTP_ENC_KEY: "a".repeat(64),
};
const fcmJson = JSON.stringify({ client_email: "push@kapdh.iam.test", private_key: "-----BEGIN PRIVATE KEY-----" });
const production = {
  ...api,
  NODE_ENV: "production",
  SMTP_URL: "smtp://u:p@mail.test:587",
  REDIS_URL: "redis://redis:6379",
  FCM_PROJECT_ID: "kapdh-prod",
  FCM_SERVICE_ACCOUNT_JSON: fcmJson,
};

describe("loadApiEnv", () => {
  it("menerima environment lengkap dengan default development", () => {
    const env = loadApiEnv(api);
    expect(env.PORT).toBe(3000);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.HSTS_ENABLED).toBe(false);
    expect(env.REDIS_URL).toBeUndefined();
    expect(loadServerEnv(api).PORT).toBe(3000);
  });

  it("menolak environment tanpa DATABASE_URL dan tidak mencetak nilai secret", () => {
    expect(() => loadApiEnv({ ...api, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    try {
      loadApiEnv({ ...api, JWT_ACCESS_SECRET: "rahasia-pendek" });
    } catch (e) {
      expect((e as Error).message).toContain("JWT_ACCESS_SECRET");
      expect((e as Error).message).not.toContain("rahasia-pendek");
    }
  });

  it("TRUST_PROXY_HOPS bawaan 1 di production dan dapat diatur eksplisit", () => {
    expect(loadApiEnv(production).TRUST_PROXY_HOPS).toBe(1);
    expect(loadApiEnv({ ...production, TRUST_PROXY_HOPS: "2" }).TRUST_PROXY_HOPS).toBe(2);
    expect(loadApiEnv({ ...api, TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
  });

  it("HSTS_ENABLED dibaca sebagai boolean (N-07)", () => {
    expect(loadApiEnv({ ...api, HSTS_ENABLED: "true" }).HSTS_ENABLED).toBe(true);
    expect(loadApiEnv({ ...api, HSTS_ENABLED: "0" }).HSTS_ENABLED).toBe(false);
  });

  it("ADMIN_ORIGIN dinormalisasi tanpa garis miring penutup", () => {
    expect(loadApiEnv({ ...api, ADMIN_ORIGIN: "https://admin.kapdh.or.id/" }).ADMIN_ORIGIN).toBe(
      "https://admin.kapdh.or.id",
    );
    expect(loadApiEnv({ ...api, PUBLIC_WEB_URL: "https://kapdh.or.id/" }).PUBLIC_WEB_URL).toBe(
      "https://kapdh.or.id",
    );
  });

  it("menolak kunci QR development di production", () => {
    expect(() => loadApiEnv({ ...production, QR_SIGNING_KEYS: "dev-1:" + "z".repeat(32) })).toThrow(
      /QR_SIGNING_KEYS/,
    );
  });

  it("memvalidasi QR_SIGNING_KEYS saat load", () => {
    expect(() => loadApiEnv({ ...api, QR_SIGNING_KEYS: "k1:pendek" })).toThrow(/QR_SIGNING_KEYS/);
    expect(() => loadApiEnv({ ...api, QR_SIGNING_KEYS: `k1:${"a".repeat(32)},k1:${"b".repeat(32)}` })).toThrow(
      /ganda/,
    );
  });

  it("mewajibkan SMTP, Redis, dan FCM di production", () => {
    expect(() => loadApiEnv({ ...production, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
    expect(() => loadApiEnv({ ...production, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
    expect(() =>
      loadApiEnv({ ...production, FCM_PROJECT_ID: undefined, FCM_SERVICE_ACCOUNT_JSON: undefined }),
    ).toThrow(/FCM_PROJECT_ID/);
    expect(loadApiEnv(production).NODE_ENV).toBe("production");
  });

  it("menolak placeholder .env.example di staging/production", () => {
    expect(() =>
      loadApiEnv({ ...production, JWT_ACCESS_SECRET: "ganti-dengan-32-karakter-acak-atau-lebih" }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("STORAGE_DRIVER=s3 mewajibkan bucket, region, dan kredensial", () => {
    expect(() => loadApiEnv({ ...api, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
    const env = loadApiEnv({
      ...api,
      STORAGE_DRIVER: "s3",
      S3_REGION: "ap-southeast-1",
      S3_BUCKET: "kapdh-files",
      S3_ACCESS_KEY_ID: "akses",
      S3_SECRET_ACCESS_KEY: "rahasia",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("FCM opsional di luar production tetapi diisi berpasangan dan JSON valid", () => {
    expect(() => loadApiEnv({ ...api, FCM_PROJECT_ID: "kapdh-dev" })).toThrow(/FCM_SERVICE_ACCOUNT_JSON/);
    expect(() =>
      loadApiEnv({ ...api, FCM_PROJECT_ID: "kapdh-dev", FCM_SERVICE_ACCOUNT_JSON: "{bukan json" }),
    ).toThrow(/bukan JSON/);
  });
});

describe("loadWorkerEnv", () => {
  it("tidak memerlukan secret autentikasi API (least privilege)", () => {
    const env = loadWorkerEnv(base);
    expect(env.WORKER_CONCURRENCY).toBe(4);
    expect("JWT_ACCESS_SECRET" in env).toBe(false);
  });

  it("menerapkan aturan production yang sama dengan API", () => {
    expect(() => loadWorkerEnv({ ...base, NODE_ENV: "production" })).toThrow(/SMTP_URL/);
  });
});

describe("parseSigningKeys", () => {
  it("mengurai daftar kunci QR", () => {
    expect(parseSigningKeys("k1:" + "a".repeat(32))[0]?.keyId).toBe("k1");
  });

  it("memisah pada titik dua pertama sehingga secret boleh mengandung titik dua", () => {
    const secret = "abc:def:" + "x".repeat(30);
    expect(parseSigningKeys(`k2:${secret}, k1:${"b".repeat(32)}`)).toEqual([
      { keyId: "k2", secret },
      { keyId: "k1", secret: "b".repeat(32) },
    ]);
  });

  it("menolak key id ganda, secret pendek, dan format salah tanpa membocorkan secret", () => {
    expect(() => parseSigningKeys(`k1:${"a".repeat(32)},k1:${"c".repeat(32)}`)).toThrow(/ganda/);
    expect(() => parseSigningKeys("k1:rahasia")).toThrow(/minimal 32/);
    expect(() => parseSigningKeys(":" + "a".repeat(32))).toThrow(/key_id/);
    expect(() => parseSigningKeys("")).toThrow(/kosong/);
    try {
      parseSigningKeys("k1:rahasia");
    } catch (e) {
      expect((e as Error).message).not.toContain("rahasia");
    }
  });
});

describe("parseFcmServiceAccount", () => {
  it("menerima akun layanan minimum", () => {
    expect(parseFcmServiceAccount(fcmJson).client_email).toBe("push@kapdh.iam.test");
  });
});

describe("loadDevelopmentEnvFile", () => {
  it("tidak membaca berkas apa pun di production", () => {
    expect(loadDevelopmentEnvFile(["/tidak/ada/.env"], { NODE_ENV: "production" })).toBeNull();
    expect(loadDevelopmentEnvFile(["/tidak/ada/.env"], { NODE_ENV: "development" })).toBeNull();
  });
});
