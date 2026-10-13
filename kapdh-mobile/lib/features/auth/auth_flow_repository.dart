import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';

/// Operasi auth milik fitur pemulihan dan koreksi email (F-01, F-02, PRD 2.5) di atas `KapdhApi.auth` terbangkit.
/// Login, register, verifikasi aktivasi dan kirim ulang memakai `AuthRepository` cangkang (core/session).
class AuthFlowRepository {
  AuthFlowRepository(this._api);

  final AuthApi _api;

  /// POST /auth/otp/status: keadaan challenge tanpa mengirim, mengganti atau mengonsumsi kode (kontrak C1). Dipakai
  /// layar OTP yang dibuka dari tautan `?challenge=<id>` (AC F16-4) atau dipulihkan setelah aplikasi dimulai ulang.
  Future<OtpChallenge> challengeStatus(String challengeId) =>
      _api.getOtpChallengeStatus(OtpChallengeStatusRequest(challengeId: challengeId));

  /// POST /auth/email-correction: koreksi email akun pending_otp; challenge `email_change` dikirim ke email baru
  /// (PRD 2.2, kontrak C1).
  Future<OtpChallenge> correctEmail({
    required String challengeId,
    required String password,
    required String newEmail,
  }) => _api.correctPendingEmail(
    EmailCorrectionRequest(challengeId: challengeId, password: password, newEmail: newEmail.trim()),
  );

  /// POST /auth/password/forgot: selalu 202 dengan challenge berbentuk sama, terdaftar atau tidak (PRD 2.5).
  Future<OtpChallenge> forgotPassword(String email) => _api.forgotPassword(ForgotPasswordRequest(email: email.trim()));

  /// POST /auth/password/forgot/verify: kode `password_reset` ditukar `reset_token` sekali pakai (AC F02-4).
  Future<PasswordResetGrant> verifyPasswordReset({required String challengeId, required String code}) =>
      _api.verifyPasswordResetOtp(PasswordResetVerifyRequest(challengeId: challengeId, code: code));

  /// POST /auth/password/reset: sandi baru disimpan dan seluruh sesi dicabut (AC F02-4).
  Future<void> resetPassword({required String resetToken, required String newPassword}) =>
      _api.resetPassword(ResetPasswordRequest(resetToken: resetToken, newPassword: newPassword));
}

final authFlowRepositoryProvider = Provider<AuthFlowRepository>(
  (ref) => AuthFlowRepository(ref.watch(kapdhApiProvider).auth),
);
