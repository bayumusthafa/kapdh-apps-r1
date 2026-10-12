import 'package:flutter/foundation.dart';

/// Lingkungan build aplikasi (PRD 5.3): staging dan production memakai API, database, proyek push dan rahasia
/// yang terpisah. `development` hanya untuk emulator/perangkat pengembang terhadap API lokal.
enum AppEnvironment {
  development('development'),
  staging('staging'),
  production('production');

  const AppEnvironment(this.value);

  final String value;

  static AppEnvironment parse(String raw) {
    for (final env in values) {
      if (env.value == raw.trim().toLowerCase()) return env;
    }
    throw ArgumentError.value(raw, 'KAPDH_ENV', 'harus development, staging atau production');
  }
}

/// Konfigurasi API dari `--dart-define` (ARCHITECTURE §8.1, PRD 5.3).
///
/// Lingkungan ("flavor") dipilih saat build dengan berkas di `config/`, bukan flavor Gradle/Xcode, sehingga satu
/// ID aplikasi dipakai dan perintah build sama di Android dan iOS:
///
/// ```bash
/// flutter run --dart-define-from-file=config/development.json
/// flutter build appbundle --dart-define-from-file=config/staging.json
/// flutter build ipa --dart-define-from-file=config/production.json
/// ```
///
/// Kunci yang dibaca di sini:
/// - `KAPDH_ENV`: development | staging | production (bawaan development).
/// - `API_BASE_URL`: URL API lengkap berakhiran `/api/v1`. Bila kosong dipakai bawaan per lingkungan.
///
/// Push dikonfigurasi terpisah oleh `PushConfig` (`PUSH_ENABLED`, `FIREBASE_*`).
@immutable
class ApiConfig {
  ApiConfig({required this.environment, required this.baseUri}) {
    if (!baseUri.path.endsWith('/api/v1')) {
      throw ArgumentError.value(baseUri.toString(), 'API_BASE_URL', 'harus berakhiran /api/v1');
    }
    // Transport wajib HTTPS di luar pengembangan lokal (N-07).
    if (environment != AppEnvironment.development && baseUri.scheme != 'https') {
      throw ArgumentError.value(baseUri.toString(), 'API_BASE_URL', 'staging/production wajib https');
    }
  }

  factory ApiConfig.fromEnvironment() {
    const rawEnv = String.fromEnvironment('KAPDH_ENV', defaultValue: 'development');
    const rawBase = String.fromEnvironment('API_BASE_URL');
    final environment = AppEnvironment.parse(rawEnv);
    final base = rawBase.isNotEmpty ? rawBase : defaultBaseUrl(environment);
    return ApiConfig(environment: environment, baseUri: Uri.parse(base));
  }

  /// URL bawaan per lingkungan (kontrak OpenAPI `servers`). `10.0.2.2` adalah alamat komputer dari emulator
  /// Android; perangkat fisik memakai `API_BASE_URL` berisi IP komputer di jaringan lokal.
  static String defaultBaseUrl(AppEnvironment environment) => switch (environment) {
    AppEnvironment.development => 'http://10.0.2.2:3000/api/v1',
    AppEnvironment.staging => 'https://staging-api.kapdh.or.id/api/v1',
    AppEnvironment.production => 'https://api.kapdh.or.id/api/v1',
  };

  final AppEnvironment environment;
  final Uri baseUri;

  String get baseUrl => baseUri.toString();

  /// Origin API (skema, host, port) tempat namespace Socket.IO `/realtime` berada (ARCHITECTURE §4.9).
  Uri get realtimeUri =>
      Uri(scheme: baseUri.scheme, host: baseUri.host, port: baseUri.hasPort ? baseUri.port : null, path: '/realtime');

  /// Path engine Socket.IO di server (bawaan Socket.IO).
  String get realtimePath => '/socket.io';
}
