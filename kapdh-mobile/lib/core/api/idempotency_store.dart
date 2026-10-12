import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:uuid/uuid.dart';

import '../config/clock.dart';
import '../storage/secure_store.dart';

/// Kunci Idempotency-Key per niat mutasi yang disimpan lokal sampai hasilnya diketahui (PRD 4.3, AC F01-4, F03-4).
///
/// - Pengulangan setelah jaringan putus, timeout atau aplikasi ditutup memakai key yang SAMA, sehingga server
///   mengembalikan hasil pertama alih-alih membuat akun/pembayaran ganda.
/// - Bila payload berubah, key baru dibuat (key sama dengan payload berbeda = 409 IDEMPOTENCY_CONFLICT).
/// - Key dibuang setelah hasil pasti (sukses atau penolakan 4xx), atau setelah 24 jam (retensi server).
///
/// Disimpan di secure storage karena sidik payload dapat diturunkan dari data pribadi/sandi.
class IdempotencyStore {
  IdempotencyStore(this._store, {Clock clock = systemClock, Uuid? uuid}) : _clock = clock, _uuid = uuid ?? const Uuid();

  static const storageKey = 'kapdh.idempotency.v1';

  /// Retensi key di server (PRD 4.3, usulan 24 jam).
  static const retention = Duration(hours: 24);

  final SecureStore _store;
  final Clock _clock;
  final Uuid _uuid;
  final SerialQueue _queue = SerialQueue();

  /// Key untuk [intent] (mis. `register`, `payment.create.registration`, `payment.proof.<id>`) dan [payload]
  /// (body JSON request). Mengembalikan key tersimpan bila payload sama dan belum kedaluwarsa.
  Future<String> keyFor(String intent, Object? payload) => _queue.run(() async {
    final entries = await _readAll();
    final fingerprint = payloadFingerprint(payload);
    final now = _clock().toUtc();
    final existing = entries[intent];
    if (existing != null &&
        existing.fingerprint == fingerprint &&
        now.difference(existing.createdAt) < retention &&
        !existing.createdAt.isAfter(now.add(const Duration(minutes: 5)))) {
      return existing.key;
    }
    final entry = _Entry(key: _uuid.v4(), fingerprint: fingerprint, createdAt: now);
    entries[intent] = entry;
    await _writeAll(entries);
    return entry.key;
  });

  /// Hasil [intent] sudah pasti: key berikutnya untuk niat ini akan baru.
  Future<void> complete(String intent) => _queue.run(() async {
    final entries = await _readAll();
    if (entries.remove(intent) != null) await _writeAll(entries);
  });

  /// Menghapus semua key (logout / berganti akun).
  Future<void> clear() => _queue.run(() => _store.delete(storageKey));

  /// Menjalankan [operation] dengan key milik [intent]. Key dilepas bila hasil pasti dan dipertahankan bila hasil
  /// belum diketahui (jaringan putus, timeout, 5xx, respons tak sesuai, dibatalkan).
  Future<T> run<T>(String intent, Object? payload, Future<T> Function(String key) operation) async {
    final key = await keyFor(intent, payload);
    try {
      final result = await operation(key);
      await complete(intent);
      return result;
    } on ApiException catch (error) {
      if (isDefinitiveFailure(error)) await complete(intent);
      rethrow;
    }
  }

  /// Penolakan yang pasti tidak memproses mutasi atau key-nya tidak dapat dipakai lagi: galat baku 4xx selain
  /// 408/429 (RATE_LIMITED berarti belum diproses; key yang sama aman dipakai ulang setelah jeda) dan selain
  /// IDEMPOTENCY_CONFLICT. Konflik dengan sidik payload yang sama berarti permintaan pertama dengan key ini masih
  /// diproses server; hasilnya belum diketahui sehingga key dipertahankan (PRD 4.3, 4.5 "Memeriksa status").
  static bool isDefinitiveFailure(ApiException error) {
    if (error.kind != ApiFailureKind.api) return false;
    if (error.code == ErrorCode.idempotencyConflict) return false;
    final status = error.statusCode ?? 0;
    return status >= 400 && status < 500 && status != 408 && status != 429;
  }

  /// SHA-256 atas JSON kanonik (kunci objek diurutkan) dari [payload].
  static String payloadFingerprint(Object? payload) =>
      sha256.convert(utf8.encode(jsonEncode(_canonical(payload)))).toString();

  static Object? _canonical(Object? value) {
    if (value is Map<Object?, Object?>) {
      final byKey = <String, Object?>{for (final e in value.entries) e.key.toString(): e.value};
      final keys = byKey.keys.toList()..sort();
      return <String, Object?>{for (final k in keys) k: _canonical(byKey[k])};
    }
    if (value is Iterable<Object?>) return value.map(_canonical).toList();
    if (value is DateTime) return value.toUtc().toIso8601String();
    return value;
  }

  Future<Map<String, _Entry>> _readAll() async {
    final raw = await _store.read(storageKey);
    if (raw == null) return <String, _Entry>{};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, Object?>) return <String, _Entry>{};
      final result = <String, _Entry>{};
      for (final MapEntry(:key, :value) in decoded.entries) {
        if (value is Map<String, Object?>) {
          final entry = _Entry.tryParse(value);
          if (entry != null) result[key] = entry;
        }
      }
      return result;
    } on FormatException {
      return <String, _Entry>{};
    }
  }

  Future<void> _writeAll(Map<String, _Entry> entries) {
    if (entries.isEmpty) return _store.delete(storageKey);
    return _store.write(storageKey, jsonEncode({for (final e in entries.entries) e.key: e.value.toJson()}));
  }
}

class _Entry {
  const _Entry({required this.key, required this.fingerprint, required this.createdAt});

  static _Entry? tryParse(Map<String, Object?> json) {
    final key = json['key'];
    final fingerprint = json['fp'];
    final at = json['at'];
    if (key is! String || fingerprint is! String || at is! String) return null;
    final createdAt = DateTime.tryParse(at);
    if (createdAt == null) return null;
    return _Entry(key: key, fingerprint: fingerprint, createdAt: createdAt.toUtc());
  }

  final String key;
  final String fingerprint;
  final DateTime createdAt;

  Map<String, Object?> toJson() => {'key': key, 'fp': fingerprint, 'at': createdAt.toIso8601String()};
}
