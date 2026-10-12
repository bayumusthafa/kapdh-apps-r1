import type { ErrorCode } from "@kapdh/contracts";

/** Perilaku UI yang seragam untuk setiap kode galat (PRD 4.5 dan 5.2). */
export type ErrorUiAction =
  | "show_field_errors"
  | "go_to_login"
  | "go_to_mfa"
  | "show_forbidden"
  | "go_to_renewal"
  | "go_to_restricted"
  | "offer_new_otp"
  | "show_countdown"
  | "show_file_rules"
  | "reload_latest"
  | "show_sold_out"
  | "show_reservation_expired"
  | "show_already_checked_in"
  | "show_maintenance"
  | "show_retry";

export interface ErrorUi {
  action: ErrorUiAction;
  /** Pesan cadangan bila server tidak mengirim pesan. */
  fallbackMessage: string;
}

export const ERROR_UI: Record<ErrorCode, ErrorUi> = {
  VALIDATION_ERROR: { action: "show_field_errors", fallbackMessage: "Periksa kembali isian yang ditandai." },
  UNAUTHENTICATED: { action: "go_to_login", fallbackMessage: "Sesi berakhir. Silakan masuk kembali." },
  MFA_REQUIRED: { action: "go_to_mfa", fallbackMessage: "Masukkan kode autentikator untuk melanjutkan." },
  FORBIDDEN: { action: "show_forbidden", fallbackMessage: "Anda tidak memiliki izin untuk tindakan ini." },
  MEMBERSHIP_REQUIRED: { action: "go_to_renewal", fallbackMessage: "Fitur ini memerlukan KTA aktif." },
  ACCOUNT_SUSPENDED: { action: "go_to_restricted", fallbackMessage: "Akun Anda sedang dibatasi." },
  OTP_EXPIRED: { action: "offer_new_otp", fallbackMessage: "Kode tidak berlaku. Minta kode baru." },
  RATE_LIMITED: { action: "show_countdown", fallbackMessage: "Terlalu banyak percobaan. Coba lagi nanti." },
  FILE_INVALID: {
    action: "show_file_rules",
    fallbackMessage: "Berkas tidak dapat diterima. Gunakan JPG/PNG maks 5 MB atau PDF maks 10 MB.",
  },
  PAYMENT_STATE_CONFLICT: {
    action: "reload_latest",
    fallbackMessage: "Status pembayaran sudah berubah. Data terbaru dimuat ulang.",
  },
  PROOF_VERSION_CONFLICT: {
    action: "reload_latest",
    fallbackMessage: "Bukti sudah diganti. Periksa bukti terbaru sebelum memutus.",
  },
  EVENT_SOLD_OUT: { action: "show_sold_out", fallbackMessage: "Kuota event sudah penuh." },
  RESERVATION_EXPIRED: {
    action: "show_reservation_expired",
    fallbackMessage: "Batas waktu reservasi sudah lewat.",
  },
  TICKET_ALREADY_CHECKED_IN: {
    action: "show_already_checked_in",
    fallbackMessage: "Tiket ini sudah check-in.",
  },
  IDEMPOTENCY_CONFLICT: {
    action: "reload_latest",
    fallbackMessage: "Permintaan bertabrakan dengan permintaan sebelumnya.",
  },
  MAINTENANCE: { action: "show_maintenance", fallbackMessage: "Layanan sedang dalam pemeliharaan." },
  INTERNAL_ERROR: { action: "show_retry", fallbackMessage: "Terjadi kesalahan. Coba lagi." },
  NOT_FOUND: { action: "show_forbidden", fallbackMessage: "Data tidak ditemukan." },
  VERSION_CONFLICT: {
    action: "reload_latest",
    fallbackMessage: "Data sudah diubah orang lain. Muat ulang untuk melihat versi terbaru.",
  },
};
