import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';

/// Challenge aktivasi akun pending_otp (kontrak C1: `signup` dan `email_change` berbagi satu slot aktivasi).
bool isActivationPurpose(OtpPurpose? purpose) => purpose == OtpPurpose.signup || purpose == OtpPurpose.emailChange;

/// Hasil mutasi tidak diketahui (PRD 4.5, kontrak C1 verifyOtp/resetPassword): respons tidak pernah diterima
/// (jaringan putus, timeout, dibatalkan), respons tidak dapat dibaca, atau server/proksi menjawab 5xx/408. Server
/// mungkin sudah memproses request itu, sehingga 410 pada pengulangan berikutnya belum tentu berarti gagal.
bool isUnknownOutcome(ApiException error) => switch (error.kind) {
  ApiFailureKind.api => (error.statusCode ?? 0) >= 500 || error.statusCode == 408,
  _ => true,
};

/// Email dan sandi dari langkah Data Diri atau login akun pending_otp, HANYA di memori (kontrak C1 verifyOtp): bila
/// verifikasi OTP berakhir tanpa respons lalu pengulangannya 410, klien memanggil POST /auth/login dengan kredensial
/// ini untuk mengetahui apakah akun sudah aktif (`next: home`) alih-alih meminta kode baru. Tidak pernah disimpan ke
/// penyimpanan perangkat, dicatat, atau ditampilkan (ARCHITECTURE §2 butir 3).
@immutable
class ActivationCredentials {
  const ActivationCredentials({required this.email, required this.password});

  final String email;
  final String password;

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is ActivationCredentials && other.email == email && other.password == password;

  @override
  int get hashCode => Object.hash(email, password);

  // Sandi dan email tidak pernah muncul di log.
  @override
  String toString() => 'ActivationCredentials(***)';
}

final activationCredentialsProvider = NotifierProvider<ActivationCredentialsController, ActivationCredentials?>(
  ActivationCredentialsController.new,
);

/// Kredensial aktivasi dilepas otomatis begitu sesi terbit atau alur aktivasi berakhir (challenge bukan lagi
/// signup/email_change), sehingga sandi tidak bertahan di memori lebih lama dari alur OTP.
class ActivationCredentialsController extends Notifier<ActivationCredentials?> {
  @override
  ActivationCredentials? build() {
    ref.listen<SessionState>(sessionProvider, (_, next) {
      if (state != null && (next.hasSession || !isActivationPurpose(next.challenge?.purpose))) state = null;
    });
    return null;
  }

  void remember({required String email, required String password}) =>
      state = ActivationCredentials(email: email.trim(), password: password);

  void clear() => state = null;
}

/// Email yang terakhir diketik pengguna di layar auth (hanya memori): mengisi awal Lupa Password dari login dan
/// login setelah pemulihan selesai. Tidak pernah dimasukkan ke URL rute.
final authEmailHintProvider = NotifierProvider<AuthEmailHintController, String>(AuthEmailHintController.new);

class AuthEmailHintController extends Notifier<String> {
  @override
  String build() => '';

  void set(String email) => state = email.trim();
}

/// Batas berlaku `reset_token` (PasswordResetGrant.expires_at, 10 menit sejak OTP pemulihan benar; AC F02-4).
/// Tokennya sendiri disimpan [SessionState.resetToken] (memori). Dilepas otomatis bila token tidak ada lagi.
final resetGrantExpiryProvider = NotifierProvider<ResetGrantExpiryController, DateTime?>(
  ResetGrantExpiryController.new,
);

class ResetGrantExpiryController extends Notifier<DateTime?> {
  @override
  DateTime? build() {
    ref.listen<SessionState>(sessionProvider, (_, next) {
      if (state != null && next.resetToken == null) state = null;
    });
    return null;
  }

  void set(DateTime expiresAt) => state = expiresAt.toUtc();
}

/// Pemberitahuan sekali tampil di layar login setelah alur pemulihan (mis. sandi baru tersimpan; PRD 4.5).
@immutable
class LoginNotice {
  const LoginNotice({required this.message, this.title, this.success = false});

  final String? title;
  final String message;

  /// Hasil berhasil (nada info); selain itu peringatan.
  final bool success;
}

final loginNoticeProvider = NotifierProvider<LoginNoticeController, LoginNotice?>(LoginNoticeController.new);

class LoginNoticeController extends Notifier<LoginNotice?> {
  @override
  LoginNotice? build() => null;

  void show(LoginNotice notice) => state = notice;

  void clear() => state = null;
}
