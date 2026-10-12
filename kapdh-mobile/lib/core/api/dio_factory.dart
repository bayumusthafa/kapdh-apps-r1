import 'package:dio/dio.dart';

import '../config/api_config.dart';
import '../config/app_info.dart';
import 'api_signals.dart';
import 'interceptors.dart';
import 'refresh_coordinator.dart';

BaseOptions _baseOptions(ApiConfig config) => BaseOptions(
      baseUrl: config.baseUrl,
      connectTimeout: const Duration(seconds: 10),
      sendTimeout: const Duration(seconds: 60),
      receiveTimeout: const Duration(seconds: 20),
      contentType: Headers.jsonContentType,
      responseType: ResponseType.json,
    );

/// Dio tanpa auth untuk POST /auth/refresh: hanya header aplikasi. Terpisah dari Dio utama agar refresh tidak
/// melewati interceptor auth (tidak ada rekursi atau antrean saling menunggu).
Dio createBareDio(ApiConfig config, AppInfo info, {HttpClientAdapter? adapter}) {
  final dio = Dio(_baseOptions(config));
  if (adapter != null) dio.httpClientAdapter = adapter;
  dio.interceptors.add(AppHeadersInterceptor(info));
  return dio;
}

/// Dio utama aplikasi untuk `KapdhApi(dio)` (ARCHITECTURE §8.3). Urutan interceptor: header aplikasi, auth +
/// refresh terkoordinasi, lalu sinyal galat global.
Dio createAppDio(
  ApiConfig config,
  AppInfo info, {
  required RefreshCoordinator coordinator,
  required ApiSignals signals,
  HttpClientAdapter? adapter,
}) {
  final dio = Dio(_baseOptions(config));
  if (adapter != null) dio.httpClientAdapter = adapter;
  dio.interceptors.addAll([
    AppHeadersInterceptor(info),
    AuthInterceptor(dio: dio, coordinator: coordinator),
    ErrorSignalsInterceptor(signals),
  ]);
  return dio;
}
