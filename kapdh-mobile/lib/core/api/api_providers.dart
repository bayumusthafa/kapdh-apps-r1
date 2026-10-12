import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../config/api_config.dart';
import '../config/app_info.dart';
import '../config/clock.dart';
import '../config/server_clock.dart';
import '../storage/secure_store.dart';
import '../storage/token_store.dart';
import 'api_signals.dart';
import 'dio_factory.dart';
import 'idempotency_store.dart';
import 'refresh_coordinator.dart';

/// Konfigurasi API dari `--dart-define` (ApiConfig.fromEnvironment).
final apiConfigProvider = Provider<ApiConfig>((ref) => ApiConfig.fromEnvironment());

/// Identitas build; WAJIB di-override di bootstrap (package_info_plus) dan di uji.
final appInfoProvider = Provider<AppInfo>(
  (ref) => throw UnimplementedError('appInfoProvider harus di-override saat bootstrap'),
);

final clockProvider = Provider<Clock>((ref) => systemClock);

/// Perkiraan jam server dari header `Date` respons API (PRD 2.1). Dipakai untuk menilai stempel absolut server
/// (kedaluwarsa OTP, masa berlaku token) tanpa bergantung pada jam perangkat yang bisa melenceng.
final serverClockProvider = Provider<ServerClock>((ref) => ServerClock(clock: ref.watch(clockProvider)));

/// Adapter HTTP pengganti untuk uji (null = adapter bawaan dio).
final httpClientAdapterProvider = Provider<HttpClientAdapter?>((ref) => null);

final secureStoreProvider = Provider<SecureStore>((ref) => FlutterSecureStore());

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore(ref.watch(secureStoreProvider)));

final idempotencyStoreProvider = Provider<IdempotencyStore>(
  (ref) => IdempotencyStore(ref.watch(secureStoreProvider), clock: ref.watch(clockProvider)),
);

final apiSignalsProvider = Provider<ApiSignals>((ref) {
  final signals = ApiSignals();
  ref.onDispose(signals.dispose);
  return signals;
});

/// Dio tanpa auth (hanya header aplikasi) untuk POST /auth/refresh.
final bareDioProvider = Provider<Dio>((ref) {
  final dio = createBareDio(
    ref.watch(apiConfigProvider),
    ref.watch(appInfoProvider),
    serverClock: ref.watch(serverClockProvider),
    adapter: ref.watch(httpClientAdapterProvider),
  );
  ref.onDispose(dio.close);
  return dio;
});

/// Koordinator refresh tunggal yang dipakai bersama Dio, Socket.IO dan push (ARCHITECTURE §8.3).
final refreshCoordinatorProvider = Provider<RefreshCoordinator>((ref) {
  final bare = AuthApi(ref.watch(bareDioProvider));
  final coordinator = RefreshCoordinator(
    store: ref.watch(tokenStoreProvider),
    refresher: (refreshToken) => bare.refreshSession(body: RefreshRequest(refreshToken: refreshToken)),
    serverClock: ref.watch(serverClockProvider),
  );
  ref.onDispose(coordinator.dispose);
  return coordinator;
});

/// Dio utama aplikasi.
final dioProvider = Provider<Dio>((ref) {
  final dio = createAppDio(
    ref.watch(apiConfigProvider),
    ref.watch(appInfoProvider),
    coordinator: ref.watch(refreshCoordinatorProvider),
    signals: ref.watch(apiSignalsProvider),
    serverClock: ref.watch(serverClockProvider),
    adapter: ref.watch(httpClientAdapterProvider),
  );
  ref.onDispose(dio.close);
  return dio;
});

/// SDK terbangkit dari kontrak OpenAPI. Repositori fitur membungkus kelas API di sini (PRD 5.2, N-13).
final kapdhApiProvider = Provider<KapdhApi>((ref) => KapdhApi(ref.watch(dioProvider)));
