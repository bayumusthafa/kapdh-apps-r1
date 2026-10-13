import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/session/session_controller.dart';
import '../../../design/design.dart';

/// Satu halaman keyset dari API (`{items, next_cursor}`, ARCHITECTURE §4.10).
typedef CursorPage<T> = ({List<T> items, String? nextCursor});

/// Keadaan daftar berhalaman: memuat, kosong, galat, berhasil, memuat berikutnya (PRD 4.5, N-03).
@immutable
class PagedState<T> {
  const PagedState({
    this.items = const [],
    this.nextCursor,
    this.loading = true,
    this.loaded = false,
    this.loadingMore = false,
    this.error,
    this.loadMoreError,
  });

  final List<T> items;
  final String? nextCursor;

  /// Halaman pertama sedang dimuat (termasuk tarik untuk menyegarkan).
  final bool loading;

  /// Minimal satu halaman pertama berhasil dimuat.
  final bool loaded;
  final bool loadingMore;

  /// Galat halaman pertama.
  final ApiException? error;

  /// Galat halaman berikutnya; daftar yang sudah tampil tetap ada.
  final ApiException? loadMoreError;

  bool get hasMore => nextCursor != null;

  bool get isEmpty => loaded && items.isEmpty;

  PagedState<T> copyWith({
    List<T>? items,
    String? Function()? nextCursor,
    bool? loading,
    bool? loaded,
    bool? loadingMore,
    ApiException? Function()? error,
    ApiException? Function()? loadMoreError,
  }) => PagedState<T>(
    items: items ?? this.items,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    loaded: loaded ?? this.loaded,
    loadingMore: loadingMore ?? this.loadingMore,
    error: error != null ? error() : this.error,
    loadMoreError: loadMoreError != null ? loadMoreError() : this.loadMoreError,
  );
}

/// Pengendali daftar berhalaman dengan cursor opaque. Respons usang (filter berganti, segarkan ganda) dibuang
/// lewat penghitung generasi sehingga halaman tidak tercampur antarfilter.
abstract class PagedController<T> extends Notifier<PagedState<T>> {
  int _generation = 0;

  /// Memuat satu halaman; [cursor] null untuk halaman pertama.
  Future<CursorPage<T>> fetchPage(String? cursor);

  @override
  PagedState<T> build() {
    _generation++;
    final generation = _generation;
    // Halaman pertama dimuat sesudah build selesai (state tidak boleh diubah di dalam build).
    scheduleMicrotask(() {
      if (ref.mounted && generation == _generation) unawaited(refresh());
    });
    return PagedState<T>();
  }

  /// Memuat ulang halaman pertama (tarik untuk menyegarkan, "Coba lagi").
  Future<void> refresh() async {
    final generation = ++_generation;
    state = state.copyWith(loading: true, error: () => null, loadMoreError: () => null, loadingMore: false);
    try {
      final page = await fetchPage(null);
      if (!ref.mounted || generation != _generation) return;
      state = PagedState<T>(items: page.items, nextCursor: page.nextCursor, loading: false, loaded: true);
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      state = state.copyWith(loading: false, error: () => error);
      reportStatusError(ref, error);
    }
  }

  /// Memuat halaman berikutnya bila ada; aman dipanggil berulang saat menggulir.
  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loading || state.loadingMore) return;
    final generation = _generation;
    state = state.copyWith(loadingMore: true, loadMoreError: () => null);
    try {
      final page = await fetchPage(cursor);
      if (!ref.mounted || generation != _generation) return;
      // Keyset tidak menduplikasi item; penyaring id menjaga bila data berubah di antara halaman.
      final seen = {for (final item in state.items) keyOf(item)};
      state = state.copyWith(
        items: [...state.items, ...page.items.where((item) => !seen.contains(keyOf(item)))],
        nextCursor: () => page.nextCursor,
        loadingMore: false,
      );
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      state = state.copyWith(loadingMore: false, loadMoreError: () => error);
      reportStatusError(ref, error);
    }
  }

  /// Identitas item untuk deduplikasi antarhalaman.
  Object keyOf(T item);

  /// Mengganti satu item (mis. jumlah like terbaru) tanpa memuat ulang.
  void replaceWhere(bool Function(T item) test, T Function(T item) update) {
    state = state.copyWith(items: [for (final item in state.items) test(item) ? update(item) : item]);
  }
}

/// Galat status keanggotaan (MEMBERSHIP_REQUIRED, ACCOUNT_SUSPENDED) berarti status di server berubah: /me dimuat
/// ulang sehingga router mengarahkan ulang (ErrorUiAction.refreshStatus, PRD 2.2).
void reportStatusError(Ref ref, ApiException error) {
  if (error.ui.action case ErrorUiAction.refreshStatus || ErrorUiAction.goToRestricted) {
    unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
  }
}

/// Isi daftar berhalaman: kerangka memuat, galat dengan coba lagi, keadaan kosong, daftar dengan tarik untuk
/// menyegarkan dan muat berikutnya otomatis saat mendekati akhir (PRD 4.5, N-03).
class PagedListView<T> extends StatelessWidget {
  const PagedListView({
    super.key,
    required this.state,
    required this.itemBuilder,
    required this.onRefresh,
    required this.onLoadMore,
    required this.empty,
    this.header,
    this.padding = const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s6),
    this.separator = KapdhSpace.s3,
    this.loadingSemantics = 'Memuat daftar',
  });

  final PagedState<T> state;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;

  /// Keadaan kosong yang membantu (pesan dan tindakan spesifik).
  final Widget empty;

  /// Widget di atas daftar yang ikut bergulir (mis. ringkasan).
  final Widget? header;
  final EdgeInsets padding;
  final double separator;
  final String loadingSemantics;

  @override
  Widget build(BuildContext context) {
    final error = state.error;
    if (!state.loaded && state.loading) {
      return ListView(
        children: [?header, LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: loadingSemantics)],
      );
    }
    if (!state.loaded && error != null) {
      return RefreshIndicator(
        onRefresh: onRefresh,
        child: LayoutBuilder(
          builder: (context, constraints) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              ?header,
              ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight * 0.6),
                child: ErrorState.fromException(error, onRetry: () => unawaited(onRefresh())),
              ),
            ],
          ),
        ),
      );
    }
    final items = state.items;
    final footer = _footer();
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: NotificationListener<ScrollNotification>(
        onNotification: (notification) {
          if (state.hasMore &&
              !state.loadingMore &&
              state.loadMoreError == null &&
              notification.metrics.extentAfter < 400) {
            onLoadMore();
          }
          return false;
        },
        child: LayoutBuilder(
          builder: (context, constraints) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: padding,
            children: [
              if (header != null) ...[header!, SizedBox(height: separator)],
              if (state.loading) const LinearProgressIndicator(minHeight: 2),
              if (error != null) ...[
                InfoBox(tone: InfoBoxTone.danger, message: error.message),
                SizedBox(height: separator),
              ],
              if (items.isEmpty)
                ConstrainedBox(
                  constraints: BoxConstraints(minHeight: constraints.maxHeight * 0.55),
                  child: empty,
                )
              else
                for (var i = 0; i < items.length; i++) ...[
                  if (i > 0) SizedBox(height: separator),
                  itemBuilder(context, items[i]),
                ],
              ?footer,
            ],
          ),
        ),
      ),
    );
  }

  Widget? _footer() {
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: KapdhSpace.s4),
        child: Center(
          child: SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Memuat berikutnya'),
          ),
        ),
      );
    }
    final loadMoreError = state.loadMoreError;
    if (loadMoreError != null) {
      return Padding(
        padding: const EdgeInsets.only(top: KapdhSpace.s3),
        child: InfoBox(
          tone: InfoBoxTone.warning,
          message: loadMoreError.message,
          trailing: TextButton(onPressed: onLoadMore, child: const Text('Coba lagi')),
        ),
      );
    }
    if (state.hasMore) {
      // Cadangan bila daftar terlalu pendek untuk memicu gulir (mis. teks diperbesar).
      return Padding(
        padding: const EdgeInsets.only(top: KapdhSpace.s2),
        child: Center(child: TextButton(onPressed: onLoadMore, child: const Text('Muat lebih banyak'))),
      );
    }
    return null;
  }
}
