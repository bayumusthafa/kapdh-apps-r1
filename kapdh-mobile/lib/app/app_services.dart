import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../core/api/api_providers.dart';
import '../core/config/push_config.dart';
import '../core/push/push_platform.dart';
import '../core/push/push_service.dart';
import '../core/realtime/realtime_client.dart';
import '../core/session/session_controller.dart';
import '../core/session/session_state.dart';
import 'router.dart';

/// Konfigurasi push dari `--dart-define` (PUSH_ENABLED, FIREBASE_*).
final pushConfigProvider = Provider<PushConfig>((ref) => PushConfig.fromEnvironment());

final pushPlatformProvider = Provider<PushPlatform>((ref) => FirebasePushPlatform(ref.watch(pushConfigProvider)));

/// Layanan push (F-13). Ketukan notifikasi membuka router; redirect memeriksa sesi dulu (AC F13-3).
final pushServiceProvider = Provider<PushService>((ref) {
  final service = PushService(
    platform: ref.watch(pushPlatformProvider),
    registerDevice: (request) => ref.read(kapdhApiProvider).notifications.registerDevice(request),
    info: ref.watch(appInfoProvider),
    openLocation: (location) => ref.read(routerProvider).go(location.toString()),
  );
  ref.onDispose(() => unawaited(service.dispose()));
  return service;
});

/// Klien realtime `/realtime` yang berbagi koordinator refresh dengan HTTP (ARCHITECTURE §4.9, §8.3).
final realtimeClientProvider = Provider<RealtimeClient>((ref) {
  final client = RealtimeClient(
    config: ref.watch(apiConfigProvider),
    coordinator: ref.watch(refreshCoordinatorProvider),
  );
  ref.onDispose(() => unawaited(client.dispose()));
  return client;
});

/// Status yang memakai koneksi realtime: notifikasi, pencabutan sesi dan (untuk anggota aktif) chat.
bool shouldConnectRealtime(SessionState session) =>
    session.phase == SessionPhase.authenticated &&
    switch (session.effectiveStatus) {
      EffectiveStatus.unverified ||
      EffectiveStatus.verified ||
      EffectiveStatus.expiring ||
      EffectiveStatus.expired => true,
      _ => false,
    };

/// Status yang mendaftarkan token push: semua sesi aktif kecuali akun nonaktif/dihapus dan status tak dikenal.
bool shouldRegisterPush(SessionState session) =>
    session.phase == SessionPhase.authenticated &&
    switch (session.effectiveStatus) {
      EffectiveStatus.unverified ||
      EffectiveStatus.verified ||
      EffectiveStatus.expiring ||
      EffectiveStatus.expired ||
      EffectiveStatus.suspended => true,
      _ => false,
    };

/// Mengikat push dan realtime ke sesi: daftar saat masuk, hapus token saat keluar/berganti akun (AC F13-5), sambung
/// realtime hanya untuk sesi aktif, dan muat ulang /me saat server mengirim `session.revoked` (AC F02-6).
final sessionServicesProvider = Provider<void>((ref) {
  final push = ref.watch(pushServiceProvider);
  final realtime = ref.watch(realtimeClientProvider);
  var pushChain = Future<void>.value();
  String? pushUser;

  void apply(SessionState next) {
    // Push: berurutan agar hapus token akun lama selesai sebelum token akun baru didaftarkan.
    final wantPush = shouldRegisterPush(next) ? next.userId : null;
    final keepCurrent = wantPush == null && next.isOffline && next.userId == pushUser;
    if (wantPush != pushUser && !keepCurrent) {
      final previous = pushUser;
      pushUser = wantPush;
      pushChain = pushChain.then((_) async {
        if (previous != null) await push.onSignedOut();
        if (wantPush != null) await push.onSignedIn();
      });
    }
    // Realtime.
    if (shouldConnectRealtime(next)) {
      realtime.start();
    } else if (!next.isOffline) {
      realtime.stop();
    }
  }

  ref.listen<SessionState>(sessionProvider, (_, next) => apply(next), fireImmediately: true);
  final revoked = realtime.on<SessionRevokedEvent>().listen(
    (_) => unawaited(ref.read(sessionProvider.notifier).refreshQuietly()),
  );
  ref.onDispose(() => unawaited(revoked.cancel()));

  // Koneksi kembali: ganti snapshot offline dengan status server terbaru (AC F05-4) atau ulangi bootstrap yang
  // gagal karena offline. Koneksi hanya petunjuk; request yang gagal tetap sumber kebenaran.
  ref.listen<AsyncValue<bool>>(connectivityOnlineProvider, (previous, next) {
    if (next.value != true || previous?.value == true) return;
    final session = ref.read(sessionProvider);
    final controller = ref.read(sessionProvider.notifier);
    if (session.isOffline) {
      unawaited(controller.refreshQuietly());
    } else if (session.phase == SessionPhase.unknown && session.issue != SessionIssue.none) {
      unawaited(controller.bootstrap());
    }
  });
});

/// Petunjuk konektivitas perangkat (connectivity_plus); true bila ada jaringan apa pun.
final connectivityOnlineProvider = StreamProvider<bool>(
  (ref) => Connectivity().onConnectivityChanged.map((results) => results.any((r) => r != ConnectivityResult.none)),
);
