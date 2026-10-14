import { loadWorkerEnv } from "@kapdh/config";
import { OUTBOX_LOCK_MS } from "@kapdh/api/worker";
import { describe, expect, it } from "vitest";
import { hasPoolHeadroom, resolveWorkerSettings, splitConcurrency, workerPoolSize } from "../src/settings.js";

const BASE = {
  DATABASE_URL: "postgres://kapdh_worker:x@127.0.0.1:5432/kapdh",
  FILE_URL_SECRET: "rahasia-berkas-uji-minimal-32-karakter!!",
};

describe("Pengaturan worker dari WorkerEnv (packages/config, PRD 5.1, 5.3)", () => {
  it("bawaan: poll outbox 2 s (ARCHITECTURE §4.8), lease = OUTBOX_LOCK_MS, health :3001, shutdown 25 s", () => {
    const settings = resolveWorkerSettings(loadWorkerEnv(BASE));
    expect(settings).toMatchObject({
      concurrency: 4,
      outboxConcurrency: 2,
      scheduledConcurrency: 2,
      outbox: { pollIntervalMs: 2_000, batchSize: 50, leaseMs: OUTBOX_LOCK_MS },
      scheduler: { tickMs: 1_000 },
      queue: { readyTimeoutMs: 30_000, operationTimeoutMs: 5_000 },
      health: { host: "0.0.0.0", port: 3001, outboxLagDegradedSeconds: 300 },
      queuePrefix: "kapdh:development:bull",
      shutdownTimeoutMs: 25_000,
    });
  });

  it("variabel worker mengganti bawaan; namespace antrean terpisah per lingkungan (PRD 5.3)", () => {
    const settings = resolveWorkerSettings(
      loadWorkerEnv({
        ...BASE,
        NODE_ENV: "staging",
        SMTP_URL: "smtp://mail.internal:25",
        API_PUBLIC_URL: "https://api-staging.kapdh.or.id",
        WORKER_CONCURRENCY: "8",
        WORKER_HEALTH_PORT: "9100",
        WORKER_HEALTH_HOST: "127.0.0.1",
        OUTBOX_POLL_INTERVAL_MS: "500",
        WORKER_SHUTDOWN_TIMEOUT_MS: "60000",
      }),
    );
    expect(settings).toMatchObject({
      concurrency: 8,
      outboxConcurrency: 4,
      scheduledConcurrency: 4,
      outbox: { pollIntervalMs: 500 },
      health: { host: "127.0.0.1", port: 9100 },
      queuePrefix: "kapdh:staging:bull",
      shutdownTimeoutMs: 60_000,
    });
  });

  it("PRD 5.1: total job paralel per proses = WORKER_CONCURRENCY (minimal 1 per antrean), dalam batas pool kerja WORKER_CONCURRENCY + 1", () => {
    for (let total = 1; total <= 64; total++) {
      const split = splitConcurrency(total);
      expect(split.outbox).toBeGreaterThanOrEqual(1);
      expect(split.scheduled).toBeGreaterThanOrEqual(1);
      // Pool kerja createWorkerDeps: max(2, WORKER_CONCURRENCY + 1). Setiap job memegang paling banyak satu koneksi,
      // sehingga selalu tersisa koneksi untuk heartbeat lease/finalisasi outbox (kecuali WORKER_CONCURRENCY=1: 1 + 1).
      const pool = workerPoolSize(total);
      expect(pool).toBe(Math.max(2, total + 1));
      expect(split.outbox + split.scheduled).toBe(Math.max(2, total));
      expect(split.outbox + split.scheduled).toBeLessThanOrEqual(pool);
      if (total >= 2) expect(split.outbox + split.scheduled).toBeLessThan(pool);
      // Runtime memperingatkan konfigurasi tanpa koneksi cadangan (hanya WORKER_CONCURRENCY=1).
      const resolved = resolveWorkerSettings(loadWorkerEnv({ ...BASE, WORKER_CONCURRENCY: String(total) }));
      expect(hasPoolHeadroom(resolved)).toBe(total >= 2);
    }
    expect(splitConcurrency(5)).toEqual({ outbox: 3, scheduled: 2 });
  });

  it("PRD 5.1 least privilege: WorkerEnv tidak memuat secret JWT/OTP/TOTP/QR walau ada di environment proses", () => {
    const env = loadWorkerEnv({
      ...BASE,
      JWT_ACCESS_SECRET: "rahasia-jwt-yang-tidak-boleh-sampai-worker-123",
      OTP_HMAC_SECRET: "rahasia-otp-yang-tidak-boleh-sampai-worker-123",
      TOTP_ENC_KEY: "a".repeat(64),
      QR_SIGNING_KEYS: "k1:rahasia-qr-yang-tidak-boleh-sampai-worker-123",
    }) as Record<string, unknown>;
    for (const key of [
      "JWT_ACCESS_SECRET",
      "OTP_HMAC_SECRET",
      "TOTP_ENC_KEY",
      "QR_SIGNING_KEYS",
      "BCRYPT_COST",
    ])
      expect(key in env).toBe(false);
  });
});
