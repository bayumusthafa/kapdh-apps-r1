import 'package:dio/dio.dart';

/// Galat baku API {code, message, field_errors, request_id} (PRD 5.2).
class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.requestId,
    this.fieldErrors = const {},
    this.retryAfterSeconds,
  });

  final String code;
  final String message;
  final String? requestId;
  final Map<String, List<String>> fieldErrors;
  final int? retryAfterSeconds;

  bool get isNetwork => code == 'NETWORK';

  factory ApiException.fromDio(DioException e) {
    final data = e.response?.data;
    if (data is Map<String, dynamic> && data['code'] is String) {
      final fe = <String, List<String>>{};
      final raw = data['field_errors'];
      if (raw is Map<String, dynamic>) {
        raw.forEach((k, v) => fe[k] = (v as List<dynamic>).map((x) => x.toString()).toList());
      }
      return ApiException(
        code: data['code'] as String,
        message: (data['message'] as String?) ?? fallbackMessage(data['code'] as String),
        requestId: data['request_id'] as String?,
        fieldErrors: fe,
        retryAfterSeconds: data['retry_after_seconds'] as int?,
      );
    }
    // Jaringan putus tidak pernah ditampilkan sebagai "tidak ditemukan" (PRD 4.5).
    return const ApiException(code: 'NETWORK', message: 'Tidak dapat terhubung. Periksa koneksi lalu coba lagi.');
  }

  @override
  String toString() => 'ApiException($code, $requestId)';
}

String fallbackMessage(String code) => switch (code) {
      'VALIDATION_ERROR' => 'Periksa kembali isian yang ditandai.',
      'UNAUTHENTICATED' => 'Sesi berakhir. Silakan masuk kembali.',
      'MEMBERSHIP_REQUIRED' => 'Fitur ini memerlukan KTA aktif.',
      'ACCOUNT_SUSPENDED' => 'Akun Anda sedang dibatasi.',
      'OTP_EXPIRED' => 'Kode tidak berlaku. Minta kode baru.',
      'RATE_LIMITED' => 'Terlalu banyak percobaan. Coba lagi nanti.',
      'FILE_INVALID' => 'Berkas tidak dapat diterima.',
      'MAINTENANCE' => 'Layanan sedang dalam pemeliharaan.',
      _ => 'Terjadi kesalahan. Coba lagi.',
    };
