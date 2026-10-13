import type { components } from "@kapdh/contracts";
import { failureAction, fieldMessage, requestJson, type ApiFailure } from "./api";
import { formatDate, formatDateTime, formatDuration, formatMoney } from "./format";

/**
 * Logika /delete-account (F-14, account.yaml): challenge -> OTP -> pengungkapan D2 + konfirmasi -> nomor
 * permintaan, serta pemeriksaan status lewat challenge yang sama (PRD 2.2). Murni dan teruji
 * (delete-account.test.ts); DOM ada di delete-account-page.ts.
 */

type S = components["schemas"];
export type OtpChallenge = S["OtpChallenge"];
export type WebDeletionVerification = S["WebDeletionVerification"];
export type AccountDeletion = S["AccountDeletion"];
export type AccountDeletionDisclosure = S["AccountDeletionDisclosure"];
export type TicketWarning = S["AccountDeletionTicketWarning"];
export type RefundWarning = S["AccountDeletionRefundWarning"];
export type PaymentWarning = S["AccountDeletionPaymentWarning"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isDateOrNull = (v: unknown) => v === null || isDate(v);

export function isOtpChallenge(v: unknown): v is OtpChallenge {
  return (
    isObj(v) &&
    typeof v.challenge_id === "string" &&
    typeof v.email_masked === "string" &&
    isDate(v.expires_at) &&
    isDate(v.resend_available_at) &&
    typeof v.attempts_left === "number"
  );
}

const DELETION_STATUSES = new Set(["pending", "processing", "failed", "completed"]);

export function isAccountDeletion(v: unknown): v is AccountDeletion {
  return (
    isObj(v) &&
    typeof v.request_number === "string" &&
    typeof v.status === "string" &&
    DELETION_STATUSES.has(v.status) &&
    (v.source === "app" || v.source === "web") &&
    isDate(v.requested_at) &&
    isDate(v.estimated_completion_at) &&
    isDateOrNull(v.completed_at)
  );
}

export function isDisclosure(v: unknown): v is AccountDeletionDisclosure {
  return (
    isObj(v) &&
    typeof v.version === "string" &&
    v.version.length > 0 &&
    typeof v.estimated_completion_days === "number" &&
    typeof v.backup_retention_days === "number" &&
    Array.isArray(v.deleted_data) &&
    Array.isArray(v.retained_data) &&
    typeof v.privacy_policy_slug === "string" &&
    (v.privacy_policy_version === null || typeof v.privacy_policy_version === "string") &&
    Array.isArray(v.active_tickets) &&
    Array.isArray(v.pending_refunds) &&
    Array.isArray(v.open_payments) &&
    typeof v.sole_admin_group_count === "number" &&
    typeof v.linked_admin_identity === "boolean"
  );
}

/** Bentuk WebDeletionVerification beserta invarian kontrak (deletable => pengungkapan + token). */
export function isWebDeletionVerification(v: unknown): v is WebDeletionVerification {
  if (!isObj(v) || typeof v.deletable !== "boolean" || typeof v.registration_pending !== "boolean")
    return false;
  if (typeof v.email_masked !== "string") return false;
  if (!(v.deletion === null || isAccountDeletion(v.deletion))) return false;
  if (v.deletable) {
    return (
      isDisclosure(v.disclosure) &&
      typeof v.deletion_token === "string" &&
      isDate(v.deletion_token_expires_at)
    );
  }
  return v.blocked_reason === "deletion_in_progress" || v.blocked_reason === "account_disabled";
}

const post = <T>(
  apiBase: string,
  path: string,
  body: unknown,
  accept: (v: unknown) => v is T,
  fetcher?: typeof fetch,
  headers?: Record<string, string>,
) => requestJson<T>(apiBase, path, { method: "POST", body, accept, fetcher, headers });

/** POST /public/deletion/challenge: respons sama untuk email apa pun (non-enumerasi, PRD 2.5). */
export const startChallenge = (apiBase: string, email: string, fetcher?: typeof fetch) =>
  post(apiBase, "/public/deletion/challenge", { email }, isOtpChallenge, fetcher);

/** POST /auth/otp/resend: challenge baru bertujuan sama, kode lama batal (account.yaml "Kirim ulang"). */
export const resendChallenge = (apiBase: string, challengeId: string, fetcher?: typeof fetch) =>
  post(apiBase, "/auth/otp/resend", { challenge_id: challengeId }, isOtpChallenge, fetcher);

/** POST /public/deletion/verify. */
export const verifyChallenge = (apiBase: string, challengeId: string, code: string, fetcher?: typeof fetch) =>
  post(
    apiBase,
    "/public/deletion/verify",
    { challenge_id: challengeId, code },
    isWebDeletionVerification,
    fetcher,
  );

/** POST /public/deletion/confirm dengan Idempotency-Key (PRD 4.3) yang dipakai ulang saat jaringan gagal. */
export const confirmDeletion = (
  apiBase: string,
  input: { deletionToken: string; disclosureVersion: string; idempotencyKey: string },
  fetcher?: typeof fetch,
) =>
  post(
    apiBase,
    "/public/deletion/confirm",
    {
      deletion_token: input.deletionToken,
      confirm: true,
      acknowledged_disclosure_version: input.disclosureVersion,
    },
    isAccountDeletion,
    fetcher,
    { "idempotency-key": input.idempotencyKey },
  );

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Pra-validasi email (server tetap memvalidasi, WebDeletionStartRequest maxLength 254). */
export function validateEmail(raw: string): { email: string } | { error: string } {
  const email = raw.trim();
  if (!email) return { error: "Masukkan email akun Anda." };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: "Format email belum benar." };
  return { email };
}

export function validateCode(raw: string): { code: string } | { error: string } {
  const code = raw.trim();
  return /^[0-9]{6}$/.test(code) ? { code } : { error: "Masukkan 6 digit kode dari email." };
}

export type FlowStep = "challenge" | "resend" | "verify" | "confirm";

/**
 * Tindakan UI setelah galat: perbaiki input, tunggu (429), minta kode baru, mulai ulang, coba lagi, tinjau
 * pengungkapan baru (409 VERSION_CONFLICT), atau `pending`: 409 IDEMPOTENCY_CONFLICT "masih diproses" sehingga
 * Idempotency-Key yang SAMA diulang setelah jeda server (PRD 4.3).
 */
export type FailureAction = "fix" | "wait" | "resend" | "restart" | "retry" | "review" | "pending";

export interface FailureView {
  action: FailureAction;
  message: string;
  retryAfterSeconds: number | null;
  /** 409 VERSION_CONFLICT pada konfirmasi: pengungkapan terkini dari `current`. */
  disclosure?: AccountDeletionDisclosure;
  /** Idempotency-Key baru diperlukan (body berubah atau key bentrok dengan payload lain). */
  rotateKey?: boolean;
}

export interface DescribeOptions {
  /** Label tombol konfirmasi yang sedang tampil ("Hapus akun saya" atau pembatalan pendaftaran pending_otp). */
  confirmLabel?: string;
}

export const CONFIRM_LABEL_DEFAULT = "Hapus akun saya";

const NETWORK_MESSAGE = "Tidak dapat menghubungi server KAPDH. Periksa koneksi Anda lalu coba lagi.";
const SERVER_MESSAGE = "Server KAPDH sedang bermasalah. Coba lagi beberapa saat lagi.";
/** Jeda bawaan bila 429 tidak membawa retry_after_seconds maupun header Retry-After. */
const DEFAULT_WAIT_SECONDS = 60;

/** Label tombol yang dibatasi per langkah; 429 menyebut tindakan yang dibatasi (PRD 4.5: pesan spesifik). */
export function actionLabel(step: FlowStep, confirmLabel: string = CONFIRM_LABEL_DEFAULT): string {
  switch (step) {
    case "challenge":
      return "Kirim kode verifikasi";
    case "resend":
      return "Kirim ulang kode";
    case "verify":
      return "Verifikasi";
    case "confirm":
      return confirmLabel;
  }
}

const WAIT_REASON: Record<FlowStep, string> = {
  challenge: "Terlalu banyak permintaan kode verifikasi.",
  resend: "Batas pengiriman kode tercapai.",
  verify: "Terlalu banyak percobaan verifikasi kode.",
  confirm: "Terlalu banyak percobaan konfirmasi.",
};

/**
 * Pesan 429 statis (diumumkan sekali oleh role=alert, N-11): alasan, tombol yang tertahan dan lama jeda. Hitung
 * mundur per detik tampil di luar wilayah live. Batas kirim ulang tidak membatalkan kode yang sudah terkirim.
 */
export function waitMessage(
  step: FlowStep,
  seconds: number,
  confirmLabel: string = CONFIRM_LABEL_DEFAULT,
): string {
  const base = `${WAIT_REASON[step]} Tombol ${actionLabel(step, confirmLabel)} dapat dipakai lagi dalam ${formatDuration(seconds)}.`;
  return step === "resend" ? `${base} Kode yang sudah dikirim tetap dapat dipakai selama masih berlaku.` : base;
}

/**
 * Memetakan galat setiap langkah ke pesan Bahasa Indonesia dan tindakan lewat katalog galat tunggal @kapdh/shared
 * (PRD 5.2): perilaku ditentukan KODE galat kontrak, bukan status HTTP saja. Respons non-JSON (proxy, WAF, captive
 * portal) dan jaringan putus tidak pernah dianggap jawaban server; 429 tanpa body tetap jeda.
 */
export function describeFailure(
  step: FlowStep,
  failure: ApiFailure,
  options: DescribeOptions = {},
): FailureView {
  const confirmLabel = options.confirmLabel ?? CONFIRM_LABEL_DEFAULT;
  const view = (action: FailureAction, message: string, extra: Partial<FailureView> = {}): FailureView => ({
    action,
    message,
    retryAfterSeconds: null,
    ...extra,
  });
  if (failure.kind !== "http") {
    return view(
      "retry",
      step === "confirm"
        ? `Tidak dapat memastikan permintaan terkirim karena koneksi terputus. Tekan ${confirmLabel} lagi; permintaan yang sama tidak akan dibuat dua kali.`
        : NETWORK_MESSAGE,
    );
  }
  const { status, error } = failure;
  switch (failureAction(failure)) {
    case "show_countdown": {
      const seconds = failure.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS;
      return view("wait", waitMessage(step, seconds, confirmLabel), { retryAfterSeconds: seconds });
    }
    case "show_field_errors":
      if (step === "challenge") return view("fix", fieldMessage(error, "email") ?? "Email tidak valid.");
      if (step === "verify") {
        return view(
          "fix",
          fieldMessage(error, "code") ?? error?.message ?? "Kode salah. Periksa kembali kode di email Anda.",
        );
      }
      return view("retry", error?.message ?? "Permintaan tidak valid. Coba lagi.");
    case "offer_new_otp":
      if (step === "verify") {
        return view(
          "resend",
          "Kode tidak berlaku lagi (kedaluwarsa, sudah dipakai, atau percobaan habis). Minta kode baru.",
        );
      }
      if (step === "confirm") {
        return view(
          "restart",
          "Batas waktu konfirmasi sudah lewat atau status akun berubah. Verifikasi email Anda lagi untuk melihat status terbaru, termasuk nomor permintaan bila penghapusan sudah tercatat.",
        );
      }
      return view("restart", "Permintaan kode ini sudah tidak berlaku. Masukkan email Anda lagi untuk memulai ulang.");
    case "reload_latest":
      if (step === "confirm" && error?.code === "VERSION_CONFLICT") {
        if (isDisclosure(error.current)) {
          return view(
            "review",
            "Rincian akun Anda berubah (misalnya tiket, refund, atau pembayaran baru). Periksa lagi sebelum mengonfirmasi.",
            { disclosure: error.current, rotateKey: true },
          );
        }
        // Pengungkapan terbaru tidak terbaca: verifikasi ulang menerbitkan pengungkapan dan token baru.
        return view(
          "restart",
          "Rincian akun Anda berubah. Verifikasi email Anda lagi untuk melihat rincian terbaru sebelum mengonfirmasi.",
        );
      }
      if (step === "confirm" && error?.code === "IDEMPOTENCY_CONFLICT") {
        // Server mengirim retry_after_seconds hanya untuk "permintaan yang sama masih diproses": key TETAP dipakai
        // agar hasil permintaan pertama (nomor permintaan) diputar ulang. Tanpa jeda berarti key bentrok dengan
        // payload lain, sehingga key baru diperlukan.
        if (failure.retryAfterSeconds !== null) {
          return view(
            "pending",
            `Permintaan sebelumnya masih diproses server. Tekan ${confirmLabel} lagi sebentar lagi; permintaan yang sama tidak akan dibuat dua kali.`,
            { retryAfterSeconds: failure.retryAfterSeconds },
          );
        }
        return view(
          "retry",
          `Permintaan bentrok dengan percobaan sebelumnya. Tekan ${confirmLabel} sekali lagi.`,
          { rotateKey: true },
        );
      }
      return view("retry", error?.message ?? SERVER_MESSAGE);
    case "show_maintenance":
      return view(
        "retry",
        `${error?.message ?? "Layanan sedang dalam pemeliharaan."} Penghapusan akun dapat diajukan lagi setelah pemeliharaan selesai.`,
      );
    default:
      return view("retry", status >= 500 || !error ? SERVER_MESSAGE : error.message);
  }
}

export type VerifyOutcome =
  | {
      kind: "deletable";
      registrationPending: boolean;
      disclosure: AccountDeletionDisclosure;
      token: string;
      tokenExpiresAt: string;
      emailMasked: string;
    }
  | { kind: "in_progress"; deletion: AccountDeletion | null; emailMasked: string }
  | { kind: "disabled"; emailMasked: string };

export function toVerifyOutcome(v: WebDeletionVerification): VerifyOutcome {
  if (v.deletable && v.disclosure && v.deletion_token && v.deletion_token_expires_at) {
    return {
      kind: "deletable",
      registrationPending: v.registration_pending,
      disclosure: v.disclosure,
      token: v.deletion_token,
      tokenExpiresAt: v.deletion_token_expires_at,
      emailMasked: v.email_masked,
    };
  }
  if (v.blocked_reason === "account_disabled") return { kind: "disabled", emailMasked: v.email_masked };
  return { kind: "in_progress", deletion: v.deletion, emailMasked: v.email_masked };
}

/** AccountDeletionStatus -> label; `failed` tampil "Sedang diproses ulang" (account.yaml). */
export function deletionStatusLabel(status: AccountDeletion["status"]): string {
  switch (status) {
    case "pending":
      return "Menunggu diproses";
    case "processing":
      return "Sedang diproses";
    case "failed":
      return "Sedang diproses ulang";
    case "completed":
      return "Selesai";
  }
}

export function deletionFacts(d: AccountDeletion): Array<{ label: string; value: string }> {
  const facts = [
    { label: "Nomor permintaan", value: d.request_number },
    { label: "Status", value: deletionStatusLabel(d.status) },
    { label: "Diajukan lewat", value: d.source === "web" ? "Situs kapdh.or.id" : "Aplikasi KAPDH" },
    { label: "Diajukan", value: formatDateTime(d.requested_at) },
  ];
  facts.push(
    d.completed_at
      ? { label: "Selesai", value: formatDateTime(d.completed_at) }
      : { label: "Selesai paling lambat", value: formatDate(d.estimated_completion_at) },
  );
  return facts;
}

const PAYMENT_TYPE_LABEL: Record<PaymentWarning["type"], string> = {
  registration: "Iuran pendaftaran",
  renewal: "Iuran perpanjangan",
  ticket: "Tiket event",
};

/** Kebijakan refund D6 (PRD 3.9) bila pengguna bertindak SEBELUM menghapus akun. */
export function refundPolicyText(t: TicketWarning): string {
  switch (t.refund_policy) {
    case "full_refund":
      return t.event_cancelled
        ? "Event dibatalkan pengurus: Anda berhak atas refund penuh. Ajukan refund lewat aplikasi sebelum menghapus akun."
        : `Batalkan tiket lewat aplikasi${t.self_cancel_deadline_at ? ` sebelum ${formatDateTime(t.self_cancel_deadline_at, t.event_timezone)}` : ""} untuk refund penuh, lalu hapus akun setelah refund selesai.`;
    case "no_refund":
      return "Tiket ini tidak mendapat refund (tiket gratis atau batas pembatalan H-3 sudah lewat).";
    case "case_by_case":
      return "Akun Anda sedang dibatasi; refund diputuskan pengurus per kasus. Hubungi bantuan sebelum menghapus akun.";
    case "payment_pending":
      return "Pembayaran tiket belum selesai dan akan dibatalkan. Bila dana sudah ditransfer, hubungi bendahara lewat bantuan sebelum menghapus akun.";
  }
}

export interface DisclosureWarning {
  title: string;
  lines: string[];
}

/**
 * Peringatan pribadi sebelum konfirmasi (N-15, PRD 3.9/4.4, AC F14-5): tiket aktif hangus, refund yang belum
 * ditransfer, pembayaran terbuka yang dibatalkan, grup yang admin tunggalnya pengguna, identitas pengurus tertaut.
 */
export function disclosureWarnings(d: AccountDeletionDisclosure): DisclosureWarning[] {
  const warnings: DisclosureWarning[] = [];
  if (d.pending_refunds.length > 0) {
    warnings.push({
      title: "Refund belum ditransfer",
      lines: [
        ...d.pending_refunds.map((r) => {
          const what = r.event_title
            ? `tiket ${r.event_title}`
            : PAYMENT_TYPE_LABEL[r.payment_type].toLowerCase();
          const due = r.due_at ? `, tenggat bendahara ${formatDate(r.due_at)}` : "";
          const dest = r.destination_provided
            ? "rekening tujuan sudah diberikan"
            : "rekening tujuan belum diberikan";
          return `Refund ${formatMoney(r.amount)} untuk ${what}${due}; ${dest}.`;
        }),
        "Penghapusan akun tidak menganggap dana sudah dikembalikan. Setelah akun dihapus, bendahara tidak lagi dapat menghubungi Anda dan data rekening tujuan ikut dihapus. Sebaiknya tunggu refund selesai.",
      ],
    });
  }
  if (d.active_tickets.length > 0) {
    warnings.push({
      title: "Tiket aktif akan hangus",
      lines: d.active_tickets.map(
        (t) =>
          `${t.event_title} (${formatDateTime(t.event_starts_at, t.event_timezone)}, ${formatMoney(t.total)}): ${refundPolicyText(t)}`,
      ),
    });
  }
  if (d.open_payments.length > 0) {
    warnings.push({
      title: "Pembayaran terbuka akan dibatalkan",
      lines: [
        ...d.open_payments.map(
          (p) =>
            `${PAYMENT_TYPE_LABEL[p.type]} ${formatMoney(p.amount)}: ${p.proof_submitted ? "bukti transfer sudah diunggah" : "belum ada bukti transfer"}.`,
        ),
        "Dana yang sudah ditransfer tidak otomatis dikembalikan; hubungi bendahara lewat bantuan sebelum menghapus akun.",
      ],
    });
  }
  if (d.sole_admin_group_count > 0) {
    warnings.push({
      title: "Grup chat yang Anda kelola sendiri",
      lines: [
        `Anda admin tunggal di ${d.sole_admin_group_count} grup. Kewenangan dialihkan otomatis ke anggota aktif, atau grup ditutup bila tidak ada.`,
      ],
    });
  }
  if (d.linked_admin_identity) {
    warnings.push({
      title: "Akun tertaut ke identitas pengurus",
      lines: [
        "Identitas pengurus tidak ikut terhapus dan tautannya diputus. Pengalihan kewenangan pengurus dilakukan Super Admin.",
      ],
    });
  }
  return warnings;
}

/** Kebijakan D2 (PRD 3.14) dalam kalimat untuk ditampilkan sebelum konfirmasi. */
export function retentionSummary(d: AccountDeletionDisclosure): string[] {
  return [
    `Penghapusan selesai paling lama ${d.estimated_completion_days} hari kalender; email pemberitahuan dikirim setelah selesai.`,
    "Tidak ada periode retensi data pribadi. Catatan yang tersisa hanya dalam bentuk anonim tanpa nama, email, telepon, foto, atau snapshot identitas.",
    `Backup harian berotasi ${d.backup_retention_days} hari untuk pemulihan bencana; daftar penghapusan diterapkan ulang saat pemulihan sehingga data yang dihapus tidak muncul kembali.`,
  ];
}
