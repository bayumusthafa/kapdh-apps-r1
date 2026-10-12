import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/config/api_config.dart';
import 'package:kapdh_mobile/core/config/app_info.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';

/// Identitas build uji: Android 1.2.0.
const testAppInfo = AppInfo(version: '1.2.0', buildNumber: '7', platform: DevicePlatform.android);

/// API uji (pengembangan, http diizinkan).
final testApiConfig = ApiConfig(environment: AppEnvironment.development, baseUri: Uri.parse('http://api.test/api/v1'));

/// Waktu acuan uji: 12 Okt 2026 07.00 UTC (14.00 WIB).
final testNow = DateTime.utc(2026, 10, 12, 7);

/// Jam uji yang dapat dimajukan.
class TestClock {
  TestClock([DateTime? start]) : now = start ?? testNow;

  DateTime now;

  DateTime call() => now;

  void advance(Duration duration) => now = now.add(duration);
}

/// Respons palsu untuk [FakeHttpAdapter].
class FakeResponse {
  FakeResponse.json(this.status, [this.body, Map<String, String>? headers])
    : headers = headers ?? const {},
      networkError = false,
      raw = null;

  FakeResponse.raw(this.status, String this.raw, {Map<String, String>? headers})
    : headers = headers ?? const {},
      networkError = false,
      body = null;

  /// Koneksi gagal (SocketException) tanpa respons.
  FakeResponse.network() : status = 0, body = null, raw = null, headers = const {}, networkError = true;

  final int status;
  final Object? body;
  final String? raw;
  final Map<String, String> headers;
  final bool networkError;
}

typedef FakeHandler = FutureOr<FakeResponse> Function(RequestOptions options);

/// Adapter HTTP terprogram: setiap request dicatat lalu dijawab [handler].
class FakeHttpAdapter implements HttpClientAdapter {
  FakeHttpAdapter(this.handler);

  FakeHandler handler;
  final List<RequestOptions> requests = [];

  /// Request ke [path] (relatif baseUrl).
  List<RequestOptions> requestsTo(String path) => requests.where((r) => r.path == path).toList();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final response = await handler(options);
    if (response.networkError) throw const SocketException('Tidak ada koneksi (uji)');
    final text = response.raw ?? (response.body == null ? '' : jsonEncode(response.body));
    return ResponseBody.fromString(
      text,
      response.status,
      headers: {
        Headers.contentTypeHeader: [response.raw != null ? 'text/html' : Headers.jsonContentType],
        for (final entry in response.headers.entries) entry.key: [entry.value],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

/// Secure storage yang gagal dibaca [failures] kali (Keystore/Keychain sementara tidak tersedia).
class FlakySecureStore implements SecureStore {
  FlakySecureStore(this.inner, {this.failures = 1, this.failingKey = TokenStore.storageKey});

  final MemorySecureStore inner;

  /// Kunci yang pembacaannya gagal (bawaan: token sesi).
  final String failingKey;
  int failures;
  int reads = 0;

  @override
  Future<String?> read(String key) async {
    reads++;
    if (key == failingKey && failures > 0) {
      failures--;
      throw Exception('keystore sementara gagal (uji)');
    }
    return inner.read(key);
  }

  @override
  Future<void> write(String key, String value) => inner.write(key, value);

  @override
  Future<void> delete(String key) => inner.delete(key);
}

/// Kontainer Riverpod uji dengan adapter HTTP, secure storage memori dan jam uji.
ProviderContainer makeContainer({
  HttpClientAdapter? adapter,
  SecureStore? store,
  TestClock? clock,
  List<Override> overrides = const [],
}) {
  final testClock = clock ?? TestClock();
  return ProviderContainer.test(
    retry: (_, _) => null,
    overrides: [
      appInfoProvider.overrideWithValue(testAppInfo),
      apiConfigProvider.overrideWithValue(testApiConfig),
      secureStoreProvider.overrideWithValue(store ?? MemorySecureStore()),
      clockProvider.overrideWithValue(testClock.call),
      httpClientAdapterProvider.overrideWithValue(adapter),
      ...overrides,
    ],
  );
}

String _iso(DateTime value) => value.toUtc().toIso8601String();

Map<String, Object?> tokenPairJson({
  String access = 'access-1',
  String? refresh = 'refresh-1',
  DateTime? accessExpiresAt,
}) => {
  'access_token': access,
  'access_expires_at': _iso(accessExpiresAt ?? testNow.add(const Duration(minutes: 15))),
  'refresh_token': ?refresh,
  'refresh_expires_at': _iso(testNow.add(const Duration(days: 30))),
};

Map<String, Object?> meJson({
  String userId = 'user-1',
  String status = 'verified',
  String fullName = 'Ahmad Islam',
  String? suspensionMessage,
  DateTime? expiresAt,
}) => {
  'user_id': userId,
  'email': 'ahmad.islam@email.com',
  'effective_status': status,
  'member_number': '29.01.01.7',
  'expires_at': ?expiresAt?.toUtc().toIso8601String(),
  'suspension_message': ?suspensionMessage,
  'version': '3',
  'profile': {
    'full_name': fullName,
    'gender': 'male',
    'cohort': 29,
    'class_in': 1,
    'class_out': 6,
    'graduation_year': 2025,
    'entry_year': 2019,
    'exit_year': 2025,
    'education_status': '01',
  },
};

Me meOf({String userId = 'user-1', String status = 'verified', String? suspensionMessage}) =>
    Me.fromJson(meJson(userId: userId, status: status, suspensionMessage: suspensionMessage));

Map<String, Object?> otpChallengeJson({
  String id = 'challenge-1',
  String purpose = 'signup',
  DateTime? expiresAt,
  DateTime? resendAvailableAt,
  int attemptsLeft = 5,
  String emailMasked = 'ahmad.islam@email.com',
}) => {
  'challenge_id': id,
  'purpose': purpose,
  'email_masked': emailMasked,
  'expires_at': _iso(expiresAt ?? testNow.add(const Duration(minutes: 10))),
  'resend_available_at': _iso(resendAvailableAt ?? testNow.add(const Duration(seconds: 42))),
  'attempts_left': attemptsLeft,
};

OtpChallenge challengeOf({
  String id = 'challenge-1',
  OtpPurpose purpose = OtpPurpose.signup,
  DateTime? resendAvailableAt,
  int attemptsLeft = 5,
}) => OtpChallenge.fromJson(
  otpChallengeJson(id: id, purpose: purpose.value, resendAvailableAt: resendAvailableAt, attemptsLeft: attemptsLeft),
);

Map<String, Object?> memberCardJson({
  String status = 'active',
  DateTime? expiresAt,
  DateTime? syncedAt,
  DateTime? qrExpiresAt,
  bool withQr = true,
}) => {
  'status_label': status,
  'member_number': '29.01.01.7',
  'full_name': 'Ahmad Islam',
  'cohort': 29,
  'cohort_code': 'KAPDH 29',
  'graduation_year': 2025,
  'profession_label': 'Guru Bahasa Arab',
  'city': 'Pekanbaru',
  'expires_at': ?expiresAt?.toUtc().toIso8601String(),
  if (withQr)
    'qr': {
      'url': 'https://kapdh.or.id/kta/29.01.01.7#t=token-uji',
      'token_expires_at': _iso(qrExpiresAt ?? (syncedAt ?? testNow).add(const Duration(days: 7))),
    },
  'synced_at': _iso(syncedAt ?? testNow),
};

MemberCard cardOf({
  String status = 'active',
  DateTime? expiresAt,
  DateTime? syncedAt,
  DateTime? qrExpiresAt,
  bool withQr = true,
}) => MemberCard.fromJson(
  memberCardJson(status: status, expiresAt: expiresAt, syncedAt: syncedAt, qrExpiresAt: qrExpiresAt, withQr: withQr),
);

Map<String, Object?> publicConfigJson({
  String android = '1.0.0',
  String ios = '1.0.0',
  bool maintenance = false,
  String? maintenanceMessage,
  DateTime? maintenanceUntil,
  String? androidStore = 'https://play.google.com/store/apps/details?id=id.or.kapdh.app',
  String? supportEmail = 'bantuan@kapdh.or.id',
  String? supportWhatsapp,
}) => {
  'min_app_version': {'android': android, 'ios': ios},
  'maintenance': {
    'active': maintenance,
    'message': ?maintenanceMessage,
    'until': ?maintenanceUntil?.toUtc().toIso8601String(),
  },
  'store_links': {'android': ?androidStore},
  'support': {'email': ?supportEmail, 'whatsapp': ?supportWhatsapp},
};

PublicConfig configOf({
  String android = '1.0.0',
  bool maintenance = false,
  String? maintenanceMessage,
  DateTime? maintenanceUntil,
  String? androidStore = 'https://play.google.com/store/apps/details?id=id.or.kapdh.app',
}) => PublicConfig.fromJson(
  publicConfigJson(
    android: android,
    maintenance: maintenance,
    maintenanceMessage: maintenanceMessage,
    maintenanceUntil: maintenanceUntil,
    androidStore: androidStore,
  ),
);

Map<String, Object?> errorJson(
  String code,
  String message, {
  Map<String, List<String>>? fieldErrors,
  int? retryAfterSeconds,
  Object? current,
}) => {
  'code': code,
  'message': message,
  'request_id': 'req-uji-1',
  'field_errors': ?fieldErrors,
  'retry_after_seconds': ?retryAfterSeconds,
  'current': ?current,
};

/// ApiException dari body galat baku.
ApiException apiError(
  int status,
  String code,
  String message, {
  Map<String, List<String>>? fieldErrors,
  int? retryAfterSeconds,
}) => ApiException.fromResponse(
  statusCode: status,
  data: errorJson(code, message, fieldErrors: fieldErrors, retryAfterSeconds: retryAfterSeconds),
);

/// Kegagalan jaringan tanpa respons.
ApiException networkError() => ApiException(
  kind: ApiFailureKind.network,
  cause: DioException(
    requestOptions: RequestOptions(path: '/'),
    type: DioExceptionType.connectionError,
  ),
);
