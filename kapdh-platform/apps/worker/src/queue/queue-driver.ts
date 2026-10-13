import type { Logger } from "pino";

/**
 * Abstraksi antrean worker (PRD 5.1, ARCHITECTURE §4.8): BullMQ + ioredis bila REDIS_URL diisi (lintas instance,
 * retry, dedup jobId), atau eksekusi inline dalam proses bila tidak. Antrean hanya mengangkut RUJUKAN kerja (id klaim
 * outbox + lease, nama job + slot), bukan payload bisnis atau PII (N-14); keadaan durable tetap di PostgreSQL sehingga
 * kehilangan Redis/job tidak menghilangkan event (outbox diklaim ulang setelah lease habis).
 */
export type QueueName = "outbox" | "scheduled";

export const QUEUE_NAMES: readonly QueueName[] = ["outbox", "scheduled"];

export interface QueueJob<T> {
  /**
   * Kunci dedup antrean: selama job dengan id yang sama masih menunggu, berjalan, menunggu retry, atau masih disimpan
   * (`retainMs`), penambahan ulang diabaikan. Bentuk aman untuk BullMQ dibuat dengan {@link queueJobId}.
   */
  jobId: string;
  data: T;
  /** Percobaan maksimum (>= 1) untuk galat yang dilempar processor. */
  attempts: number;
  /** Backoff eksponensial dasar antarpercobaan (delay * 2^(n-1)). */
  backoffMs: number;
  /** Lama job selesai disimpan sebagai catatan dedup (BullMQ removeOnComplete.age). Bawaan 1 jam. */
  retainMs?: number;
}

export interface JobMeta {
  queue: QueueName;
  /** Id job di antrean (kunci dedup), dicatat sebagai `queue_job_id`. */
  jobId: string;
  /** Percobaan ke-n (dimulai 1). */
  attempt: number;
  /**
   * Logger terikat `queue`, `job_id` (id korelasi yang sama dengan log JobRunner dan audit, lihat
   * {@link RegisterOptions.correlate}), `queue_job_id`, dan `attempt` (N-14).
   */
  logger: Logger;
}

export type Processor<T> = (data: T, meta: JobMeta) => Promise<void>;

export interface RegisterOptions<T> {
  /** Job paralel maksimum untuk antrean ini di proses ini. */
  concurrency: number;
  /**
   * Dipanggil untuk job yang dibuang saat shutdown sebelum sempat (atau selesai) dijalankan di driver inline, mis.
   * dispatcher melepas klaim outbox agar instance berikutnya tidak menunggu lease habis.
   */
  discard?: (data: T) => Promise<void>;
  /**
   * `job_id` untuk semua log antrean job ini (N-14: satu job_id menghubungkan log antrean, log JobRunner, dan audit):
   * mis. `outbox:<id event>` atau id eksekusi job terjadwal. Bawaan: id job antrean.
   */
  correlate?: (data: T) => string;
}

export interface QueueDriver {
  readonly kind: "inline" | "bullmq";
  /** Mendaftarkan processor sebelum {@link start}. */
  register<T>(queue: QueueName, processor: Processor<T>, options: RegisterOptions<T>): void;
  /** Melempar bila backend antrean tidak siap dalam batas waktu (proses keluar dan dijalankan ulang orkestrator). */
  start(): Promise<void>;
  /**
   * Menambahkan job; false bila dedup (jobId yang sama masih ada). Melempar (cepat, dengan batas waktu) bila backend
   * antrean tidak tersedia.
   */
  enqueue<T>(queue: QueueName, job: QueueJob<T>): Promise<boolean>;
  /** Slot kosong untuk backpressure: dispatcher tidak mengklaim lebih dari yang dapat segera diproses. */
  capacity(queue: QueueName): Promise<number>;
  /** True bila job dengan id ini masih menunggu, berjalan, atau menunggu retry. */
  isPending(queue: QueueName, jobId: string): Promise<boolean>;
  /**
   * Pemeriksaan kesehatan backend antrean: Redis menjawab DAN semua klien BullMQ terinisialisasi serta konsumennya
   * berjalan; inline selalu true.
   */
  ping(): Promise<boolean>;
  /**
   * Berhenti mengambil job baru dan menunggu job yang sedang berjalan sampai `timeoutMs`. True bila semua selesai
   * tepat waktu; false bila batas waktu habis (job yang tersisa dipulihkan lewat lease/stalled check).
   */
  close(timeoutMs: number): Promise<boolean>;
}

/** Backend antrean tidak tersedia (Redis tidak siap, putus, atau tidak menjawab dalam batas waktu). */
export class QueueUnavailableError extends Error {
  override name = "QueueUnavailableError";
  readonly code = "QUEUE_UNAVAILABLE";
}

/**
 * Id job antrean dari bagian-bagian kunci dedup: setiap bagian di-encode (`:` dilarang BullMQ untuk id kustom, dan
 * id tidak boleh berupa bilangan bulat), lalu digabung dengan titik di belakang prefix tetap.
 *
 *   queueJobId("outbox", "notification.created:0190…", "2") → "outbox.notification.created%3A0190….2"
 */
export function queueJobId(prefix: QueueName, ...parts: string[]): string {
  return [prefix, ...parts.map((part) => encodeURIComponent(part))].join(".");
}

/** Delay backoff eksponensial percobaan ke-`attempt` (dimulai 1) sebelum percobaan berikutnya. */
export function backoffDelay(baseMs: number, attempt: number): number {
  return Math.min(3600_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Menunggu promise selesai (berhasil ATAU gagal) sampai batas waktu; true bila selesai tepat waktu. */
export async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  // Timer sengaja tidak di-unref: menjaga proses tetap hidup sampai urutan shutdown selesai.
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => true as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hasil promise, atau {@link QueueUnavailableError} bila tidak selesai dalam `timeoutMs` (operasi Redis yang
 * menggantung tidak pernah menahan poll/tick). Penolakan promise setelah batas waktu diabaikan.
 */
export async function withinTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new QueueUnavailableError(`${what} tidak selesai dalam ${timeoutMs} ms`)),
          Math.max(0, timeoutMs),
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
