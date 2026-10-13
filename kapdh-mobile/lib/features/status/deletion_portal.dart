import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';

/// Keadaan akun yang ditampilkan portal status tanpa sesi (PRD 2.2, F-14).
enum DeletionPortalAccount {
  /// Belum diketahui: pengguna membuka portal tanpa login (mis. dari tautan) dan belum memeriksa status lewat OTP.
  unknown,

  /// Permintaan penghapusan terbuka (`users.status = deletion_pending`).
  deletionPending,

  /// Akun dinonaktifkan pengurus; pemulihan hanya melalui kanal bantuan.
  disabled,

  /// Pemeriksaan OTP menunjukkan akun aktif tanpa permintaan penghapusan terbuka (mis. dibuka kembali pengurus).
  active,

  /// Pendaftaran pending_otp yang belum pernah diverifikasi; dilanjutkan dengan masuk dan verifikasi OTP.
  registrationPending,
}

/// Status yang diketahui portal; hanya di memori (tidak pernah disimpan) dan dihapus saat sesi baru dibuat.
@immutable
class DeletionPortalState {
  const DeletionPortalState({
    this.account = DeletionPortalAccount.unknown,
    this.deletion,
    this.email,
    this.checkedAt,
    this.justRequested = false,
  });

  final DeletionPortalAccount account;

  /// Permintaan penghapusan terbuka (nomor DEL-YYYY-XXXX, status, batas penyelesaian; AC F14-1).
  final AccountDeletion? deletion;

  /// Email yang diketik pengguna saat login atau pemeriksaan status; dipakai mengisi ulang formulir OTP.
  final String? email;

  /// Waktu (jam perangkat) status terakhir diterima dari server.
  final DateTime? checkedAt;

  /// Permintaan baru saja dibuat dari aplikasi ini: data lokal sudah dihapus dan sesi dicabut (AC F14-1).
  final bool justRequested;

  bool get hasStatus => account != DeletionPortalAccount.unknown;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DeletionPortalState &&
          other.account == account &&
          other.deletion == deletion &&
          other.email == email &&
          other.checkedAt == checkedAt &&
          other.justRequested == justRequested;

  @override
  int get hashCode => Object.hash(account, deletion, email, checkedAt, justRequested);
}

final deletionPortalProvider = NotifierProvider<DeletionPortalController, DeletionPortalState>(
  DeletionPortalController.new,
);

/// Pengisi portal status penghapusan tanpa sesi (kontrak C1: login deletion_pending/account_disabled tanpa sesi).
class DeletionPortalController extends Notifier<DeletionPortalState> {
  @override
  DeletionPortalState build() {
    // Status akun lain tidak boleh terbawa ke sesi baru (N-09): dihapus begitu ada sesi.
    ref.listen<SessionState>(sessionProvider, (previous, next) {
      if (next.hasSession && state != const DeletionPortalState()) state = const DeletionPortalState();
    });
    return const DeletionPortalState();
  }

  DateTime _now() => ref.read(clockProvider)().toUtc();

  /// Hasil login tanpa sesi (`next` deletion_pending atau account_disabled).
  void showLoginResult(LoginResult result, {required String email}) {
    final trimmed = email.trim();
    state = switch (result.outcome) {
      LoginOutcome.deletionPending => DeletionPortalState(
        account: DeletionPortalAccount.deletionPending,
        deletion: result.deletion,
        email: trimmed,
        checkedAt: _now(),
      ),
      LoginOutcome.accountDisabled => DeletionPortalState(
        account: DeletionPortalAccount.disabled,
        email: trimmed,
        checkedAt: _now(),
      ),
      _ => state,
    };
  }

  /// Permintaan penghapusan dari aplikasi berhasil (POST /me/deletion 202, AC F14-1).
  void showRequested(AccountDeletion deletion, {String? email}) {
    state = DeletionPortalState(
      account: DeletionPortalAccount.deletionPending,
      deletion: deletion,
      email: email,
      checkedAt: _now(),
      justRequested: true,
    );
  }

  /// Hasil pemeriksaan ulang lewat OTP email (POST /public/deletion/verify).
  void showVerification(WebDeletionVerification verification, {required String email}) {
    final DeletionPortalAccount account;
    if (verification.deletion != null ||
        verification.blockedReason == WebDeletionVerificationBlockedReason.deletionInProgress) {
      account = DeletionPortalAccount.deletionPending;
    } else if (verification.blockedReason == WebDeletionVerificationBlockedReason.accountDisabled) {
      account = DeletionPortalAccount.disabled;
    } else if (verification.registrationPending) {
      account = DeletionPortalAccount.registrationPending;
    } else if (verification.deletable) {
      account = DeletionPortalAccount.active;
    } else {
      account = DeletionPortalAccount.unknown;
    }
    state = DeletionPortalState(
      account: account,
      deletion: verification.deletion,
      email: email.trim(),
      checkedAt: _now(),
    );
  }

  /// Kembali ke login bersih (pengguna memilih keluar dari portal).
  void clear() => state = const DeletionPortalState();
}
