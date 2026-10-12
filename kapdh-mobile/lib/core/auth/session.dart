import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/api_exception.dart';
import 'auth_api.dart';
import 'token_store.dart';

enum SessionPhase { unknown, anonymous, authenticated }

class SessionState {
  const SessionState._(this.phase, {this.effectiveStatus, this.me, this.challenge});

  const SessionState.unknown() : this._(SessionPhase.unknown);
  const SessionState.anonymous({OtpChallenge? challenge}) : this._(SessionPhase.anonymous, challenge: challenge);
  const SessionState.authenticated(String status, Map<String, dynamic> me) : this._(SessionPhase.authenticated, effectiveStatus: status, me: me);

  final SessionPhase phase;

  /// Dari server (GET /me). Klien tidak menghitung status sendiri (PRD 2.2).
  final String? effectiveStatus;
  final Map<String, dynamic>? me;

  /// Challenge OTP pendaftaran yang sedang berjalan.
  final OtpChallenge? challenge;
}

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore());

final dioProvider = Provider<Dio>((ref) {
  return createApiDio(ref.watch(tokenStoreProvider), onSessionExpired: () => ref.read(sessionProvider.notifier).expired());
});

final authApiProvider = Provider<AuthApi>((ref) => AuthApi(ref.watch(dioProvider)));

final sessionProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);

class SessionController extends Notifier<SessionState> {
  @override
  SessionState build() => const SessionState.unknown();

  AuthApi get _api => ref.read(authApiProvider);
  TokenStore get _store => ref.read(tokenStoreProvider);

  /// Dipanggil saat aplikasi dibuka: pakai token tersimpan bila masih berlaku.
  Future<void> bootstrap() async {
    if (await _store.accessToken() == null) {
      state = const SessionState.anonymous();
      return;
    }
    await refreshMe();
  }

  Future<void> refreshMe() async {
    try {
      final me = await _api.me();
      state = SessionState.authenticated(me['effective_status'] as String, me);
    } on ApiException catch (e) {
      if (e.isNetwork && state.phase == SessionPhase.authenticated) return; // tetap pada status terakhir saat offline
      await _store.clear();
      state = const SessionState.anonymous();
    }
  }

  Future<void> startRegistration(OtpChallenge challenge) async {
    state = SessionState.anonymous(challenge: challenge);
  }

  Future<void> completeSignup(TokenPair tokens) async {
    await _store.save(access: tokens.accessToken, refresh: tokens.refreshToken);
    await refreshMe();
  }

  Future<OtpChallenge?> login(String email, String password) async {
    final (tokens, challenge) = await _api.login(email, password);
    if (challenge != null) {
      state = SessionState.anonymous(challenge: challenge);
      return challenge;
    }
    await completeSignup(tokens!);
    return null;
  }

  Future<void> logout() async {
    try {
      await _api.logout();
    } on ApiException {
      // Tetap hapus sesi lokal walau server tidak terjangkau.
    }
    await _store.clear();
    state = const SessionState.anonymous();
  }

  void expired() {
    state = const SessionState.anonymous();
  }
}
