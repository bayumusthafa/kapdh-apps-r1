import 'package:dio/dio.dart';

import '../auth/token_store.dart';

class ApiConfig {
  /// Jalankan dengan --dart-define=API_BASE_URL=https://api.kapdh.or.id/api/v1 untuk staging/production.
  static const baseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000/api/v1');
}

Dio createApiDio(TokenStore store, {required void Function() onSessionExpired}) {
  final options = BaseOptions(
    baseUrl: ApiConfig.baseUrl,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 20),
    contentType: Headers.jsonContentType,
  );
  final dio = Dio(options);
  // Dio tanpa interceptor untuk refresh dan retry, agar antrean interceptor tidak saling menunggu.
  final plain = Dio(options);
  dio.interceptors.add(AuthInterceptor(plain, store, onSessionExpired));
  return dio;
}

/// Refresh token satu jalur per perangkat: request paralel yang menerima 401 menunggu satu proses refresh
/// yang sama, sehingga refresh token lama tidak dipakai ulang (AC F02-3, PRD 5.2).
class AuthInterceptor extends QueuedInterceptor {
  AuthInterceptor(this._plain, this._store, this._onSessionExpired);

  final Dio _plain;
  final TokenStore _store;
  final void Function() _onSessionExpired;
  Future<bool>? _refreshing;

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _store.accessToken();
    if (token != null) options.headers['Authorization'] = 'Bearer $token';
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode != 401 || err.requestOptions.extra['retried'] == true) {
      handler.next(err);
      return;
    }
    final refreshed = await (_refreshing ??= _refresh().whenComplete(() => _refreshing = null));
    if (!refreshed) {
      _onSessionExpired();
      handler.next(err);
      return;
    }
    final retry = err.requestOptions
      ..extra['retried'] = true
      ..headers['Authorization'] = 'Bearer ${await _store.accessToken()}';
    try {
      handler.resolve(await _plain.fetch<dynamic>(retry));
    } on DioException catch (e) {
      handler.next(e);
    }
  }

  Future<bool> _refresh() async {
    final refreshToken = await _store.refreshToken();
    if (refreshToken == null) return false;
    try {
      final res = await _plain.post<Map<String, dynamic>>('/auth/refresh', data: {'refresh_token': refreshToken});
      final data = res.data!;
      await _store.save(access: data['access_token'] as String, refresh: data['refresh_token'] as String?);
      return true;
    } on DioException {
      await _store.clear();
      return false;
    }
  }
}
