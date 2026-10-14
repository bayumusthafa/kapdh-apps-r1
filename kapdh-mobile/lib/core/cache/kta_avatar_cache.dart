import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_providers.dart';
import '../storage/secure_store.dart';
import 'kta_cache_store.dart';

/// Cache disk khusus foto KTA milik sendiri (PRD 3.5 "foto jika tersedia", PRD 5.2; AC F05-2, F05-3;
/// ARCHITECTURE §8.3).
///
/// Foto ditampilkan pada KTA offline sehingga perlu tersimpan di perangkat, tetapi foto adalah data pribadi: tidak
/// memakai cache gambar bawaan (umur 30 hari, tidak pernah dihapus saat logout), melainkan cache tersendiri berumur
/// paling lama 7 hari (sama dengan batas KTA offline) yang dikosongkan bersama cache KTA: logout, sesi dicabut,
/// berganti akun, status dibatasi, atau cache KTA tidak sah lagi ([KtaCacheStore.clear]).
///
/// Penanda di secure storage mencatat bahwa cache foto pernah dipakai, sehingga penghapusan setelah aplikasi dibuka
/// ulang tetap terjadi tanpa membuka basis data cache yang belum pernah dibuat.
class KtaAvatarCache {
  KtaAvatarCache(this._store, {BaseCacheManager Function()? createManager})
    : _createManager = createManager ?? _defaultManager;

  /// Kunci penanda di secure storage.
  static const storageKey = 'kapdh.kta_avatar.v1';

  /// Nama cache (basis data dan folder berkas) khusus foto KTA.
  static const cacheName = 'kapdhKtaAvatar';

  static BaseCacheManager _defaultManager() =>
      CacheManager(Config(cacheName, stalePeriod: KtaCacheStore.maxAge, maxNrOfCacheObjects: 4));

  final SecureStore _store;
  final BaseCacheManager Function() _createManager;
  BaseCacheManager? _manager;
  bool _marked = false;

  BaseCacheManager get _cache => _manager ??= _createManager();

  /// Foto KTA dari URL bertanda tangan [url]. [cacheKey] mengikuti akun dan berkas avatar agar foto tetap tampil
  /// offline walau URL bertanda tangan berganti, dan berganti saat avatar diganti.
  ImageProvider imageFor(String url, {String? cacheKey}) {
    if (!_marked) {
      _marked = true;
      unawaited(_mark());
    }
    return CachedNetworkImageProvider(url, cacheKey: cacheKey, cacheManager: _cache);
  }

  Future<void> _mark() async {
    try {
      await _store.write(storageKey, '1');
    } on Object catch (error) {
      debugPrint('kta: penanda cache foto gagal disimpan (${error.runtimeType})');
    }
  }

  /// Mengosongkan cache foto KTA. Tidak pernah melempar: kegagalan dicatat tanpa data pribadi.
  Future<void> clear() async {
    try {
      final used = _manager != null || _marked || await _store.read(storageKey) != null;
      if (!used) return;
      await _cache.emptyCache();
      await _store.delete(storageKey);
      _marked = false;
    } on Object catch (error) {
      debugPrint('kta: cache foto gagal dihapus (${error.runtimeType})');
    }
  }
}

final ktaAvatarCacheProvider = Provider<KtaAvatarCache>((ref) => KtaAvatarCache(ref.watch(secureStoreProvider)));
