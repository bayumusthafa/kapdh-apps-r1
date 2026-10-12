import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../api/api_providers.dart';
import '../api/api_signals.dart';
import '../cache/kta_cache_store.dart';
import '../storage/token_store.dart';
import 'me_snapshot_store.dart';
import 'repositories.dart';
import 'session_state.dart';

final meSnapshotStoreProvider = Provider<MeSnapshotStore>((ref) => MeSnapshotStore(ref.watch(secureStoreProvider)));

final ktaCacheStoreProvider = Provider<KtaCacheStore>(
  (ref) => KtaCacheStore(ref.watch(secureStoreProvider), clock: ref.watch(clockProvider)),
);

final sessionProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);

/// Hasil login (AC F02-1, PRD 2.2).
enum LoginOutcome {
  /// Token diterbitkan; router mengarahkan sesuai effective_status.
  signedIn,

  /// Akun masih pending_otp; challenge OTP baru tersedia di state.
  verifyOtp,

  /// Akun deletion_pending: tanpa sesi; sandi benar hanya membuka status permintaan penghapusan (F-14).
  deletionPending,

  /// Akun disabled: tanpa sesi; pemulihan hanya melalui pengurus (PRD 2.2).
  accountDisabled,
}

/// Hasil login beserta status permintaan penghapusan untuk [LoginOutcome.deletionPending] (kontrak C1).
@immutable
class LoginResult {
  const LoginResult(this.outcome, {this.deletion});

  final LoginOutcome outcome;

  /// Status permintaan penghapusan tanpa data pribadi (AC F14-1); hanya untuk [LoginOutcome.deletionPending].
  final AccountDeletion? deletion;
}

/// Pengendali sesi (ARCHITECTURE §8.3, PRD 2.2, 5.2).
///
/// - Bootstrap tanpa koneksi TIDAK pernah mengeluarkan pengguna: dengan snapshot /me terakhir masuk ke
///   [SessionPhase.offlineLastKnown]; tanpa snapshot tetap [SessionPhase.unknown] dengan masalah `offline` agar splash
///   menampilkan "Tanpa koneksi" dan tombol coba lagi.
/// - Token hanya dihapus koordinator refresh (UNAUTHENTICATED dari /auth/refresh) atau saat pengguna keluar.
/// - Logout dan pergantian akun menghapus cache KTA, snapshot /me dan key idempotensi (PRD 5.2, AC F05-3).
class SessionController extends Notifier<SessionState> {
  Future<void>? _loading;

  @override
  SessionState build() {
    final invalidated = ref.watch(refreshCoordinatorProvider).invalidated.listen((_) => unawaited(_onInvalidated()));
    final signals = ref.watch(apiSignalsProvider).stream.listen((signal) {
      if (signal is StatusStaleSignal && state.hasSession) unawaited(refreshQuietly());
    });
    ref.onDispose(() {
      unawaited(invalidated.cancel());
      unawaited(signals.cancel());
    });
    return const SessionState.unknown();
  }

  TokenStore get _tokens => ref.read(tokenStoreProvider);
  MeSnapshotStore get _snapshots => ref.read(meSnapshotStoreProvider);
  KtaCacheStore get _ktaCache => ref.read(ktaCacheStoreProvider);
  AuthRepository get _auth => ref.read(authRepositoryProvider);
  MeRepository get _meRepo => ref.read(meRepositoryProvider);
  DateTime _now() => ref.read(clockProvider)().toUtc();

  /// Dipanggil saat aplikasi dibuka dan dari tombol "Coba lagi" di splash.
  Future<void> bootstrap() {
    return _loading ??= _guardStorage(_bootstrap).whenComplete(() => _loading = null);
  }

  /// Kegagalan secure storage (PlatformException dari Keystore/Keychain) tidak boleh membuat splash berputar tanpa
  /// jalan keluar: sesi menjadi `unknown` dengan masalah `storage` sehingga splash menampilkan "Coba lagi"
  /// (PRD 4.5, 4.6). Token tidak dihapus karena kegagalan baca.
  Future<void> _guardStorage(Future<void> Function() body) async {
    try {
      await body();
    } on ApiException {
      rethrow;
    } on Object catch (error) {
      debugPrint('sesi: penyimpanan aman perangkat gagal dibaca (${error.runtimeType})');
      if (!state.hasSession) state = const SessionState.unknown(issue: SessionIssue.storage);
    }
  }

  Future<void> _bootstrap() async {
    if (state.phase == SessionPhase.unknown && state.issue != SessionIssue.none) {
      state = const SessionState.unknown();
    }
    final tokens = await _tokens.read();
    if (tokens == null) {
      await _snapshots.clear();
      // Challenge OTP/pemulihan yang sedang berjalan di memori dipertahankan (mis. kembali dari latar belakang).
      if (state.phase != SessionPhase.anonymous) state = const SessionState.anonymous();
      return;
    }
    await _loadMe(fallbackToSnapshot: true);
  }

  /// Memuat ulang /me lalu router mengarahkan ulang sesuai status terbaru (ErrorUiAction.refreshStatus).
  ///
  /// Gagal jaringan saat sesi sudah aktif tidak mengubah sesi; galat dilempar ke pemanggil untuk ditampilkan.
  Future<void> refreshMe() async {
    if (!state.hasSession) return bootstrap();
    final pending = _loading;
    if (pending != null) return pending;
    final future = _loadMe(fallbackToSnapshot: state.isOffline, rethrowErrors: true);
    // Pemanggil lain yang bergabung tidak menerima galat milik pemanggil pertama.
    _loading = future.then<void>((_) {}, onError: (Object _) {}).whenComplete(() => _loading = null);
    return future;
  }

  /// [refreshMe] tanpa melempar galat; dipakai pemicu latar (sinyal status usang, kembali online, event realtime).
  Future<void> refreshQuietly() async {
    try {
      await refreshMe();
    } on ApiException {
      // Kegagalan ditampilkan oleh layar yang memicu request; sesi tidak berubah.
    }
  }

  Future<void> _loadMe({required bool fallbackToSnapshot, bool rethrowErrors = false, String? previousUserId}) async {
    try {
      final me = await _meRepo.getMe();
      await _acceptMe(me, previousUserId: previousUserId);
    } on ApiException catch (error) {
      if (await _tokens.read() == null) {
        // Refresh ditolak server (UNAUTHENTICATED): koordinator sudah menghapus token.
        await _wipePrivateData();
        state = const SessionState.anonymous();
        return;
      }
      final issue = error.isNetwork ? SessionIssue.offline : SessionIssue.serverError;
      if (fallbackToSnapshot) {
        final snapshot = await _safeSnapshot();
        state = snapshot != null
            ? SessionState.offlineLastKnown(snapshot.me, syncedAt: snapshot.fetchedAt, issue: issue)
            : SessionState.unknown(issue: issue);
      }
      if (rethrowErrors) rethrow;
    }
  }

  Future<void> _acceptMe(Me me, {String? previousUserId}) async {
    final previous = previousUserId ?? await _snapshotUserId();
    if (previous != null && previous != me.userId) {
      // Berganti akun: data privat akun sebelumnya tidak boleh tampil (AC F05-3, F13-5).
      await _ktaCache.clear();
      await ref.read(idempotencyStoreProvider).clear();
    }
    if (me.effectiveStatus
        case EffectiveStatus.suspended || EffectiveStatus.disabled || EffectiveStatus.deletionPending) {
      // Kartu offline tidak boleh tampil aktif setelah status dibatasi (AC F05-4).
      await _ktaCache.clear();
    }
    final now = _now();
    try {
      await _snapshots.save(me, now);
    } on Object catch (error) {
      // Snapshot hanya cadangan offline; gagal menyimpannya tidak menghalangi sesi yang sudah divalidasi server.
      debugPrint('sesi: snapshot /me gagal disimpan (${error.runtimeType})');
    }
    state = SessionState.authenticated(me, syncedAt: now);
  }

  /// Pemilik snapshot /me tersimpan. Pada jalur bootstrap token dan snapshot berasal dari sesi yang sama, sehingga
  /// snapshot yang gagal dibaca diperlakukan sebagai tidak ada (bukan pergantian akun).
  Future<String?> _snapshotUserId() async => (await _safeSnapshot())?.me.userId;

  Future<MeSnapshot?> _safeSnapshot() async {
    try {
      return await _snapshots.read();
    } on Object catch (error) {
      debugPrint('sesi: snapshot /me gagal dibaca (${error.runtimeType})');
      return null;
    }
  }

  /// Login alumni (F-02, AC F02-1). Akun pending_otp mendapat challenge OTP baru. Akun deletion_pending dan
  /// disabled tidak mendapat sesi (kontrak C1, PRD 2.2): state tetap anonim dan layar login menampilkan statusnya.
  Future<LoginResult> login({required String email, required String password}) async {
    final response = await _auth.login(email: email, password: password);
    switch (response.next) {
      case LoginNext.verifyOtp:
        final challenge = response.challenge;
        if (challenge == null) throw _invalidResponse('login');
        state = SessionState.anonymous(challenge: challenge);
        return const LoginResult(LoginOutcome.verifyOtp);
      case LoginNext.home:
        final session = response.session;
        if (session == null) throw _invalidResponse('login');
        await _establish(session);
        return const LoginResult(LoginOutcome.signedIn);
      case LoginNext.deletionPending:
        return LoginResult(LoginOutcome.deletionPending, deletion: response.deletion);
      case LoginNext.accountDisabled:
        return const LoginResult(LoginOutcome.accountDisabled);
      case LoginNext.unknown:
        throw _invalidResponse('login');
    }
  }

  /// Menyimpan token sesi baru (login atau OTP pendaftaran terverifikasi) lalu memuat /me.
  Future<void> establishSession(TokenPair pair) => _establish(pair);

  Future<void> _establish(TokenPair pair) async {
    if (pair.refreshToken == null) throw _invalidResponse('session');
    // Snapshot akun sebelumnya tidak boleh menjadi cadangan offline akun baru; id-nya diingat untuk mendeteksi
    // pergantian akun setelah /me dimuat.
    final previousUserId = (await _snapshots.read())?.me.userId;
    await _snapshots.clear();
    await _tokens.save(StoredTokens.received(pair, ref.read(serverClockProvider)));
    state = const SessionState.unknown();
    await _loadMe(fallbackToSnapshot: true, previousUserId: previousUserId);
  }

  /// Challenge OTP yang sedang berjalan (signup setelah register/login, atau password_reset).
  void setChallenge(OtpChallenge challenge) {
    if (state.hasSession) return;
    state = SessionState.anonymous(challenge: challenge, resetToken: state.resetToken);
  }

  /// Token reset sandi sekali pakai dari OTP pemulihan (hanya di memori).
  void setResetToken(String resetToken) {
    if (state.hasSession) return;
    state = SessionState.anonymous(resetToken: resetToken);
  }

  /// Mengakhiri alur challenge/pemulihan tanpa sesi.
  void clearFlow() {
    if (state.hasSession) return;
    state = const SessionState.anonymous();
  }

  /// Keluar dari perangkat ini, atau dari semua perangkat bila [allDevices] (AC F02-6). POST /auth/logout mencabut
  /// sesi dan menonaktifkan token push perangkat (AC F13-5); data lokal tetap dihapus walau server tidak terjangkau.
  ///
  /// Untuk keluar dari semua perangkat, kegagalan server dilempar (pengguna harus tahu sesi lain belum dicabut)
  /// dan sesi lokal tidak diubah.
  Future<void> logout({bool allDevices = false}) async {
    final hasTokens = await _tokens.read() != null;
    if (allDevices) {
      if (hasTokens) await _auth.logoutAll();
    } else {
      try {
        if (hasTokens) await _auth.logout();
      } on ApiException {
        // Best effort: sesi server berakhir sendiri sesuai TTL; token lokal tetap dihapus.
      }
    }
    await _tokens.clear();
    await _wipePrivateData();
    state = const SessionState.anonymous();
  }

  Future<void> _onInvalidated() async {
    await _wipePrivateData();
    state = const SessionState.anonymous();
  }

  Future<void> _wipePrivateData() async {
    await _snapshots.clear();
    await _ktaCache.clear();
    await ref.read(idempotencyStoreProvider).clear();
  }

  static ApiException _invalidResponse(String operation) =>
      ApiException(kind: ApiFailureKind.invalidResponse, operationId: operation);
}
