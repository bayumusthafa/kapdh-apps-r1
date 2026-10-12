// Katalog penanganan galat tunggal untuk semua klien (PRD 5.2: "Setiap klien memetakan kode galat ke perilaku UI
// yang seragam melalui satu katalog penanganan galat"; PRD 4.5). Katalog Dart (kapdh_api error_catalog.dart)
// dibangkitkan dari berkas ini oleh packages/contracts/scripts/gen-dart.mjs, sehingga berkas ini hanya boleh
// mengimpor TIPE dari @kapdh/contracts (tanpa impor runtime).
import type { ErrorCode } from "@kapdh/contracts";

/** Semua perilaku UI yang dikenal klien. Urutan tidak bermakna. */
export const ERROR_UI_ACTIONS = [
  "show_field_errors",
  "go_to_login",
  "go_to_mfa",
  "reauthenticate",
  "show_forbidden",
  "refresh_status",
  "go_to_restricted",
  "offer_new_otp",
  "show_countdown",
  "show_file_rules",
  "reload_latest",
  "show_sold_out",
  "show_reservation_expired",
  "show_already_checked_in",
  "show_not_found",
  "force_update",
  "show_maintenance",
  "show_retry",
  "show_offline",
] as const;

/** Perilaku UI yang seragam untuk setiap kode galat (PRD 4.5 dan 5.2). */
export type ErrorUiAction = (typeof ERROR_UI_ACTIONS)[number];

export interface ErrorUi {
  action: ErrorUiAction;
  /** Pesan cadangan bila server tidak mengirim pesan; pesan server selalu diutamakan. */
  fallbackMessage: string;
}

/**
 * Katalog per ErrorCode kontrak (ARCHITECTURE §4.4). `Record<ErrorCode, ...>` membuat typecheck gagal bila kode
 * baru ditambahkan ke kontrak tanpa entri di sini.
 */
export const ERROR_UI: Record<ErrorCode, ErrorUi> = {
  VALIDATION_ERROR: { action: "show_field_errors", fallbackMessage: "Periksa kembali isian yang ditandai." },
  UNAUTHENTICATED: { action: "go_to_login", fallbackMessage: "Sesi berakhir. Silakan masuk kembali." },
  MFA_REQUIRED: { action: "go_to_mfa", fallbackMessage: "Masukkan kode autentikator untuk melanjutkan." },
  // Tindakan sensitif (hapus akun, ubah biaya, izin admin) meminta sandi/TOTP lagi lalu mengulang permintaan.
  REAUTH_REQUIRED: {
    action: "reauthenticate",
    fallbackMessage: "Konfirmasi ulang identitas Anda untuk melanjutkan tindakan ini.",
  },
  FORBIDDEN: { action: "show_forbidden", fallbackMessage: "Anda tidak memiliki izin untuk tindakan ini." },
  // PRD 2.2: unverified menuju pembayaran iuran, expired menuju perpanjangan. Klien memuat ulang /me dan
  // mengarahkan dengan routeForStatus, bukan selalu ke perpanjangan.
  MEMBERSHIP_REQUIRED: {
    action: "refresh_status",
    fallbackMessage: "Fitur ini memerlukan KTA aktif. Status keanggotaan Anda sedang diperbarui.",
  },
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
  VERSION_CONFLICT: {
    action: "reload_latest",
    fallbackMessage: "Data sudah diubah orang lain. Muat ulang untuk melihat versi terbaru.",
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
    fallbackMessage: "Permintaan bertabrakan dengan permintaan sebelumnya. Status terbaru dimuat ulang.",
  },
  NOT_FOUND: { action: "show_not_found", fallbackMessage: "Data tidak ditemukan atau sudah tidak tersedia." },
  // PRD 4.5: versi di bawah minimum menampilkan layar wajib update dengan tautan toko aplikasi.
  UPGRADE_REQUIRED: {
    action: "force_update",
    fallbackMessage: "Versi aplikasi ini tidak lagi didukung. Perbarui aplikasi untuk melanjutkan.",
  },
  MAINTENANCE: { action: "show_maintenance", fallbackMessage: "Layanan sedang dalam pemeliharaan." },
  INTERNAL_ERROR: { action: "show_retry", fallbackMessage: "Terjadi kesalahan. Coba lagi." },
};

/**
 * Kegagalan sisi klien yang tidak berasal dari body Error server: jaringan putus/timeout (NETWORK) dan respons
 * yang tidak dikenali, mis. HTML 502 dari proxy atau kode galat baru yang belum dikenal versi klien (UNKNOWN).
 * NETWORK tidak boleh membuat pengguna keluar dan tidak ditampilkan sebagai "tidak ditemukan" (PRD 4.5).
 */
export const CLIENT_ERROR_CODES = ["NETWORK", "UNKNOWN"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export const CLIENT_ERROR_UI: Record<ClientErrorCode, ErrorUi> = {
  NETWORK: {
    action: "show_offline",
    fallbackMessage: "Tidak dapat terhubung. Periksa koneksi internet lalu coba lagi.",
  },
  UNKNOWN: { action: "show_retry", fallbackMessage: "Terjadi kesalahan. Coba lagi." },
};

/** Apakah string adalah ErrorCode yang dikenal versi klien ini. */
export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_UI, code);
}

/** Perilaku UI untuk kode dari server; kode yang belum dikenal (kontrak lebih baru) jatuh ke UNKNOWN. */
export function errorUiFor(code: string): ErrorUi {
  return isErrorCode(code) ? ERROR_UI[code] : CLIENT_ERROR_UI.UNKNOWN;
}
