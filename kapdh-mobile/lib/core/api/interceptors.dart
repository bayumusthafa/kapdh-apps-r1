import 'package:dio/dio.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:uuid/uuid.dart';

import '../config/app_info.dart';
import 'api_signals.dart';
import 'refresh_coordinator.dart';

/// Kunci `RequestOptions.extra`: request ini sudah diulang sekali setelah refresh (tidak di-refresh lagi).
const String authRetriedKey = 'kapdh.auth_retried';

/// Header aplikasi di setiap request (PRD 4.5, N-14): versi dan platform untuk gerbang versi minimum, serta
/// `X-Request-Id` (UUID v7) yang menghubungkan log API, worker dan audit. Request yang diulang mempertahankan
/// request id-nya.
class AppHeadersInterceptor extends Interceptor {
  AppHeadersInterceptor(this._info, {Uuid? uuid}) : _uuid = uuid ?? const Uuid();

  final AppInfo _info;
  final Uuid _uuid;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers['X-App-Version'] = _info.version;
    if (_info.platform != DevicePlatform.unknown) {
      options.headers['X-App-Platform'] = _info.platform.toJson();
    }
    options.headers.putIfAbsent('X-Request-Id', _uuid.v7);
    handler.next(options);
  }
}

/// Menempelkan bearer token dan menangani 401 lewat [RefreshCoordinator] (ARCHITECTURE §8.3, AC F02-3).
///
/// Sengaja bukan `QueuedInterceptor`: request paralel yang mendapat 401 ditangani bersamaan dan bergabung pada satu
/// refresh di koordinator, bukan mengantre lalu me-refresh berulang. Operasi publik kontrak (login, register, OTP,
/// refresh, lupa sandi; `kapdhAuthRequiredKey == false`) tidak diberi token dan tidak pernah memicu refresh.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({required Dio dio, required RefreshCoordinator coordinator}) : _dio = dio, _coordinator = coordinator;

  final Dio _dio;
  final RefreshCoordinator _coordinator;

  static bool _authRequired(RequestOptions options) => options.extra[kapdhAuthRequiredKey] != false;

  static String? _bearer(RequestOptions options) {
    final value = options.headers['Authorization'];
    if (value is String && value.startsWith('Bearer ')) return value.substring(7);
    return null;
  }

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    if (!_authRequired(options)) {
      options.headers.remove('Authorization');
      handler.next(options);
      return;
    }
    String? token;
    try {
      // Refresh proaktif bila token hampir habis; gagal jaringan tidak menghentikan request (server menilai).
      token = await _coordinator.validAccessToken(leeway: const Duration(seconds: 10));
    } on ApiException {
      token = await _coordinator.currentAccessToken();
    }
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    } else {
      options.headers.remove('Authorization');
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;
    final rejected = _bearer(options);
    if (err.response?.statusCode != 401 ||
        !_authRequired(options) ||
        options.extra[authRetriedKey] == true ||
        rejected == null) {
      handler.next(err);
      return;
    }

    final String? fresh;
    try {
      fresh = await _coordinator.refreshAfterRejection(rejected);
    } on ApiException catch (refreshError) {
      // Refresh gagal karena jaringan/server: token tetap ada; request asli gagal dengan sebab refresh agar UI
      // menampilkan offline/coba lagi, bukan "sesi berakhir". Diteruskan (bukan reject) agar sinyal global
      // (mis. MAINTENANCE) tetap terpancar.
      handler.next(_fromRefreshFailure(options, refreshError));
      return;
    }
    if (fresh == null) {
      // Sesi tidak berlaku lagi (token sudah dihapus koordinator): teruskan 401 UNAUTHENTICATED asli.
      handler.next(err);
      return;
    }

    // Salinan baru (FormData diklon oleh retryableRequest); request asli tidak diubah. X-Request-Id tetap sama.
    final base = retryableRequest(options);
    final retry = base.copyWith(
      headers: <String, dynamic>{...base.headers, 'Authorization': 'Bearer $fresh'},
      extra: <String, dynamic>{...base.extra, authRetriedKey: true},
    );
    try {
      handler.resolve(await _dio.fetch<Object?>(retry));
    } on DioException catch (retryError) {
      handler.reject(retryError);
    }
  }

  static DioException _fromRefreshFailure(RequestOptions options, ApiException refreshError) {
    final cause = refreshError.cause;
    if (cause is DioException) {
      return DioException(
        requestOptions: options,
        response: cause.response,
        type: cause.type,
        error: cause.error,
        message: cause.message,
      );
    }
    return DioException(requestOptions: options, type: DioExceptionType.unknown, error: refreshError);
  }
}

/// Memetakan galat ke katalog [ErrorUiAction] dan memancarkan sinyal global yang berlaku untuk seluruh aplikasi:
/// maintenance, wajib update, dan status keanggotaan usang (PRD 4.5, 5.2). Galat tetap diteruskan ke pemanggil.
class ErrorSignalsInterceptor extends Interceptor {
  ErrorSignalsInterceptor(this._signals);

  final ApiSignals _signals;

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    if (err.type == DioExceptionType.cancel) {
      handler.next(err);
      return;
    }
    final error = ApiException.fromDio(err, operationId: err.requestOptions.extra[kapdhOperationIdKey] as String?);
    switch (error.ui.action) {
      case ErrorUiAction.showMaintenance:
        _signals.emit(MaintenanceSignal(message: error.error?.message, retryAfter: error.retryAfter));
      case ErrorUiAction.forceUpdate:
        _signals.emit(const UpgradeRequiredSignal());
      case ErrorUiAction.refreshStatus || ErrorUiAction.goToRestricted:
        _signals.emit(const StatusStaleSignal());
      default:
        break;
    }
    handler.next(err);
  }
}
