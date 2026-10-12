import 'package:dio/dio.dart';

import '../api/api_exception.dart';

class OtpChallenge {
  const OtpChallenge({required this.challengeId, required this.expiresAt, required this.resendAvailableAt, required this.attemptsLeft, this.emailMasked});

  factory OtpChallenge.fromJson(Map<String, dynamic> j) => OtpChallenge(
        challengeId: j['challenge_id'] as String,
        expiresAt: DateTime.parse(j['expires_at'] as String),
        resendAvailableAt: DateTime.parse(j['resend_available_at'] as String),
        attemptsLeft: j['attempts_left'] as int,
        emailMasked: j['email_masked'] as String?,
      );

  final String challengeId;
  final DateTime expiresAt;
  final DateTime resendAvailableAt;
  final int attemptsLeft;
  final String? emailMasked;
}

class RegisterInput {
  const RegisterInput({
    required this.fullName,
    required this.gender,
    required this.email,
    required this.password,
    required this.cohort,
    required this.classIn,
    required this.classOut,
    required this.policyVersion,
  });

  final String fullName;
  final String gender; // male | female
  final String email;
  final String password;
  final int cohort;
  final int classIn;
  final int classOut;
  final String policyVersion;

  Map<String, dynamic> toJson() => {
        'full_name': fullName.trim(),
        'gender': gender,
        'email': email.trim(),
        'password': password,
        'cohort': cohort,
        'class_in': classIn,
        'class_out': classOut,
        'accept_policy_version': policyVersion,
      };
}

class TokenPair {
  const TokenPair(this.accessToken, this.refreshToken);
  factory TokenPair.fromJson(Map<String, dynamic> j) => TokenPair(j['access_token'] as String, j['refresh_token'] as String?);
  final String accessToken;
  final String? refreshToken;
}

/// Pemanggilan endpoint auth dari kontrak OpenAPI. Diganti klien terbangkit `kapdh_api` setelah tersedia.
class AuthApi {
  AuthApi(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  Future<OtpChallenge> register(RegisterInput input, {required String idempotencyKey}) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/auth/register',
            data: input.toJson(), options: Options(headers: {'Idempotency-Key': idempotencyKey}));
        return OtpChallenge.fromJson(res.data!);
      });

  Future<TokenPair> verifySignupOtp(String challengeId, String code) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/auth/otp/verify', data: {'challenge_id': challengeId, 'code': code});
        return TokenPair.fromJson(res.data!['session'] as Map<String, dynamic>);
      });

  Future<OtpChallenge> resendOtp(String challengeId) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/auth/otp/resend', data: {'challenge_id': challengeId});
        return OtpChallenge.fromJson(res.data!);
      });

  /// Mengembalikan token (login normal) atau challenge (akun masih pending_otp).
  Future<(TokenPair?, OtpChallenge?)> login(String email, String password) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/auth/login', data: {'email': email.trim(), 'password': password});
        final d = res.data!;
        if (d['next'] == 'verify_otp') return (null, OtpChallenge.fromJson(d['challenge'] as Map<String, dynamic>));
        return (TokenPair.fromJson(d['session'] as Map<String, dynamic>), null);
      });

  Future<Map<String, dynamic>> me() => _call(() async => (await _dio.get<Map<String, dynamic>>('/me')).data!);

  Future<void> logout() => _call(() async {
        await _dio.post<void>('/auth/logout');
      });
}
