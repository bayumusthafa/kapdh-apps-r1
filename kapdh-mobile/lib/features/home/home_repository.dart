import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/storage/secure_store.dart';

/// Cache Beranda terakhir per akun untuk keadaan offline (AC F08-4: "cache lama diberi waktu pembaruan"). Isinya
/// memuat nomor anggota dan jumlah notifikasi (HomeQuickAccess), jadi disimpan di secure storage dan terikat
/// `user_id`: cache akun lain tidak pernah ditampilkan dan langsung dihapus (PRD 5.2).
class HomeCacheStore {
  HomeCacheStore(this._store);

  static const storageKey = 'kapdh.home_cache.v1';

  final SecureStore _store;

  Future<void> save(String userId, Home home) =>
      _store.write(storageKey, jsonEncode(<String, Object?>{'user_id': userId, 'home': home.toJson()}));

  /// Beranda tersimpan milik [userId]; null bila tidak ada, milik akun lain, atau rusak.
  Future<Home?> read(String userId) async {
    final String? raw;
    try {
      raw = await _store.read(storageKey);
    } on Object catch (error) {
      // Cache hanya cadangan offline; kegagalan Keystore/Keychain tidak menghalangi Beranda dari server.
      debugPrint('beranda: cache gagal dibaca (${error.runtimeType})');
      return null;
    }
    if (raw == null) return null;
    try {
      final json = jsonDecode(raw) as Map<String, Object?>;
      if (json['user_id'] != userId) {
        await clear();
        return null;
      }
      return Home.fromJson(json['home']! as Map<String, Object?>);
    } on Object {
      await clear();
      return null;
    }
  }

  Future<void> clear() async {
    try {
      await _store.delete(storageKey);
    } on Object catch (error) {
      debugPrint('beranda: cache gagal dihapus (${error.runtimeType})');
    }
  }
}

final homeCacheStoreProvider = Provider<HomeCacheStore>((ref) => HomeCacheStore(ref.watch(secureStoreProvider)));

/// Repositori Beranda (F-08): satu panggilan GET /home.
class HomeRepository {
  HomeRepository(this._content);

  final ContentApi _content;

  Future<Home> getHome() => _content.getHome();
}

final homeRepositoryProvider = Provider<HomeRepository>((ref) => HomeRepository(ref.watch(kapdhApiProvider).content));
