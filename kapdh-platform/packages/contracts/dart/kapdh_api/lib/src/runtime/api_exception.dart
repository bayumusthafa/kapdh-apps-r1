// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:meta/meta.dart';

import '../error_catalog.dart';
import '../models.dart';
import 'io_failure.dart' if (dart.library.io) 'io_failure_io.dart';
import 'json.dart';

/// Jenis kegagalan permintaan API.
enum ApiFailureKind {
  /// Server mengirim galat baku [ApiError] (PRD 5.2); lihat [ApiException.code].
  api,

  /// Tidak ada respons karena koneksi gagal atau habis waktu (connectionError, connectionTimeout, sendTimeout,
  /// receiveTimeout, atau galat I/O soket/HTTP/TLS). Token sesi TIDAK boleh dihapus karena ini (ARCHITECTURE §8.3);
  /// tampilkan keadaan offline dan coba lagi.
  network,

  /// Permintaan dibatalkan klien (CancelToken).
  cancelled,

  /// Ada respons tetapi bentuknya bukan yang dijanjikan kontrak (mis. halaman HTML 502 dari proxy).
  invalidResponse,

  /// Kegagalan tak terduga di sisi klien tanpa respons: galat pemrograman atau keadaan (mis. body yang sudah
  /// difinalisasi dikirim ulang), interceptor aplikasi yang menolak tanpa respons, atau sertifikat TLS yang ditolak
  /// (badCertificate). Bukan masalah jaringan sehingga tidak ditampilkan sebagai offline; catat [ApiException.cause].
  unexpected,
}

/// Kegagalan setiap operasi SDK. Pemetaan ke perilaku UI memakai katalog tunggal [errorUiFor] (PRD 5.2).
@immutable
final class ApiException implements Exception {
  const ApiException({
    required this.kind,
    this.operationId,
    this.statusCode,
    this.error,
    this.requestId,
    this.retryAfter,
    this.cause,
  });

  /// Mengubah [DioException] menjadi [ApiException].
  factory ApiException.fromDio(DioException exception, {String? operationId}) {
    if (exception.type == DioExceptionType.cancel) {
      return ApiException(kind: ApiFailureKind.cancelled, operationId: operationId, cause: exception);
    }
    final response = exception.response;
    if (response == null) {
      return ApiException(
        kind: _isNetworkFailure(exception) ? ApiFailureKind.network : ApiFailureKind.unexpected,
        operationId: operationId,
        cause: exception,
      );
    }
    return ApiException.fromResponse(
      statusCode: response.statusCode,
      data: response.data,
      requestIdHeader: response.headers.value('x-request-id'),
      retryAfterHeader: response.headers.value('retry-after'),
      operationId: operationId,
      cause: exception,
    );
  }

  /// Membentuk [ApiException] dari respons galat mentah (body Error baku atau bukan).
  factory ApiException.fromResponse({
    required int? statusCode,
    required Object? data,
    String? requestIdHeader,
    String? retryAfterHeader,
    String? operationId,
    Object? cause,
  }) {
    final apiError = _parseError(data);
    final headerRetry = _parseRetryAfter(retryAfterHeader);
    if (apiError == null) {
      return ApiException(
        kind: ApiFailureKind.invalidResponse,
        operationId: operationId,
        statusCode: statusCode,
        requestId: requestIdHeader,
        retryAfter: headerRetry,
        cause: cause,
      );
    }
    final bodyRetry = apiError.retryAfterSeconds;
    return ApiException(
      kind: ApiFailureKind.api,
      operationId: operationId,
      statusCode: statusCode,
      error: apiError,
      requestId: apiError.requestId,
      retryAfter: bodyRetry != null ? Duration(seconds: bodyRetry) : headerRetry,
      cause: cause,
    );
  }

  final ApiFailureKind kind;

  /// operationId kontrak yang gagal, bila diketahui.
  final String? operationId;

  /// Status HTTP; null untuk [ApiFailureKind.network], [ApiFailureKind.cancelled] dan [ApiFailureKind.unexpected].
  final int? statusCode;

  /// Body galat baku dari server; hanya ada untuk [ApiFailureKind.api].
  final ApiError? error;

  /// request_id untuk dilaporkan ke pengurus/bantuan (N-14).
  final String? requestId;

  /// Waktu tunggu dari `retry_after_seconds` atau header Retry-After (RATE_LIMITED, MAINTENANCE).
  final Duration? retryAfter;

  /// Penyebab asli (DioException/FormatException) untuk diagnosis; jangan ditampilkan ke pengguna.
  final Object? cause;

  /// Kode galat server; null bila bukan [ApiFailureKind.api].
  ErrorCode? get code => error?.code;

  /// Perilaku UI seragam untuk kegagalan ini: kode server lewat [errorUiFor]; tanpa body Error, jaringan memakai
  /// [ClientErrorCode.network] dan selainnya (respons tak sesuai, kegagalan tak terduga) [ClientErrorCode.unknown].
  ErrorUi get ui {
    final apiError = error;
    if (apiError != null) return errorUiFor(apiError.code);
    return clientErrorUi(kind == ApiFailureKind.network ? ClientErrorCode.network : ClientErrorCode.unknown);
  }

  /// Pesan aman untuk pengguna: pesan server bila ada, selain itu pesan cadangan katalog.
  String get message => error?.message ?? ui.fallbackMessage;

  /// Pesan galat per field (kunci bertitik; `_` untuk akar).
  Map<String, List<String>> get fieldErrors => error?.fieldErrors ?? const <String, List<String>>{};

  /// Keadaan terbaru objek untuk galat konflik (VERSION_CONFLICT, PAYMENT_STATE_CONFLICT, ...).
  Object? get current => error?.current;

  bool get isNetwork => kind == ApiFailureKind.network;

  bool get isCancelled => kind == ApiFailureKind.cancelled;

  @override
  String toString() =>
      'ApiException(kind: ${kind.name}, operation: $operationId, status: $statusCode, '
      'code: ${error?.code.value}, requestId: $requestId)';

  /// Hanya kegagalan koneksi/timeout yang dianggap jaringan (PRD 4.5: offline tidak mengeluarkan pengguna).
  /// [DioExceptionType.unknown] hanya jaringan bila penyebabnya galat I/O (SocketException, HttpException,
  /// HandshakeException) atau TimeoutException; selain itu galat pemrograman/interceptor yang tidak boleh
  /// disamarkan sebagai offline dan diulang terus.
  static bool _isNetworkFailure(DioException exception) => switch (exception.type) {
        DioExceptionType.connectionTimeout ||
        DioExceptionType.sendTimeout ||
        DioExceptionType.receiveTimeout ||
        DioExceptionType.connectionError =>
          true,
        DioExceptionType.unknown => exception.error is TimeoutException || isIoFailure(exception.error),
        _ => false,
      };

  static ApiError? _parseError(Object? data) {
    Object? body = data;
    try {
      if (body is List<int>) body = utf8.decode(body);
      if (body is String) body = body.isEmpty ? null : jsonDecode(body);
    } on FormatException {
      return null;
    }
    if (body is! Map<String, Object?> || body['code'] is! String || body['message'] is! String) return null;
    try {
      return ApiError.fromJson(decodeObject(body));
    } on FormatException {
      return null;
    }
  }

  static Duration? _parseRetryAfter(String? header) {
    if (header == null) return null;
    final seconds = int.tryParse(header.trim());
    return seconds == null || seconds < 0 ? null : Duration(seconds: seconds);
  }
}
