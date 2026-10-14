import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../api/api_providers.dart';
import '../storage/secure_store.dart';

/// Cache Beranda terakhir per akun untuk keadaan offline (AC F08-4: "cache lama diberi waktu pembaruan"). Isinya
/// memuat nomor anggota dan jumlah notifikasi (HomeQuickAccess), jadi disimpan di secure storage dan terikat
/// `user_id`: cache akun lain tidak pernah ditampilkan dan langsung dihapus.
///
/// Letaknya di core (bukan fitur Beranda) karena pengendali sesi wajib menghapusnya setiap kali sesi berakhir atau
/// berganti akun, bersama cache KTA dan snapshot /me (PRD 5.2 "logout menghapus cache KTA dan data akun privat"),
/// terlepas dari apakah layar Beranda pernah dibuka.
class HomeCacheStore {
  HomeCacheStore(this._store);

  static const storageKey = 'kapdh.home_cache.v1';

  final SecureStore _store;
  int _clears = 0;

  /// Penanda penghapusan: bertambah setiap [clear]. Pemuat Beranda mencatatnya sebelum GET /home dan menyimpan
  /// dengan `ifEpoch`, sehingga respons yang tiba sesudah logout/pergantian akun tidak menulis ulang cache.
  int get epoch => _clears;

  /// Menyimpan Beranda milik [userId]. Bila [ifEpoch] diisi dan cache sudah dihapus sejak itu, penyimpanan
  /// dibatalkan (PRD 5.2: data akun privat tidak tersisa sesudah logout).
  Future<void> save(String userId, Home home, {int? ifEpoch}) async {
    if (ifEpoch != null && ifEpoch != _clears) return;
    await _store.write(storageKey, jsonEncode(<String, Object?>{'user_id': userId, 'home': home.toJson()}));
  }

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

  /// Menghapus cache; kegagalan penyimpanan perangkat hanya dicatat sehingga logout tidak pernah tertahan.
  Future<void> clear() async {
    _clears++;
    try {
      await _store.delete(storageKey);
    } on Object catch (error) {
      debugPrint('beranda: cache gagal dihapus (${error.runtimeType})');
    }
  }
}

final homeCacheStoreProvider = Provider<HomeCacheStore>((ref) => HomeCacheStore(ref.watch(secureStoreProvider)));
