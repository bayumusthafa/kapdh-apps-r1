// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

// Pelaksana request bersama untuk semua kelas API terbangkit. Internal paket kapdh_api.

import 'package:dio/dio.dart';

import 'api_exception.dart';
import 'options.dart';

/// Mengirim satu operasi kontrak lewat [dio] yang diinjeksi aplikasi (interceptor auth/refresh aplikasi tetap
/// berjalan), lalu mendekode body sukses dengan [decode]. Semua kegagalan menjadi [ApiException].
Future<T> sendRequest<T>(
  Dio dio, {
  required String operationId,
  required String method,
  required String path,
  required bool authRequired,
  required T Function(Object? data) decode,
  Map<String, Object?>? queryParameters,
  Map<String, Object?>? headers,
  Object? data,
  ResponseType? responseType,
  CancelToken? cancelToken,
  Options? options,
  ProgressCallback? onSendProgress,
}) async {
  final base = options ?? Options();
  final merged = base.copyWith(
    method: method,
    headers: <String, Object?>{...?base.headers, ...?headers},
    extra: <String, Object?>{
      ...?base.extra,
      kapdhOperationIdKey: operationId,
      kapdhAuthRequiredKey: authRequired,
    },
    responseType: responseType,
  );
  final Response<Object?> response;
  try {
    response = await dio.request<Object?>(
      path,
      data: data,
      queryParameters: queryParameters,
      options: merged,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
    );
  } on DioException catch (error) {
    throw ApiException.fromDio(error, operationId: operationId);
  }
  try {
    return decode(response.data);
  } on FormatException catch (error) {
    throw ApiException(
      kind: ApiFailureKind.invalidResponse,
      operationId: operationId,
      statusCode: response.statusCode,
      requestId: response.headers.value('x-request-id'),
      cause: error,
    );
  }
}
