import type { PushErrorClass, PushResult } from "../../core/adapters/push.js";

/**
 * Kebijakan pengiriman notifikasi (F-13, AC F13-4, R5): batas percobaan otomatis, backoff eksponensial, lease klaim
 * worker, klasifikasi galat FCM/SMTP menjadi `error_class` yang ditampilkan ke pengurus, dan penyaring teks layar kunci.
 * Fungsi murni tanpa I/O agar jadwal dan klasifikasi teruji langsung.
 */

/** Percobaan otomatis maksimum per pengiriman sebelum `failed` (retry pengurus memberi satu percobaan tambahan). */
export const DELIVERY_MAX_ATTEMPTS = 6;
/** Backoff dasar: 1, 2, 4, 8, 16 menit … (ARCHITECTURE §4.8 `notifications.retry` berjalan setiap menit). */
export const DELIVERY_BACKOFF_BASE_MS = 60_000;
/** Batas atas backoff dan petunjuk Retry-After provider. */
export const DELIVERY_BACKOFF_MAX_MS = 3_600_000;
/**
 * Lease klaim: pengiriman yang diklaim worker (attempt + 1, next_retry_at = sekarang + lease) tidak diklaim worker lain
 * sampai lease habis. Lease diperbarui per pengiriman tepat sebelum provider dipanggil (pemeriksaan ulang target), jadi
 * lease hanya perlu menutupi SATU percobaan ({@link DELIVERY_SEND_TIMEOUT_MS}) ditambah pencatatan hasil, bukan seluruh
 * batch yang menunggu giliran. Baris yang masih menunggu giliran ketika lease klaim habis boleh diklaim worker lain
 * (attempt + 1); worker pertama lalu melewatinya karena attempt tidak lagi cocok. Worker yang mati setelah klaim membuat
 * pengiriman diklaim ulang setelah lease (at-least-once).
 */
export const DELIVERY_LEASE_MS = 5 * 60_000;
/** Interval job `notifications.retry` (ARCHITECTURE §4.8). */
export const DELIVERY_RETRY_EVERY_MS = 60_000;
/**
 * Batas waktu keras satu percobaan ke provider (SMTP/FCM), jauh di bawah {@link DELIVERY_LEASE_MS}. Saat batas habis
 * percobaan DIBATALKAN (AbortSignal): koneksi SMTP ditutup sebelum server menerima akhir DATA dan permintaan HTTP FCM
 * diputus, lalu pengiriman dijadwalkan ulang dengan backoff. Satu-satunya sisa ambiguitas adalah balasan provider yang
 * hilang tepat setelah provider menerima pesan (sifat semua jaringan); dampaknya diredam collapse key (push) dan
 * Message-ID stabil per pengiriman (email).
 */
export const DELIVERY_SEND_TIMEOUT_MS = 60_000;

/** Galat batas waktu percobaan provider; `code` ETIMEDOUT agar diklasifikasi `timeout` (email) atau NETWORK (push). */
export class ProviderTimeoutError extends Error {
  override name = "ProviderTimeoutError";
  readonly code = "ETIMEDOUT";
  constructor() {
    super("Batas waktu pengiriman ke provider habis");
  }
}

/**
 * Menjalankan satu percobaan provider dengan batas waktu keras: setelah `timeoutMs` sinyal dibatalkan dengan
 * {@link ProviderTimeoutError} (provider WAJIB menghentikan koneksinya, lihat Mailer.send dan PushSender.send) dan janji
 * ditolak dengan galat yang sama. Timer selalu dilepas.
 */
export async function withProviderTimeout<T>(
  send: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      send(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ProviderTimeoutError();
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Jeda sebelum percobaan berikutnya setelah percobaan ke-`attempt` (dimulai 1) gagal sementara: eksponensial
 * 1 menit × 2^(attempt-1), maksimal 1 jam; Retry-After provider (429/503 FCM) dihormati bila lebih lama (R5).
 */
export function deliveryBackoffMs(attempt: number, retryAfterSeconds?: number): number {
  const exponential = Math.min(
    DELIVERY_BACKOFF_MAX_MS,
    DELIVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.floor(attempt) - 1),
  );
  const hint =
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(DELIVERY_BACKOFF_MAX_MS, Math.ceil(retryAfterSeconds) * 1000)
      : 0;
  return Math.max(exponential, hint);
}

/** Hasil satu percobaan kirim, setelah diklasifikasi. */
export type SendOutcome =
  | { kind: "sent"; providerMessageId: string | null }
  | { kind: "retry"; errorClass: string; retryAfterSeconds?: number }
  | { kind: "failed"; errorClass: string; revokeToken: boolean };

/** Keputusan akhir untuk baris notification_deliveries setelah percobaan ke-`attempt`. */
export type DeliveryDecision =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "pending"; errorClass: string; nextRetryAt: Date }
  | { status: "failed"; errorClass: string; revokeToken: boolean };

/**
 * Menentukan status baru: gangguan sementara (429/5xx/jaringan) dijadwalkan ulang dengan backoff dan TIDAK menonaktifkan
 * token (AC F13-4); setelah {@link DELIVERY_MAX_ATTEMPTS} menjadi `failed` (pengurus dapat mengirim ulang). Galat
 * permanen langsung `failed`; UNREGISTERED/INVALID_ARGUMENT token menonaktifkan token.
 */
export function decideDelivery(outcome: SendOutcome, attempt: number, now: Date): DeliveryDecision {
  switch (outcome.kind) {
    case "sent":
      return { status: "sent", providerMessageId: outcome.providerMessageId };
    case "retry":
      if (attempt >= DELIVERY_MAX_ATTEMPTS)
        return { status: "failed", errorClass: outcome.errorClass, revokeToken: false };
      return {
        status: "pending",
        errorClass: outcome.errorClass,
        nextRetryAt: new Date(now.getTime() + deliveryBackoffMs(attempt, outcome.retryAfterSeconds)),
      };
    case "failed":
      return { status: "failed", errorClass: outcome.errorClass, revokeToken: outcome.revokeToken };
  }
}

/** Kelas galat push yang disimpan: kode FCM HTTP v1 (R5) agar mudah dicocokkan dokumentasi Firebase. */
const PUSH_ERROR_CLASS: Record<PushErrorClass, string> = {
  unregistered: "UNREGISTERED",
  invalid_argument: "INVALID_ARGUMENT",
  sender_mismatch: "SENDER_ID_MISMATCH",
  quota_exceeded: "QUOTA_EXCEEDED",
  unavailable: "UNAVAILABLE",
  internal: "INTERNAL",
  auth_error: "AUTH_ERROR",
  network: "NETWORK",
  disabled: "PUSH_DISABLED",
};

/** Hasil PushSender → outcome pengiriman (AC F13-4). */
export function classifyPushResult(result: PushResult): SendOutcome {
  if (result.ok) return { kind: "sent", providerMessageId: result.messageId };
  const errorClass = PUSH_ERROR_CLASS[result.errorClass] ?? result.errorClass.toUpperCase();
  if (result.deactivateToken) return { kind: "failed", errorClass, revokeToken: true };
  if (result.retryable)
    return {
      kind: "retry",
      errorClass,
      ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    };
  return { kind: "failed", errorClass, revokeToken: false };
}

const NETWORK_CODES = new Set([
  "ECONNECTION",
  "ESOCKET",
  "EDNS",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Galat SMTP (nodemailer) → outcome email. Kelas sesuai kontrak admin-notifications: `bounce_hard` (550/551/553,
 * alamat tidak ada), `rejected` (5xx lain, amplop/pesan ditolak) gagal permanen; `bounce_soft` (4xx, 552 kotak penuh),
 * `timeout`, `network` dan `auth_error` (kredensial SMTP, dapat diperbaiki operator) dicoba ulang dengan backoff;
 * galat lain gagal permanen (`unknown`). Pesan galat tidak pernah disimpan (bisa memuat alamat email, N-14).
 */
export function classifyMailError(error: unknown): SendOutcome {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown; name?: unknown };
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (responseCode !== undefined) {
    if (responseCode >= 400 && responseCode < 500) return { kind: "retry", errorClass: "bounce_soft" };
    if (responseCode === 552) return { kind: "retry", errorClass: "bounce_soft" };
    if ([550, 551, 553].includes(responseCode))
      return { kind: "failed", errorClass: "bounce_hard", revokeToken: false };
    if (responseCode >= 500) return { kind: "failed", errorClass: "rejected", revokeToken: false };
  }
  // Batas waktu SMTP nodemailer (ETIMEDOUT) atau percobaan yang dibatalkan pemanggil sebelum diterima server.
  if (code === "ETIMEDOUT" || (typeof e.name === "string" && /timeout|^AbortError$/i.test(e.name)))
    return { kind: "retry", errorClass: "timeout" };
  if (code !== undefined && NETWORK_CODES.has(code)) return { kind: "retry", errorClass: "network" };
  if (code === "EAUTH") return { kind: "retry", errorClass: "auth_error" };
  if (code === "EENVELOPE" || code === "EMESSAGE")
    return { kind: "failed", errorClass: "rejected", revokeToken: false };
  return { kind: "failed", errorClass: "unknown", revokeToken: false };
}

const EMAIL_PATTERN = /[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}/g;
/** Nomor telepon Indonesia (+62/62/0 diikuti 8xx) dengan pemisah spasi/tanda hubung. */
const PHONE_PATTERN = /(?:\+?62[\s-]?|\b0)8\d(?:[\s-]?\d){6,11}\b/g;
const HIDDEN = "[disembunyikan]";

/**
 * Teks aman untuk layar kunci (F-13: payload layar kunci tidak memuat isi chat, bukti bayar atau data kontak). Isi
 * notifikasi inbox sudah dirancang aman oleh kernel; ini pertahanan berlapis: alamat email dan nomor telepon disamarkan,
 * spasi dirapikan, panjang dibatasi.
 */
export function lockScreenText(text: string, maxLength: number): string {
  const safe = text.replace(EMAIL_PATTERN, HIDDEN).replace(PHONE_PATTERN, HIDDEN).replace(/\s+/g, " ").trim();
  return safe.length > maxLength ? `${safe.slice(0, maxLength - 1).trimEnd()}…` : safe;
}

/** Batas teks push (FCM total 4 KB; layar kunci menampilkan judul + 1–2 baris). */
export const PUSH_TITLE_MAX = 120;
export const PUSH_BODY_MAX = 240;
/** Isi push bila notifikasi tidak memiliki isi. */
export const PUSH_DEFAULT_BODY = "Ketuk untuk melihat detail di aplikasi KAPDH.";
