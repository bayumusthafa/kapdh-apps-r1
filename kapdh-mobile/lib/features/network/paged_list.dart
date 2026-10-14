import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

/// Satu halaman hasil API ber-cursor (`{items, next_cursor, total?}`, ARCHITECTURE §4.10).
@immutable
class PageResult<T> {
  const PageResult(this.items, this.nextCursor, {this.total});

  final List<T> items;
  final String? nextCursor;
  final int? total;
}

/// Keadaan daftar ber-paging keyset untuk layar: pemuatan awal, muat lebih banyak, galat per tahap.
@immutable
class PagedState<T> {
  const PagedState({
    this.items = const [],
    this.nextCursor,
    this.total,
    this.loading = false,
    this.loadingMore = false,
    this.error,
    this.moreError,
    this.loaded = false,
  });

  final List<T> items;
  final String? nextCursor;

  /// Total dari server bila kontrak menyediakannya (direktori, AC F10-1).
  final int? total;

  /// Halaman pertama sedang dimuat (tanpa data sebelumnya yang masih ditampilkan).
  final bool loading;
  final bool loadingMore;

  /// Galat halaman pertama; daftar lama tetap ditampilkan bila ada.
  final ApiException? error;

  /// Galat "muat lebih banyak"; tombol coba lagi di akhir daftar.
  final ApiException? moreError;

  /// Halaman pertama pernah diterima (membedakan kosong dari belum dimuat).
  final bool loaded;

  bool get hasMore => nextCursor != null;

  bool get isEmpty => loaded && items.isEmpty;

  PagedState<T> copyWith({
    List<T>? items,
    String? nextCursor,
    bool clearCursor = false,
    int? total,
    bool? loading,
    bool? loadingMore,
    ApiException? error,
    bool clearError = false,
    ApiException? moreError,
    bool clearMoreError = false,
    bool? loaded,
  }) => PagedState<T>(
    items: items ?? this.items,
    nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
    total: total ?? this.total,
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    error: clearError ? null : (error ?? this.error),
    moreError: clearMoreError ? null : (moreError ?? this.moreError),
    loaded: loaded ?? this.loaded,
  );
}

/// Pengendali daftar keyset: halaman berikut memakai `next_cursor` dari server dan item digabung berdasarkan kunci
/// unik, sehingga tidak ada duplikasi antarhalaman (AC F10-1). Respons yang datang setelah daftar dimulai ulang
/// (filter berubah, tarik untuk muat ulang) dibuang lewat nomor generasi.
abstract class PagedController<T> extends Notifier<PagedState<T>> {
  int _generation = 0;

  /// Mengambil satu halaman; [cursor] null = halaman pertama.
  Future<PageResult<T>> fetchPage(String? cursor);

  /// Kunci unik item untuk deduplikasi.
  String keyOf(T item);

  @override
  PagedState<T> build() {
    // Respons dari build sebelumnya (filter lama) tidak boleh menimpa hasil filter baru.
    _generation++;
    Future.microtask(refresh);
    return const PagedState(loading: true);
  }

  /// Memuat ulang dari halaman pertama. [silent] true mempertahankan daftar lama selama memuat.
  Future<void> refresh({bool silent = false}) async {
    if (!ref.mounted) return;
    final generation = ++_generation;
    state = silent && state.loaded
        ? state.copyWith(clearError: true, clearMoreError: true)
        : PagedState<T>(loading: true, items: state.items, loaded: state.loaded);
    try {
      final page = await fetchPage(null);
      if (!ref.mounted || generation != _generation) return;
      state = PagedState<T>(items: _dedupe(page.items), nextCursor: page.nextCursor, total: page.total, loaded: true);
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      state = state.copyWith(loading: false, error: error);
    }
  }

  /// Memuat halaman berikutnya; diabaikan bila sedang memuat atau sudah habis.
  Future<void> loadMore() async {
    if (!ref.mounted) return;
    final cursor = state.nextCursor;
    if (cursor == null || state.loading || state.loadingMore) return;
    final generation = _generation;
    state = state.copyWith(loadingMore: true, clearMoreError: true);
    try {
      final page = await fetchPage(cursor);
      if (!ref.mounted || generation != _generation) return;
      state = state.copyWith(
        items: _dedupe([...state.items, ...page.items]),
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        total: page.total,
        loadingMore: false,
      );
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      state = state.copyWith(loadingMore: false, moreError: error);
    }
  }

  /// Mengganti/menghapus item lokal setelah mutasi berhasil (mis. buka blokir) tanpa memuat ulang.
  void removeWhere(bool Function(T item) test) {
    final before = state.items.length;
    final items = state.items.where((item) => !test(item)).toList();
    final removed = before - items.length;
    final total = state.total;
    state = state.copyWith(items: items, total: total == null ? null : (total - removed).clamp(0, total));
  }

  void replace(T item) {
    final key = keyOf(item);
    state = state.copyWith(items: [for (final existing in state.items) keyOf(existing) == key ? item : existing]);
  }

  List<T> _dedupe(List<T> items) {
    final seen = <String>{};
    return [
      for (final item in items)
        if (seen.add(keyOf(item))) item,
    ];
  }
}
