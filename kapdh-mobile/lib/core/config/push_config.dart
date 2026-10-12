import 'package:flutter/foundation.dart';

/// Opsi proyek Firebase per lingkungan (PRD 5.3: proyek push staging dan production terpisah). Nilai ini bukan
/// rahasia server, tetapi diisi CI dari `config/<lingkungan>.json` dan tidak disimpan di kode.
@immutable
class FirebaseProjectOptions {
  const FirebaseProjectOptions({
    required this.projectId,
    required this.messagingSenderId,
    required this.apiKey,
    required this.androidAppId,
    required this.iosAppId,
  });

  final String projectId;
  final String messagingSenderId;
  final String apiKey;
  final String androidAppId;
  final String iosAppId;

  /// App ID untuk [platform]; null bila platform tidak didukung atau belum diisi.
  String? appIdFor(TargetPlatform platform) {
    final id = switch (platform) {
      TargetPlatform.android => androidAppId,
      TargetPlatform.iOS => iosAppId,
      _ => '',
    };
    return id.isEmpty ? null : id;
  }
}

/// Konfigurasi push dari `--dart-define` (ARCHITECTURE §8.1, F-13).
///
/// Push bersifat opsional saat runtime: hanya aktif bila `PUSH_ENABLED=true`. Opsi Firebase dibaca dari
/// `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_API_KEY`, `FIREBASE_ANDROID_APP_ID` dan
/// `FIREBASE_IOS_APP_ID`. Bila opsi tidak lengkap, inisialisasi memakai konfigurasi bawaan platform
/// (google-services.json / GoogleService-Info.plist) bila ada; kegagalan apa pun membuat push nonaktif tanpa
/// mengganggu aplikasi (AC F13-2).
@immutable
class PushConfig {
  const PushConfig({required this.enabled, this.firebase});

  const PushConfig.disabled() : this(enabled: false);

  factory PushConfig.fromEnvironment() {
    const enabled = bool.fromEnvironment('PUSH_ENABLED');
    const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
    const senderId = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
    const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
    const androidAppId = String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
    const iosAppId = String.fromEnvironment('FIREBASE_IOS_APP_ID');
    final complete = projectId.isNotEmpty && senderId.isNotEmpty && apiKey.isNotEmpty;
    return PushConfig(
      enabled: enabled,
      firebase: complete
          ? const FirebaseProjectOptions(
              projectId: projectId,
              messagingSenderId: senderId,
              apiKey: apiKey,
              androidAppId: androidAppId,
              iosAppId: iosAppId,
            )
          : null,
    );
  }

  final bool enabled;

  /// Null: pakai konfigurasi bawaan platform bila tersedia.
  final FirebaseProjectOptions? firebase;
}
