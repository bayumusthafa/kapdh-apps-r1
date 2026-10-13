import type { WorkerEnv } from "@kapdh/config";
import { OUTBOX_LOCK_MS } from "@kapdh/api/worker";

/**
 * Pengaturan runtime worker (ARCHITECTURE §4.8, PRD 5.1, 5.5) yang diturunkan dari WorkerEnv tervalidasi
 * (packages/config). Nilai bawaan di sini berlaku bila variabel opsional dikosongkan.
 */
export interface WorkerSettings {
  /** Total job paralel per proses (WORKER_CONCURRENCY), dibagi antara antrean outbox dan antrean terjadwal. */
  concurrency: number;
  /** Job outbox paralel per proses: WORKER_CONCURRENCY dikurangi bagian job terjadwal (minimal 1). */
  outboxConcurrency: number;
  /** Job terjadwal paralel per proses: separuh WORKER_CONCURRENCY (minimal 1), agar sapuan panjang tidak menahan outbox. */
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
  queue: {
    /**
     * Batas tunggu Redis siap saat start (BullMQ). Lewat batas ini start gagal dan proses keluar non-zero sehingga
     * orkestrator menjalankannya ulang; worker tidak pernah berjalan dengan klien BullMQ yang gagal inisialisasi.
     */
    readyTimeoutMs: number;
    /**
     * Batas waktu satu operasi produsen (enqueue, slot, status job). Redis putus/menggantung → operasi ditolak cepat
     * sehingga poll outbox melepas klaimnya dan tick penjadwal mencoba lagi, bukan menggantung tanpa batas.
     */
    operationTimeoutMs: number;
  };
  health: {
    host: string;
    port: number;
    /** Umur event outbox jatuh tempo yang belum diklaim sebelum health melaporkan `degraded` (umur job/outbox, PRD 5.5). */
    outboxLagDegradedSeconds: number;
  };
  /** Namespace key BullMQ per lingkungan (staging dan production terpisah walau berbagi Redis, PRD 5.3). */
  queuePrefix: string;
  shutdownTimeoutMs: number;
}

export const DEFAULT_HEALTH_PORT = 3001;
export const DEFAULT_HEALTH_HOST = "0.0.0.0";
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
export const DEFAULT_OUTBOX_LAG_DEGRADED_SECONDS = 300;
export const DEFAULT_QUEUE_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_QUEUE_OPERATION_TIMEOUT_MS = 5_000;

/**
 * Pembagian WORKER_CONCURRENCY antara antrean: total job paralel tetap WORKER_CONCURRENCY (minimal 1 per antrean),
 * sehingga pool kerja `WORKER_CONCURRENCY + 1` (createWorkerDeps) selalu menyisakan koneksi untuk heartbeat lease dan
 * finalisasi outbox. Tanpa pembagian ini 2 × WORKER_CONCURRENCY job berebut pool dan perpanjangan lease dapat
 * tertahan di belakang sapuan terjadwal yang panjang.
 */
export function splitConcurrency(total: number): { outbox: number; scheduled: number } {
  const scheduled = Math.max(1, Math.floor(total / 2));
  return { outbox: Math.max(1, total - scheduled), scheduled };
}

export function resolveWorkerSettings(env: WorkerEnv): WorkerSettings {
  const split = splitConcurrency(env.WORKER_CONCURRENCY);
  return {
    concurrency: env.WORKER_CONCURRENCY,
    outboxConcurrency: split.outbox,
    scheduledConcurrency: split.scheduled,
    outbox: {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
      batchSize: 50,
      leaseMs: OUTBOX_LOCK_MS,
      attempts: 3,
      backoffMs: 1_000,
    },
    scheduler: { tickMs: 1_000, attempts: 3, backoffMs: 5_000 },
    queue: {
      readyTimeoutMs: DEFAULT_QUEUE_READY_TIMEOUT_MS,
      operationTimeoutMs: DEFAULT_QUEUE_OPERATION_TIMEOUT_MS,
    },
    health: {
      host: env.WORKER_HEALTH_HOST ?? DEFAULT_HEALTH_HOST,
      port: env.WORKER_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
      outboxLagDegradedSeconds: DEFAULT_OUTBOX_LAG_DEGRADED_SECONDS,
    },
    queuePrefix: `kapdh:${env.NODE_ENV}:bull`,
    shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  };
}
