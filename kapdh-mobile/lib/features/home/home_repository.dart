import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';

// Cache Beranda per akun (AC F08-4) dihapus pengendali sesi saat logout/berganti akun (PRD 5.2), jadi tinggal di core.
export '../../core/cache/home_cache_store.dart' show HomeCacheStore, homeCacheStoreProvider;

/// Repositori Beranda (F-08): satu panggilan GET /home.
class HomeRepository {
  HomeRepository(this._content);

  final ContentApi _content;

  Future<Home> getHome() => _content.getHome();
}

final homeRepositoryProvider = Provider<HomeRepository>((ref) => HomeRepository(ref.watch(kapdhApiProvider).content));
