// Sumber Dart statis (runtime SDK kapdh_api) yang ditulis generator ke lib/src/runtime/.
// Dipisah dari kode terbangkit per skema agar mudah ditinjau; tetap dibangkitkan (tidak di-commit).

export const GENERATED_HEADER = `// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// \`pnpm contracts:gen\` di kapdh-platform.
`;

export const JSON_DART = `${GENERATED_HEADER}
// Pembantu dekode/enkode JSON untuk model terbangkit. Internal paket kapdh_api (tidak diekspor barrel).
// Semua galat bentuk dilaporkan sebagai FormatException beserta jalur field agar mudah dilacak.

import 'optional.dart';

/// Membaca field wajib [key] dengan [decode]; galat bentuk menyertakan nama field.
T readField<T>(Map<String, Object?> json, String key, T Function(Object? value) decode) {
  try {
    return decode(json[key]);
  } on FormatException catch (error) {
    throw FormatException('$key: \${error.message}');
  }
}

/// Membaca field opsional atau nullable; \`null\` bila tidak ada atau bernilai null.
T? readOptionalField<T>(Map<String, Object?> json, String key, T Function(Object? value) decode) {
  final value = json[key];
  if (value == null) return null;
  try {
    return decode(value);
  } on FormatException catch (error) {
    throw FormatException('$key: \${error.message}');
  }
}

/// Membaca field yang opsional sekaligus nullable dengan tiga keadaan (tidak ada, null, nilai).
Optional<T?> readPresentField<T>(Map<String, Object?> json, String key, T Function(Object? value) decode) {
  if (!json.containsKey(key)) return const Optional.absent();
  return Optional<T?>(readOptionalField(json, key, decode));
}

String decodeString(Object? value) {
  if (value is String) return value;
  throw FormatException('diharapkan string, diterima \${_describe(value)}');
}

int decodeInt(Object? value) {
  if (value is int) return value;
  if (value is double && value.isFinite && value == value.truncateToDouble()) return value.toInt();
  throw FormatException('diharapkan bilangan bulat, diterima \${_describe(value)}');
}

double decodeDouble(Object? value) {
  if (value is num) return value.toDouble();
  throw FormatException('diharapkan angka, diterima \${_describe(value)}');
}

bool decodeBool(Object? value) {
  if (value is bool) return value;
  throw FormatException('diharapkan boolean, diterima \${_describe(value)}');
}

/// Waktu RFC 3339 dari server (UTC). Ditampilkan klien dalam Asia/Jakarta (ARCHITECTURE §2 butir 6).
DateTime decodeDateTime(Object? value) {
  final text = decodeString(value);
  final parsed = DateTime.tryParse(text);
  if (parsed == null) throw FormatException('tanggal-waktu RFC 3339 tidak valid: $text');
  return parsed;
}

/// Nilai JSON bebas (skema tanpa tipe), dikembalikan apa adanya.
Object? decodeAny(Object? value) => value;

/// Isi respons biner (mis. berkas ekspor).
List<int> decodeBytes(Object? value) {
  if (value is List<int>) return value;
  throw FormatException('diharapkan data biner, diterima \${_describe(value)}');
}

Map<String, Object?> decodeObject(Object? value) {
  if (value is Map<String, Object?>) return value;
  throw FormatException('diharapkan objek JSON, diterima \${_describe(value)}');
}

/// Array JSON menjadi list tak dapat diubah (model imutabel).
List<T> decodeList<T>(Object? value, T Function(Object? item) decodeItem) {
  if (value is! List<Object?>) {
    throw FormatException('diharapkan array JSON, diterima \${_describe(value)}');
  }
  return List<T>.unmodifiable(<T>[
    for (var i = 0; i < value.length; i++) _at('[$i]', () => decodeItem(value[i])),
  ]);
}

/// Objek JSON berkunci bebas menjadi map tak dapat diubah.
Map<String, T> decodeMap<T>(Object? value, T Function(Object? item) decodeValue) {
  final object = decodeObject(value);
  return Map<String, T>.unmodifiable(<String, T>{
    for (final entry in object.entries) entry.key: _at(entry.key, () => decodeValue(entry.value)),
  });
}

T? decodeNullable<T>(Object? value, T Function(Object? value) decode) => value == null ? null : decode(value);

/// Waktu dikirim selalu dalam UTC RFC 3339 (ARCHITECTURE §2 butir 6).
String encodeDateTime(DateTime value) => value.toUtc().toIso8601String();

R? encodeNullable<T extends Object, R>(T? value, R Function(T value) encode) =>
    value == null ? null : encode(value);

/// Kesamaan struktural untuk list, map dan nilai JSON bebas.
bool deepEquals(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is List<Object?> && b is List<Object?>) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map<Object?, Object?> && b is Map<Object?, Object?>) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !deepEquals(a[key], b[key])) return false;
    }
    return true;
  }
  return a == b;
}

/// Hash yang konsisten dengan [deepEquals].
int deepHash(Object? value) {
  if (value is List<Object?>) return Object.hashAll(value.map(deepHash));
  if (value is Map<Object?, Object?>) {
    // Urutan kunci map tidak memengaruhi kesamaan, sehingga hash entri dijumlahkan.
    var hash = 0;
    for (final entry in value.entries) {
      hash = (hash + Object.hash(deepHash(entry.key), deepHash(entry.value))) & 0x3fffffff;
    }
    return hash;
  }
  return value.hashCode;
}

T _at<T>(String path, T Function() run) {
  try {
    return run();
  } on FormatException catch (error) {
    throw FormatException('$path: \${error.message}');
  }
}

String _describe(Object? value) => value == null ? 'null' : value.runtimeType.toString();
`;

export const OPTIONAL_DART = `${GENERATED_HEADER}
import 'package:meta/meta.dart';

import 'json.dart';

/// Nilai tiga keadaan untuk field body request yang opsional DAN nullable (mis. PATCH profil):
/// [Optional.absent] berarti field tidak dikirim (tidak diubah), \`Optional(null)\` berarti dikirim \`null\`
/// (dikosongkan), dan \`Optional(nilai)\` berarti dikirim nilai tersebut.
@immutable
final class Optional<T> {
  /// Field dikirim dengan [value] (boleh \`null\` bila [T] nullable).
  const Optional(T value)
      : _value = value,
        isPresent = true;

  /// Field tidak dikirim.
  const Optional.absent()
      : _value = null,
        isPresent = false;

  final T? _value;

  /// Apakah field dikirim.
  final bool isPresent;

  /// Nilai field; melempar [StateError] bila [isPresent] false.
  T get value {
    if (!isPresent) throw StateError('Optional.absent tidak memiliki nilai.');
    return _value as T;
  }

  /// Nilai field atau \`null\` bila tidak dikirim.
  T? get valueOrNull => _value;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Optional<T> && other.isPresent == isPresent && deepEquals(other._value, _value);

  @override
  int get hashCode => Object.hash(isPresent, deepHash(_value));

  @override
  String toString() => isPresent ? 'Optional($_value)' : 'Optional.absent()';
}
`;

export const OPTIONS_DART = `${GENERATED_HEADER}
/// Kunci \`RequestOptions.extra\` berisi operationId kontrak setiap request SDK, untuk log dan penyimpanan
/// Idempotency-Key per operasi di interceptor aplikasi (PRD 4.3).
const String kapdhOperationIdKey = 'kapdh.operation_id';

/// Kunci \`RequestOptions.extra\` bernilai \`false\` untuk operasi tanpa bearer (\`security: []\`, mis. login,
/// register, refresh). Interceptor aplikasi tidak menempelkan token dan tidak mencoba refresh saat 401 pada
/// operasi ini (ARCHITECTURE §8.3).
const String kapdhAuthRequiredKey = 'kapdh.auth_required';
`;

export const REQUEST_DART = `${GENERATED_HEADER}
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
`;

export const API_EXCEPTION_DART = `${GENERATED_HEADER}
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:meta/meta.dart';

import '../error_catalog.dart';
import '../models.dart';
import 'json.dart';

/// Jenis kegagalan permintaan API.
enum ApiFailureKind {
  /// Server mengirim galat baku [ApiError] (PRD 5.2); lihat [ApiException.code].
  api,

  /// Tidak ada respons: koneksi gagal, timeout, atau sertifikat. Token sesi TIDAK boleh dihapus karena ini
  /// (ARCHITECTURE §8.3); tampilkan keadaan offline dan coba lagi.
  network,

  /// Permintaan dibatalkan klien (CancelToken).
  cancelled,

  /// Ada respons tetapi bentuknya bukan yang dijanjikan kontrak (mis. halaman HTML 502 dari proxy).
  invalidResponse,
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
      return ApiException(kind: ApiFailureKind.network, operationId: operationId, cause: exception);
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

  /// Status HTTP; null untuk [ApiFailureKind.network] dan [ApiFailureKind.cancelled].
  final int? statusCode;

  /// Body galat baku dari server; hanya ada untuk [ApiFailureKind.api].
  final ApiError? error;

  /// request_id untuk dilaporkan ke pengurus/bantuan (N-14).
  final String? requestId;

  /// Waktu tunggu dari \`retry_after_seconds\` atau header Retry-After (RATE_LIMITED, MAINTENANCE).
  final Duration? retryAfter;

  /// Penyebab asli (DioException/FormatException) untuk diagnosis; jangan ditampilkan ke pengguna.
  final Object? cause;

  /// Kode galat server; null bila bukan [ApiFailureKind.api].
  ErrorCode? get code => error?.code;

  /// Perilaku UI seragam untuk kegagalan ini.
  ErrorUi get ui {
    final apiError = error;
    if (apiError != null) return errorUiFor(apiError.code);
    return clientErrorUi(kind == ApiFailureKind.network ? ClientErrorCode.network : ClientErrorCode.unknown);
  }

  /// Pesan aman untuk pengguna: pesan server bila ada, selain itu pesan cadangan katalog.
  String get message => error?.message ?? ui.fallbackMessage;

  /// Pesan galat per field (kunci bertitik; \`_\` untuk akar).
  Map<String, List<String>> get fieldErrors => error?.fieldErrors ?? const <String, List<String>>{};

  /// Keadaan terbaru objek untuk galat konflik (VERSION_CONFLICT, PAYMENT_STATE_CONFLICT, ...).
  Object? get current => error?.current;

  bool get isNetwork => kind == ApiFailureKind.network;

  bool get isCancelled => kind == ApiFailureKind.cancelled;

  @override
  String toString() =>
      'ApiException(kind: \${kind.name}, operation: $operationId, status: $statusCode, '
      'code: \${error?.code.value}, requestId: $requestId)';

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
`;
