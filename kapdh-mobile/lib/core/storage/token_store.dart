import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import 'secure_store.dart';

/// Pasangan token sesi mobile (PRD 5.2, N-08). Tidak pernah dicatat di log.
@immutable
class StoredTokens {
  const StoredTokens({
    required this.accessToken,
    required this.accessExpiresAt,
    required this.refreshToken,
    this.refreshExpiresAt,
  });

  factory StoredTokens.fromPair(TokenPair pair) => StoredTokens(
        accessToken: pair.accessToken,
        accessExpiresAt: pair.accessExpiresAt.toUtc(),
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpiresAt?.toUtc(),
      );

  factory StoredTokens.fromJson(Map<String, Object?> json) => StoredTokens(
        accessToken: json['access_token']! as String,
        accessExpiresAt: DateTime.parse(json['access_expires_at']! as String).toUtc(),
        refreshToken: json['refresh_token'] as String?,
        refreshExpiresAt: switch (json['refresh_expires_at']) {
          final String v => DateTime.parse(v).toUtc(),
          _ => null,
        },
      );

  final String accessToken;
  final DateTime accessExpiresAt;

  /// Wajib untuk mobile; tanpa refresh token sesi tidak dapat diperpanjang.
  final String? refreshToken;
  final DateTime? refreshExpiresAt;

  Map<String, Object?> toJson() => <String, Object?>{
        'access_token': accessToken,
        'access_expires_at': accessExpiresAt.toUtc().toIso8601String(),
        'refresh_token': refreshToken,
        'refresh_expires_at': refreshExpiresAt?.toUtc().toIso8601String(),
      };

  @override
  String toString() => 'StoredTokens(***)';
}

/// Token sesi di secure storage sebagai SATU nilai JSON (PRD 5.2).
///
/// Access dan refresh token ditulis atomik dalam satu operasi: bila aplikasi mati di tengah penyimpanan, tidak ada
/// keadaan campuran access baru + refresh lama yang pada refresh berikutnya terdeteksi sebagai reuse dan mencabut
/// keluarga sesi (AC F02-3). [clear] hanya menghapus kunci ini, bukan seluruh secure storage.
class TokenStore {
  TokenStore(this._store);

  static const storageKey = 'kapdh.session_tokens.v1';

  final SecureStore _store;
  final SerialQueue _queue = SerialQueue();
  StoredTokens? _cached;
  bool _loaded = false;
  Future<void>? _loading;

  /// Token terakhir yang diketahui; hanya bermakna setelah [load] selesai.
  StoredTokens? get cached => _cached;

  bool get isLoaded => _loaded;

  /// Memuat token dari penyimpanan sekali; pemanggilan berikutnya langsung selesai.
  Future<void> load() {
    if (_loaded) return Future<void>.value();
    return _loading ??= _queue.run(() async {
      if (_loaded) return;
      final raw = await _store.read(storageKey);
      // save()/clear() yang terjadi selama pembacaan lebih baru daripada isi penyimpanan.
      if (_loaded) return;
      _cached = _decode(raw);
      if (raw != null && _cached == null) {
        // Nilai rusak: buang agar tidak dipakai setengah jalan.
        await _store.delete(storageKey);
      }
      _loaded = true;
    });
  }

  Future<StoredTokens?> read() async {
    await load();
    return _cached;
  }

  /// Menyimpan pasangan token. Cache diperbarui sinkron sebelum penulisan agar koordinator refresh selalu melihat
  /// token terbaru (lihat RefreshCoordinator).
  Future<void> save(StoredTokens tokens) {
    _cached = tokens;
    _loaded = true;
    final encoded = jsonEncode(tokens.toJson());
    return _queue.run(() => _store.write(storageKey, encoded));
  }

  Future<void> clear() {
    _cached = null;
    _loaded = true;
    return _queue.run(() => _store.delete(storageKey));
  }

  static StoredTokens? _decode(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final json = jsonDecode(raw);
      if (json is! Map<String, Object?>) return null;
      return StoredTokens.fromJson(json);
    } on Object {
      return null;
    }
  }
}
