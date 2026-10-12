import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../api/api_providers.dart';
import '../config/app_info.dart';

/// Repositori auth tipis di atas `KapdhApi.auth` untuk cangkang aplikasi (F-01, F-02). Fitur auth lain (lupa sandi,
/// ganti sandi, sesi) memakai repositori yang sama atau kelas API terbangkit langsung di featurenya.
class AuthRepository {
  AuthRepository(this._api, this._info);

  final AuthApi _api;
  final AppInfo _info;

  Future<OtpChallenge> register(RegisterRequest body, {required String idempotencyKey}) =>
      _api.register(body, idempotencyKey: idempotencyKey);

  Future<OtpVerifyResponse> verifyOtp({required String challengeId, required String code}) =>
      _api.verifyOtp(OtpVerifyRequest(challengeId: challengeId, code: code, deviceName: _info.deviceName));

  Future<OtpChallenge> resendOtp(String challengeId) => _api.resendOtp(OtpResendRequest(challengeId: challengeId));

  Future<LoginResponse> login({required String email, required String password}) =>
      _api.login(LoginRequest(email: email.trim(), password: password, deviceName: _info.deviceName));

  Future<void> logout() => _api.logout();

  /// Mencabut semua sesi dan socket pengguna (AC F02-6).
  Future<void> logoutAll() => _api.logoutAll();

  Future<ReauthResponse> reauthenticate(String password) => _api.reauthenticate(ReauthRequest(password: password));
}

/// Repositori /me tipis untuk sesi dan routing status (PRD 2.2).
class MeRepository {
  MeRepository(this._api);

  final MeApi _api;

  Future<Me> getMe() => _api.getMe();
}

/// Repositori data publik tanpa login: konfigurasi untuk gerbang aplikasi dan dukungan (PRD 4.5) serta versi
/// persetujuan legal untuk registrasi (F-01). Halaman legal milik domain konten (kontrak C4, `KapdhApi.content`).
class PublicRepository {
  PublicRepository(this._public, this._content);

  final PublicApi _public;
  final ContentApi _content;

  Future<PublicConfig> getConfig() => _public.getPublicConfig();

  /// `consent` dari GET /public/pages: `policy_version` gabungan kanonis `privacy:<v>;terms:<v>` yang dikirim apa
  /// adanya sebagai `accept_policy_version`; null bila salah satu dokumen belum pernah terbit.
  Future<LegalConsentVersions> getConsentVersions() async => (await _content.listPublicPages()).consent;
}

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(ref.watch(kapdhApiProvider).auth, ref.watch(appInfoProvider)),
);

final meRepositoryProvider = Provider<MeRepository>((ref) => MeRepository(ref.watch(kapdhApiProvider).me));

final publicRepositoryProvider = Provider<PublicRepository>(
  (ref) => PublicRepository(ref.watch(kapdhApiProvider).public, ref.watch(kapdhApiProvider).content),
);
