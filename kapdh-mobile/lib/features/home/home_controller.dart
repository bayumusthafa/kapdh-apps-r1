import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/session/session_controller.dart';
import '../news/news_controllers.dart';
import 'home_repository.dart';
import 'shared/paged_list.dart';

/// Keadaan Beranda (F-08, AC F08-4).
@immutable
class HomeState {
  const HomeState({this.home, this.fromCache = false, this.loading = false, this.error});

  /// Beranda yang ditampilkan: dari server, atau dari cache bila [fromCache].
  final Home? home;

  /// [home] berasal dari cache lama; waktu pembaruannya `home.generated_at` (waktu server) ditampilkan.
  final bool fromCache;

  /// Sedang memuat dari server (kerangka bila belum ada data, indikator tipis bila menampilkan cache).
  final bool loading;

  /// Galat muat terakhir; bila ada cache, cache tetap tampil dengan pesan dan coba lagi.
  final ApiException? error;
}

final homeControllerProvider = NotifierProvider.autoDispose<HomeController, HomeState>(HomeController.new);

/// Memuat GET /home dengan cadangan cache per akun (AC F08-4): cache tampil lebih dahulu sebagai keadaan "memuat",
/// lalu diganti data server; bila server tidak terjangkau cache tetap tampil dengan waktu pembaruannya.
class HomeController extends Notifier<HomeState> {
  int _generation = 0;

  @override
  HomeState build() {
    // Cache Beranda dihapus pengendali sesi saat logout/berganti akun (SessionController, PRD 5.2), terlepas dari
    // apakah pengendali ini sedang hidup.
    final userId = ref.watch(sessionProvider.select((session) => session.userId));
    // Like dari detail berita langsung tercermin di kartu Beranda (AC F08-3).
    ref.listen(postLikeEventProvider, (previous, event) {
      final home = state.home;
      if (event == null || home == null) return;
      state = HomeState(
        home: Home(
          banners: home.banners,
          upcomingEvents: home.upcomingEvents,
          posts: [for (final post in home.posts) post.slug == event.slug ? postWithLike(post, event.state) : post],
          quickAccess: home.quickAccess,
          generatedAt: home.generatedAt,
        ),
        fromCache: state.fromCache,
        loading: state.loading,
        error: state.error,
      );
    });
    if (userId == null) return const HomeState();
    final generation = ++_generation;
    scheduleMicrotask(() {
      if (ref.mounted && generation == _generation) unawaited(_load(userId, preferCache: true));
    });
    return const HomeState(loading: true);
  }

  /// Muat ulang dari server (tarik untuk menyegarkan, "Coba lagi").
  Future<void> refresh() async {
    final userId = ref.read(sessionProvider).userId;
    if (userId == null) return;
    await _load(userId, preferCache: false);
  }

  Future<void> _load(String userId, {required bool preferCache}) async {
    final generation = ++_generation;
    final cache = ref.read(homeCacheStoreProvider);
    if (preferCache && state.home == null) {
      final cached = await cache.read(userId);
      if (!ref.mounted || generation != _generation) return;
      state = HomeState(home: cached, fromCache: cached != null, loading: true);
    } else {
      state = HomeState(home: state.home, fromCache: state.fromCache, loading: true);
    }
    // Dicatat sebelum request: respons yang tiba sesudah logout menghapus cache tidak menulisnya kembali.
    final epoch = cache.epoch;
    try {
      final home = await ref.read(homeRepositoryProvider).getHome();
      if (!ref.mounted || generation != _generation) return;
      state = HomeState(home: home);
      try {
        await cache.save(userId, home, ifEpoch: epoch);
      } on Object catch (error) {
        debugPrint('beranda: cache gagal disimpan (${error.runtimeType})');
      }
      // Status di ringkasan KTA berbeda dari /me yang dipegang router: muat ulang /me agar navigasi mengikuti
      // status terbaru (PRD 2.2; klien tidak menghitung status sendiri).
      if (ref.mounted && home.quickAccess.effectiveStatus != ref.read(sessionProvider).effectiveStatus) {
        unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
      }
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      final statusChanged = switch (error.ui.action) {
        ErrorUiAction.refreshStatus || ErrorUiAction.goToRestricted => true,
        _ => false,
      };
      // Akses ditolak karena status berubah: cache tidak lagi boleh tampil sebagai Beranda anggota aktif.
      final keep = statusChanged ? null : state.home;
      state = HomeState(home: keep, fromCache: keep != null, error: error);
      reportStatusError(ref, error);
    }
  }
}
