import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../config/server_clock.dart';
import 'secure_store.dart';

/// Pasangan token sesi mobile (PRD 5.2, N-08). Tidak pernah dicatat di log.
@immutable
class StoredTokens {
  const StoredTokens({
    required this.accessToken,
    required this.accessExpiresAt,
    required this.refreshToken,
    this.refreshExpiresAt,
    DateTime? deviceExpiresAt,
    this.clockSkewSuspected = false,
  }) : _deviceExpiresAt = deviceExpiresAt;

  /// Pasangan dari server dengan asumsi jam perangkat sama dengan jam server (uji dan data lama).
  factory StoredTokens.fromPair(TokenPair pair) => StoredTokens(
    accessToken: pair.accessToken,
    accessExpiresAt: pair.accessExpiresAt.toUtc(),
    refreshToken: pair.refreshToken,
    refreshExpiresAt: pair.refreshExpiresAt?.toUtc(),
  );

  /// Pasangan yang BARU diterima dari server (login, OTP, refresh). Masa berlaku access token dihitung relatif
  /// terhadap jam server saat diterima, lalu dipetakan ke jam perangkat; refresh proaktif membandingkan waktu itu
  /// dengan jam perangkat sehingga selisih jam perangkat-server tidak memicu refresh pada setiap request
  /// (PRD 2.1, 5.2; AC F02-1, F02-3).
  ///
  /// Bila jam server belum diketahui (tanpa header `Date`) dan token baru tampak hampir habis menurut jam perangkat,
  /// jam perangkat dianggap melenceng: refresh proaktif dimatikan untuk pasangan ini dan hanya jalur 401 yang
  /// me-refresh.
  factory StoredTokens.received(TokenPair pair, ServerClock clock) {
    final validFor = pair.accessExpiresAt.toUtc().difference(clock.now());
    return StoredTokens(
      accessToken: pair.accessToken,
      accessExpiresAt: pair.accessExpiresAt.toUtc(),
      refreshToken: pair.refreshToken,
      refreshExpiresAt: pair.refreshExpiresAt?.toUtc(),
      deviceExpiresAt: clock.deviceNow().add(validFor),
      clockSkewSuspected: !clock.isSynced && validFor < minPlausibleAccessTtl,
    );
  }

  factory StoredTokens.fromJson(Map<String, Object?> json) => StoredTokens(
    accessToken: json['access_token']! as String,
    accessExpiresAt: DateTime.parse(json['access_expires_at']! as String).toUtc(),
    refreshToken: json['refresh_token'] as String?,
    refreshExpiresAt: switch (json['refresh_expires_at']) {
      final String v => DateTime.parse(v).toUtc(),
      _ => null,
    },
    deviceExpiresAt: switch (json['access_expires_at_device']) {
      final String v => DateTime.parse(v).toUtc(),
      _ => null,
    },
    clockSkewSuspected: json['clock_skew_suspected'] == true,
  );

  /// Token baru yang masa berlakunya kurang dari ini menurut jam perangkat menandakan jam perangkat melenceng (TTL
  /// access token server 15 menit, N-08).
  static const minPlausibleAccessTtl = Duration(minutes: 1);

  final String accessToken;

  /// Stempel `access_expires_at` dari server (jam server).
  final DateTime accessExpiresAt;

  /// Wajib untuk mobile; tanpa refresh token sesi tidak dapat diperpanjang.
  final String? refreshToken;
  final DateTime? refreshExpiresAt;

  final DateTime? _deviceExpiresAt;

  /// Jam perangkat tidak dapat dipercaya untuk pasangan ini; refresh proaktif dimatikan.
  final bool clockSkewSuspected;

  /// Batas berlaku access token menurut jam perangkat untuk refresh proaktif; null bila tidak dapat diperkirakan
  /// (refresh hanya setelah server menolak dengan 401).
  DateTime? get deviceExpiresAt => clockSkewSuspected ? null : (_deviceExpiresAt ?? accessExpiresAt);

  Map<String, Object?> toJson() => <String, Object?>{
    'access_token': accessToken,
    'access_expires_at': accessExpiresAt.toUtc().toIso8601String(),
    'refresh_token': refreshToken,
    'refresh_expires_at': refreshExpiresAt?.toUtc().toIso8601String(),
    'access_expires_at_device': _deviceExpiresAt?.toUtc().toIso8601String(),
    if (clockSkewSuspected) 'clock_skew_suspected': true,
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
  ///
  /// Kegagalan membaca secure storage (mis. Keystore/Keychain sementara tidak tersedia) diteruskan ke pemanggil dan
  /// TIDAK disimpan: pemanggilan berikutnya membaca penyimpanan lagi, sehingga tombol "Coba lagi" di splash dapat
  /// pulih tanpa memulai ulang aplikasi. Token tidak dihapus karena kegagalan baca.
  Future<void> load() {
    if (_loaded) return Future<void>.value();
    final existing = _loading;
    if (existing != null) return existing;
    final future = _queue.run(() async {
      if (_loaded) return;
      final raw = await _store.read(storageKey);
      // save()/clear() yang terjadi selama pembacaan lebih baru daripada isi penyimpanan.
      if (_loaded) return;
      _cached = _decode(raw);
      if (raw != null && _cached == null) {
        // Nilai rusak (bukan gagal baca): buang agar tidak dipakai setengah jalan.
        await _store.delete(storageKey);
      }
      _loaded = true;
    });
    _loading = future;
    future.then<void>((_) {}, onError: (Object _) {}).whenComplete(() {
      if (identical(_loading, future)) _loading = null;
    });
    return future;
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
