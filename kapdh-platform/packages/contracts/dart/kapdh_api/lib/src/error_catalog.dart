// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Katalog penanganan galat tunggal (PRD 5.2) dari packages/shared/src/errors.ts (ERROR_UI, CLIENT_ERROR_UI).

import 'package:meta/meta.dart';

import 'models.dart';

/// Perilaku UI seragam untuk setiap kode galat (PRD 4.5, 5.2).
enum ErrorUiAction {
  showFieldErrors('show_field_errors'),
  goToLogin('go_to_login'),
  goToMfa('go_to_mfa'),
  reauthenticate('reauthenticate'),
  showForbidden('show_forbidden'),
  refreshStatus('refresh_status'),
  goToRestricted('go_to_restricted'),
  offerNewOtp('offer_new_otp'),
  showCountdown('show_countdown'),
  showFileRules('show_file_rules'),
  reloadLatest('reload_latest'),
  showSoldOut('show_sold_out'),
  showReservationExpired('show_reservation_expired'),
  showAlreadyCheckedIn('show_already_checked_in'),
  showNotFound('show_not_found'),
  forceUpdate('force_update'),
  showMaintenance('show_maintenance'),
  showRetry('show_retry'),
  showOffline('show_offline');

  const ErrorUiAction(this.value);

  /// Nama aksi di katalog @kapdh/shared.
  final String value;
}

/// Perilaku UI dan pesan cadangan untuk satu kode galat.
@immutable
final class ErrorUi {
  const ErrorUi({required this.action, required this.fallbackMessage});

  final ErrorUiAction action;

  /// Pesan cadangan bila server tidak mengirim pesan; pesan server selalu diutamakan.
  final String fallbackMessage;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ErrorUi && other.action == action && other.fallbackMessage == fallbackMessage;

  @override
  int get hashCode => Object.hash(action, fallbackMessage);

  @override
  String toString() => 'ErrorUi(${action.value})';
}

/// Kegagalan sisi klien yang tidak berasal dari body Error server (PRD 4.5): jaringan putus/timeout
/// ([network], tidak pernah membuat pengguna keluar) dan respons/kode yang tidak dikenali ([unknown]).
enum ClientErrorCode {
  network('NETWORK'),
  unknown('UNKNOWN');

  const ClientErrorCode(this.value);

  final String value;
}

/// Perilaku UI untuk [code] dari server. Kode yang belum dikenal versi SDK ini ([ErrorCode.unknown])
/// memakai perilaku [ClientErrorCode.unknown].
ErrorUi errorUiFor(ErrorCode code) => switch (code) {
      ErrorCode.validationError => const ErrorUi(action: ErrorUiAction.showFieldErrors, fallbackMessage: 'Periksa kembali isian yang ditandai.'),
      ErrorCode.unauthenticated => const ErrorUi(action: ErrorUiAction.goToLogin, fallbackMessage: 'Sesi berakhir. Silakan masuk kembali.'),
      ErrorCode.mfaRequired => const ErrorUi(action: ErrorUiAction.goToMfa, fallbackMessage: 'Masukkan kode autentikator untuk melanjutkan.'),
      ErrorCode.reauthRequired => const ErrorUi(action: ErrorUiAction.reauthenticate, fallbackMessage: 'Konfirmasi ulang identitas Anda untuk melanjutkan tindakan ini.'),
      ErrorCode.forbidden => const ErrorUi(action: ErrorUiAction.showForbidden, fallbackMessage: 'Anda tidak memiliki izin untuk tindakan ini.'),
      ErrorCode.membershipRequired => const ErrorUi(action: ErrorUiAction.refreshStatus, fallbackMessage: 'Fitur ini memerlukan KTA aktif. Status keanggotaan Anda sedang diperbarui.'),
      ErrorCode.accountSuspended => const ErrorUi(action: ErrorUiAction.goToRestricted, fallbackMessage: 'Akun Anda sedang dibatasi.'),
      ErrorCode.otpExpired => const ErrorUi(action: ErrorUiAction.offerNewOtp, fallbackMessage: 'Kode tidak berlaku. Minta kode baru.'),
      ErrorCode.rateLimited => const ErrorUi(action: ErrorUiAction.showCountdown, fallbackMessage: 'Terlalu banyak percobaan. Coba lagi nanti.'),
      ErrorCode.fileInvalid => const ErrorUi(action: ErrorUiAction.showFileRules, fallbackMessage: 'Berkas tidak dapat diterima. Gunakan JPG/PNG maks 5 MB atau PDF maks 10 MB.'),
      ErrorCode.paymentStateConflict => const ErrorUi(action: ErrorUiAction.reloadLatest, fallbackMessage: 'Status pembayaran sudah berubah. Data terbaru dimuat ulang.'),
      ErrorCode.proofVersionConflict => const ErrorUi(action: ErrorUiAction.reloadLatest, fallbackMessage: 'Bukti sudah diganti. Periksa bukti terbaru sebelum memutus.'),
      ErrorCode.versionConflict => const ErrorUi(action: ErrorUiAction.reloadLatest, fallbackMessage: 'Data sudah diubah orang lain. Muat ulang untuk melihat versi terbaru.'),
      ErrorCode.eventSoldOut => const ErrorUi(action: ErrorUiAction.showSoldOut, fallbackMessage: 'Kuota event sudah penuh.'),
      ErrorCode.reservationExpired => const ErrorUi(action: ErrorUiAction.showReservationExpired, fallbackMessage: 'Batas waktu reservasi sudah lewat.'),
      ErrorCode.ticketAlreadyCheckedIn => const ErrorUi(action: ErrorUiAction.showAlreadyCheckedIn, fallbackMessage: 'Tiket ini sudah check-in.'),
      ErrorCode.idempotencyConflict => const ErrorUi(action: ErrorUiAction.reloadLatest, fallbackMessage: 'Permintaan bertabrakan dengan permintaan sebelumnya. Status terbaru dimuat ulang.'),
      ErrorCode.notFound => const ErrorUi(action: ErrorUiAction.showNotFound, fallbackMessage: 'Data tidak ditemukan atau sudah tidak tersedia.'),
      ErrorCode.upgradeRequired => const ErrorUi(action: ErrorUiAction.forceUpdate, fallbackMessage: 'Versi aplikasi ini tidak lagi didukung. Perbarui aplikasi untuk melanjutkan.'),
      ErrorCode.maintenance => const ErrorUi(action: ErrorUiAction.showMaintenance, fallbackMessage: 'Layanan sedang dalam pemeliharaan.'),
      ErrorCode.internalError => const ErrorUi(action: ErrorUiAction.showRetry, fallbackMessage: 'Terjadi kesalahan. Coba lagi.'),
      ErrorCode.unknown => clientErrorUi(ClientErrorCode.unknown),
    };

/// Perilaku UI untuk kegagalan sisi klien.
ErrorUi clientErrorUi(ClientErrorCode code) => switch (code) {
      ClientErrorCode.network => const ErrorUi(action: ErrorUiAction.showOffline, fallbackMessage: 'Tidak dapat terhubung. Periksa koneksi internet lalu coba lagi.'),
      ClientErrorCode.unknown => const ErrorUi(action: ErrorUiAction.showRetry, fallbackMessage: 'Terjadi kesalahan. Coba lagi.'),
    };
