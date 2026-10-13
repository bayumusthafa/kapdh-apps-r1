import type { WorkerEnv } from "@kapdh/config";
import { OUTBOX_LOCK_MS } from "@kapdh/api/worker";

/**
 * Pengaturan runtime worker (ARCHITECTURE §4.8, PRD 5.1, 5.5) yang diturunkan dari WorkerEnv tervalidasi
 * (packages/config). Nilai bawaan di sini berlaku bila variabel opsional dikosongkan.
 */
export interface WorkerSettings {
  /** Job paralel per antrean per proses (WORKER_CONCURRENCY). */
  concurrency: number;
  /** Job terjadwal paralel per proses; sapuan periodik tidak perlu banyak slot. */
  scheduledConcurrency: number;
  outbox: {
    /** Interval poll saat outbox kosong (bawaan 2 s). Batch penuh langsung di-poll lagi. */
    pollIntervalMs: number;
    /** Klaim maksimum per poll; selalu dibatasi slot antrean yang kosong (backpressure). */
    batchSize: number;
    /** Lease klaim (`locked_until`); event dari proses yang mati diklaim ulang setelah ini. */
    leaseMs: number;
    /** Percobaan job antrean untuk galat infrastruktur (DB/Redis); galat handler dicatat di baris outbox. */
    attempts: number;
    backoffMs: number;
  };
  scheduler: {
    /** Interval evaluasi jadwal + cek leader. */
    tickMs: number;
    attempts: number;
    backoffMs: number;
  };
  health: { host: string; port: number };
  shutdownTimeoutMs: number;
}

export const DEFAULT_HEALTH_PORT = 3001;
export const DEFAULT_HEALTH_HOST = "0.0.0.0";
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

export function resolveWorkerSettings(env: WorkerEnv): WorkerSettings {
  return {
    concurrency: env.WORKER_CONCURRENCY,
    scheduledConcurrency: Math.min(2, env.WORKER_CONCURRENCY),
    outbox: {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
      batchSize: 50,
      leaseMs: OUTBOX_LOCK_MS,
      attempts: 3,
      backoffMs: 1_000,
    },
    scheduler: { tickMs: 1_000, attempts: 3, backoffMs: 5_000 },
    health: {
      host: env.WORKER_HEALTH_HOST ?? DEFAULT_HEALTH_HOST,
      port: env.WORKER_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
    },
    shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  };
}
