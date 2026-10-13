import 'package:kapdh_api/kapdh_api.dart';

import 'chat_repository.dart';
import 'chat_timeline.dart';

/// Pengambil halaman riwayat satu room (GET /chat/rooms/{roomId}/messages).
typedef MessagePageFetcher = Future<ChatMessagePage> Function({String? before, String? after, required int limit});

/// Jumlah maksimum halaman lama yang dimuat ulang setelah reconnect (jendela yang sedang ditampilkan).
const int maxWindowReloadPages = 5;

/// Sinkron room setelah reconnect atau saat aplikasi kembali aktif (AC F11-3, N-02; events/README.md "Sinkron
/// setelah reconnect"):
///
/// 1. Dengan jangkar dari halaman HTTP: `after=<jangkar>` diulang sampai `next_cursor` null; hasil digabung
///    berdasarkan `id` sehingga pesan yang juga sudah tiba lewat event tidak terduplikasi, dan jangkar maju.
///    Jangkar yang tidak lagi sah (400 VALIDATION_ERROR) atau belum ada: garis waktu dimulai ulang dari halaman
///    terbaru agar tidak ada celah tersembunyi.
/// 2. Jendela yang ditampilkan dimuat ulang (halaman terbaru lalu halaman lama lewat `before` sampai menutup pesan
///    tertua lokal, maksimal [maxWindowReloadPages]) dan MENGGANTI salinan lokal, sehingga penghapusan (termasuk AC
///    F14-3) dan reaksi yang terjadi saat offline diterapkan.
Future<ChatTimeline> syncTimeline(
  ChatTimeline timeline,
  MessagePageFetcher fetch, {
  int pageSize = chatPageSize,
  int syncPageSize = chatSyncPageSize,
}) async {
  var current = timeline;
  final anchor = current.syncAnchor;
  if (anchor == null) {
    return current.applyLatestPage(await fetch(limit: pageSize), fresh: true);
  }
  try {
    String? cursor = anchor;
    while (cursor != null) {
      final page = await fetch(after: cursor, limit: syncPageSize);
      current = current.applyAfterPage(page);
      final next = page.nextCursor;
      // Pertahanan terhadap halaman kosong atau cursor yang tidak maju: hentikan, jangan berputar.
      cursor = page.items.isEmpty || next == null || next == cursor ? null : next;
    }
  } on ApiException catch (error) {
    if (error.code != ErrorCode.validationError) rethrow;
    return current.applyLatestPage(await fetch(limit: pageSize), fresh: true);
  }

  final windowOldest = current.oldest;
  final latest = await fetch(limit: pageSize);
  current = current.applyLatestPage(latest);
  if (latest.items.isEmpty || windowOldest == null) return current;
  var reloadedOldest = latest.items.first;
  var hasMore = latest.nextCursor != null;
  for (var i = 0; i < maxWindowReloadPages && hasMore && compareMessages(windowOldest, reloadedOldest) < 0; i++) {
    final page = await fetch(before: reloadedOldest.id, limit: pageSize);
    if (page.items.isEmpty) break;
    current = current.applyOlderPage(page);
    reloadedOldest = page.items.first;
    hasMore = page.nextCursor != null;
  }
  return current;
}
