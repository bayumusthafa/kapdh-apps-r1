import type { components } from "@kapdh/contracts";
import { fieldMessage, requestJson, type ApiFailure } from "./api";
import { formatDate, formatDateTime, formatMoney } from "./format";

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

/** Tindakan UI setelah galat: perbaiki input, tunggu (429), minta kode baru, mulai ulang, atau coba lagi. */
export type FailureAction = "fix" | "wait" | "resend" | "restart" | "retry" | "review";

export interface FailureView {
  action: FailureAction;
  message: string;
  retryAfterSeconds: number | null;
  /** 409 VERSION_CONFLICT pada konfirmasi: pengungkapan terkini dari `current`. */
  disclosure?: AccountDeletionDisclosure;
}

const NETWORK_MESSAGE = "Tidak dapat menghubungi server KAPDH. Periksa koneksi Anda lalu coba lagi.";

/**
 * Memetakan galat setiap langkah ke pesan Bahasa Indonesia dan tindakan. Respons non-JSON (proxy/captive
 * portal) dan jaringan putus tidak pernah dianggap jawaban server.
 */
export function describeFailure(step: FlowStep, failure: ApiFailure): FailureView {
  if (failure.kind !== "http") {
    return {
      action: "retry",
      message:
        step === "confirm"
          ? "Tidak dapat memastikan permintaan terkirim karena koneksi terputus. Tekan Hapus akun saya lagi; permintaan yang sama tidak akan dibuat dua kali."
          : NETWORK_MESSAGE,
      retryAfterSeconds: null,
    };
  }
  const { status, error } = failure;
  if (status === 429) {
    return {
      action: "wait",
      message: "Terlalu banyak percobaan. Tunggu hitung mundur selesai lalu coba lagi.",
      retryAfterSeconds: failure.retryAfterSeconds ?? 60,
    };
  }
  if (status === 400) {
    if (step === "challenge") {
      return {
        action: "fix",
        message: fieldMessage(error, "email") ?? "Email tidak valid.",
        retryAfterSeconds: null,
      };
    }
    if (step === "verify") {
      return {
        action: "fix",
        message:
          fieldMessage(error, "code") ?? error?.message ?? "Kode salah. Periksa kembali kode di email Anda.",
        retryAfterSeconds: null,
      };
    }
    return {
      action: "retry",
      message: error?.message ?? "Permintaan tidak valid. Coba lagi.",
      retryAfterSeconds: null,
    };
  }
  if (status === 410) {
    if (step === "verify") {
      return {
        action: "resend",
        message:
          "Kode tidak berlaku lagi (kedaluwarsa, sudah dipakai, atau percobaan habis). Minta kode baru.",
        retryAfterSeconds: null,
      };
    }
    if (step === "confirm") {
      return {
        action: "restart",
        message:
          "Batas waktu konfirmasi sudah lewat atau status akun berubah. Verifikasi email Anda lagi untuk melihat status terbaru.",
        retryAfterSeconds: null,
      };
    }
    return {
      action: "restart",
      message: "Permintaan kode ini sudah tidak berlaku. Masukkan email Anda lagi untuk memulai ulang.",
      retryAfterSeconds: null,
    };
  }
  if (status === 409 && step === "confirm") {
    if (error?.code === "VERSION_CONFLICT" && isDisclosure(error.current)) {
      return {
        action: "review",
        message:
          "Rincian akun Anda berubah (misalnya tiket, refund, atau pembayaran baru). Periksa lagi sebelum mengonfirmasi.",
        retryAfterSeconds: null,
        disclosure: error.current,
      };
    }
    return {
      action: "retry",
      message: "Permintaan bentrok dengan percobaan sebelumnya. Tekan Hapus akun saya sekali lagi.",
      retryAfterSeconds: null,
    };
  }
  if (status === 503 && error?.code === "MAINTENANCE") {
    return {
      action: "retry",
      message: `${error.message} Penghapusan akun dapat diajukan lagi setelah pemeliharaan selesai.`,
      retryAfterSeconds: null,
    };
  }
  return {
    action: "retry",
    message:
      status >= 500 || !error
        ? "Server KAPDH sedang bermasalah. Coba lagi beberapa saat lagi."
        : error.message,
    retryAfterSeconds: null,
  };
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
