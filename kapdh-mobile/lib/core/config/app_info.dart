import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Identitas build yang dikirim di setiap request (`X-App-Version`, `X-App-Platform`; PRD 4.5) dan dipakai
/// gerbang versi minimum. Diisi dari package_info_plus saat bootstrap.
@immutable
class AppInfo {
  const AppInfo({required this.version, required this.buildNumber, required this.platform});

  /// Versi semver tanpa nomor build, mis. `1.0.0` (pola kontrak `X-App-Version`).
  final String version;
  final String buildNumber;

  /// Platform klien mobile; `unknown` untuk uji di desktop/VM.
  final DevicePlatform platform;

  /// Nama perangkat ringkas untuk daftar sesi (F-02); tidak memuat data pribadi.
  String get deviceName => switch (platform) {
    DevicePlatform.android => 'Aplikasi KAPDH Android',
    DevicePlatform.ios => 'Aplikasi KAPDH iOS',
    DevicePlatform.unknown => 'Aplikasi KAPDH',
  };

  static DevicePlatform currentPlatform() {
    if (kIsWeb) return DevicePlatform.unknown;
    return switch (defaultTargetPlatform) {
      TargetPlatform.android => DevicePlatform.android,
      TargetPlatform.iOS => DevicePlatform.ios,
      _ => DevicePlatform.unknown,
    };
  }
}
