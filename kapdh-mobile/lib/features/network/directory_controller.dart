import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import 'directory_filter.dart';
import 'network_repository.dart';
import 'paged_list.dart';

/// Pencarian dan filter direktori yang sedang berlaku di tab Jejaring.
final directoryFilterProvider = NotifierProvider.autoDispose<DirectoryFilterController, DirectoryFilter>(
  DirectoryFilterController.new,
);

class DirectoryFilterController extends Notifier<DirectoryFilter> {
  @override
  DirectoryFilter build() => DirectoryFilter.empty;

  /// Kata kunci dari kotak pencarian (dinormalisasi; kurang dari 2 karakter = tanpa kata kunci).
  void setQuery(String raw) {
    final query = DirectoryFilter.normalizeQuery(raw);
    if (query != state.query) state = state.withQuery(query);
  }

  /// Filter dari lembar filter (angkatan, kelas, kota, profesi, keahlian, urutan).
  void applySheet(DirectoryFilter sheet) {
    final next = state.withSheet(sheet);
    if (next != state) state = next;
  }

  void reset() => state = DirectoryFilter.empty;
}

/// Hasil direktori ber-paging keyset untuk filter yang berlaku (F-10, AC F10-1): filter baru memulai dari halaman
/// pertama; halaman berikut memakai `next_cursor`; total mengikuti filter yang sama dari server.
final directoryProvider = NotifierProvider.autoDispose<DirectoryController, PagedState<DirectoryMember>>(
  DirectoryController.new,
);

class DirectoryController extends PagedController<DirectoryMember> {
  late DirectoryFilter _filter;

  @override
  PagedState<DirectoryMember> build() {
    _filter = ref.watch(directoryFilterProvider);
    return super.build();
  }

  @override
  Future<PageResult<DirectoryMember>> fetchPage(String? cursor) async {
    final page = await ref.read(networkRepositoryProvider).search(_filter, cursor: cursor);
    return PageResult(page.items, page.nextCursor, total: page.total);
  }

  @override
  String keyOf(DirectoryMember item) => item.userId;
}
