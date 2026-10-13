import 'dart:async';

import 'package:dio/dio.dart' show RequestOptions;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../home/content_fixtures.dart';
import '../home/feature_harness.dart';

Map<String, Object?> _categories() => {
  'items': [
    {'id': 'cat-pengumuman', 'kind': 'post', 'slug': 'pengumuman', 'label': 'Pengumuman', 'sort_order': 1},
    {'id': 'cat-kegiatan', 'kind': 'post', 'slug': 'kegiatan', 'label': 'Kegiatan', 'sort_order': 2},
  ],
};

FakeResponse _like(RequestOptions options, {int base = 3}) => options.method == 'PUT'
    ? FakeResponse.json(200, likeStateJson(liked: true, count: base + 1))
    : FakeResponse.json(200, likeStateJson(liked: false, count: base));

void main() {
  group('Daftar Berita (F-08)', () {
    testWidgets('AC F08-1 feed berita terbit dari server, kategori sebagai filter, halaman berikutnya dengan cursor', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/news',
        routes: {
          '/categories': (_) => FakeResponse.json(200, _categories()),
          '/posts': (options) => options.queryParameters['cursor'] == 'c2'
              ? FakeResponse.json(
                  200,
                  postPageJson([postSummaryJson(id: 'post-3', slug: 'p3', title: 'Berita ketiga')]),
                )
              : FakeResponse.json(
                  200,
                  postPageJson([
                    postSummaryJson(withCover: false),
                    postSummaryJson(id: 'post-2', slug: 'p2', title: 'Berita kedua', withCover: false),
                  ], nextCursor: 'c2'),
                ),
        },
      );
      expect(app.location, '/news');
      expect(lastQuery(app, '/categories')['kind'], 'post');
      expect(lastQuery(app, '/posts')['limit'], 20);
      expect(find.text('Halal Bihalal Alumni 2026'), findsOneWidget);
      expect(find.text('Berita kedua'), findsOneWidget);
      expect(find.widgetWithText(ChoiceChip, 'Semua'), findsOneWidget);
      expect(find.widgetWithText(ChoiceChip, 'Kegiatan'), findsOneWidget);

      await scrollUntil(tester, find.text('Muat lebih banyak'));
      await tester.tap(find.text('Muat lebih banyak'));
      await settle(tester);
      expect(lastQuery(app, '/posts')['cursor'], 'c2');
      await scrollUntil(tester, find.text('Berita ketiga'));
      expect(find.text('Muat lebih banyak'), findsNothing);
    });

    testWidgets('AC F08-4 kategori tanpa berita: keadaan kosong membantu dan kembali ke semua berita', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/news',
        routes: {
          '/categories': (_) => FakeResponse.json(200, _categories()),
          '/posts': (options) => options.queryParameters['category'] == 'kegiatan'
              ? FakeResponse.json(200, postPageJson([]))
              : FakeResponse.json(200, postPageJson([postSummaryJson()])),
        },
      );
      await tester.tap(find.widgetWithText(ChoiceChip, 'Kegiatan'));
      await settle(tester);
      expect(lastQuery(app, '/posts')['category'], 'kegiatan');
      expect(find.text('Belum ada berita di kategori ini'), findsOneWidget);
      await tester.tap(find.text('Lihat semua berita'));
      await settle(tester);
      expect(find.text('Halal Bihalal Alumni 2026'), findsOneWidget);
    });

    testWidgets('AC F08-4 feed kosong: keadaan kosong dengan muat ulang', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/news',
        routes: {
          '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
          '/posts': (_) => FakeResponse.json(200, postPageJson([])),
        },
      );
      expect(find.text('Belum ada berita'), findsOneWidget);
      // Kategori kosong: tanpa baris filter, feed tetap dapat dibaca.
      expect(find.byType(ChoiceChip), findsNothing);
      await tester.tap(find.text('Muat ulang'));
      await settle(tester);
      expect(app.adapter.requestsTo('/posts'), hasLength(2));
    });

    testWidgets('AC F08-4 galat server: keadaan galat dengan coba lagi yang memulihkan', (tester) async {
      var fail = true;
      await pumpMemberApp(
        tester,
        location: '/news',
        routes: {
          '/categories': (_) => FakeResponse.json(500, errorJson('INTERNAL', 'Terjadi kesalahan pada server.')),
          '/posts': (_) => fail
              ? FakeResponse.json(500, errorJson('INTERNAL', 'Terjadi kesalahan pada server.'))
              : FakeResponse.json(200, postPageJson([postSummaryJson()])),
        },
      );
      expect(find.byType(ErrorState), findsOneWidget);
      expect(find.text('Terjadi kesalahan pada server.'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(find.text('Halal Bihalal Alumni 2026'), findsOneWidget);
    });

    testWidgets('N-03 memuat: kerangka daftar dan detail berita selagi request berjalan', (tester) async {
      final list = Completer<FakeResponse>();
      final detail = Completer<FakeResponse>();
      await pumpMemberApp(
        tester,
        settled: false,
        location: '/news',
        routes: {
          '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
          '/posts': (_) => list.future,
          '/posts/halal-bihalal-2026': (_) => detail.future,
        },
      );
      expect(find.bySemanticsLabel('Memuat berita'), findsOneWidget);
      list.complete(FakeResponse.json(200, postPageJson([postSummaryJson(withCover: false)])));
      await settle(tester);
      await tester.tap(find.text('Halal Bihalal Alumni 2026'));
      await pumpFrames(tester, count: 10);
      expect(find.bySemanticsLabel('Memuat berita'), findsOneWidget);
      detail.complete(FakeResponse.json(200, postJson()));
      await settle(tester);
      expect(find.byKey(const ValueKey('post-detail')), findsOneWidget);
    });

    testWidgets(
      'PRD 2.2 feed ditolak server (403 MEMBERSHIP_REQUIRED): /me dimuat ulang, Berita khusus anggota aktif',
      (tester) async {
        var status = 'verified';
        final app = await pumpMemberApp(
          tester,
          location: '/news',
          routes: {
            '/me': (_) => FakeResponse.json(200, meJson(status: status)),
            '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
            '/posts': (_) {
              // Masa keanggotaan berakhir di server sebelum klien tahu.
              status = 'expired';
              return FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Fitur ini khusus anggota aktif.'));
            },
          },
        );
        expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
        expect(app.location, '/news');
        expect(find.text('Berita khusus anggota aktif'), findsOneWidget);
        expect(find.text('Perpanjang KTA'), findsOneWidget);
        expect(find.byType(ErrorState), findsNothing);
      },
    );

    testWidgets('PRD 2.2 detail berita ditolak ACCOUNT_SUSPENDED: /me dimuat ulang lalu ke portal pembatasan', (
      tester,
    ) async {
      var status = 'verified';
      final app = await pumpMemberApp(
        tester,
        location: '/news/halal-bihalal-2026',
        routes: {
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/posts/halal-bihalal-2026': (_) {
            status = 'suspended';
            return FakeResponse.json(403, errorJson('ACCOUNT_SUSPENDED', 'Akun Anda sedang dibatasi.'));
          },
        },
      );
      expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
      expect(app.location, '/restricted');
    });

    testWidgets('PRD 2.2 unverified: Berita khusus anggota aktif tanpa request /posts', (tester) async {
      final app = await pumpMemberApp(tester, status: 'unverified', location: '/news');
      expect(app.location, '/news');
      expect(find.text('Berita khusus anggota aktif'), findsOneWidget);
      expect(app.adapter.requestsTo('/posts'), isEmpty);
      await tester.tap(find.text('Bayar iuran'));
      await settle(tester);
      expect(app.location, '/onboarding/fees');
    });
  });

  group('Detail Berita (F-08)', () {
    testWidgets('F-08 isi HTML tersanitasi dengan tanda tautan luar; tautan luar dikonfirmasi sebelum dibuka', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/news/halal-bihalal-2026',
        routes: {'/posts/halal-bihalal-2026': (_) => FakeResponse.json(200, postJson())},
      );
      expect(find.text('Detail Berita'), findsOneWidget);
      expect(find.text('Halal Bihalal Alumni 2026'), findsOneWidget);
      expect(find.text('Terbit 11 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(find.textContaining('Halal bihalal alumni digelar di aula pondok.', findRichText: true), findsOneWidget);
      expect(find.bySemanticsLabel('situs panitia, tautan luar'), findsOneWidget);

      await tester.tap(find.textContaining('situs panitia'));
      await settle(tester);
      expect(find.text('Buka tautan luar?'), findsOneWidget);
      await tester.tap(find.text('Buka'));
      await settle(tester);
      expect(app.launched, [Uri.parse('https://contoh.org/info')]);
    });

    testWidgets('PRD 3.8 gambar isi berita hanya dari URL http(s); data: dan file: tidak dimuat', (tester) async {
      await pumpMemberApp(
        tester,
        location: '/news/foto',
        routes: {
          '/posts/foto': (_) => FakeResponse.json(
            200,
            postJson(
              slug: 'foto',
              bodyHtml:
                  '<p>Foto kegiatan</p><img src="https://files.kapdh.or.id/posts/foto.jpg" alt="Foto">'
                  '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Data"><img src="file:///etc/passwd" alt="Berkas">',
            ),
          ),
        },
      );
      expect(find.textContaining('Foto kegiatan', findRichText: true), findsOneWidget);
      expect(requestedImages, contains('https://files.kapdh.or.id/posts/foto.jpg'));
      expect(requestedImages.where((url) => !url.startsWith('https://')), isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('AC F08-1 berita diarsipkan/belum terbit (404): "Berita tidak lagi tersedia"', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/news/arsip',
        routes: {
          '/posts/arsip': (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Data tidak ditemukan.')),
          '/posts': (_) => FakeResponse.json(200, postPageJson([])),
          '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
        },
      );
      expect(find.text('Berita tidak lagi tersedia'), findsOneWidget);
      await tester.tap(find.text('Lihat berita lain'));
      await settle(tester);
      expect(app.location, '/news');
    });

    testWidgets('AC F08-3 like: ketukan ganda selama request hanya mengirim satu PUT; jumlah dari server', (
      tester,
    ) async {
      final pending = Completer<FakeResponse>();
      final app = await pumpMemberApp(
        tester,
        location: '/news/halal-bihalal-2026',
        routes: {
          '/posts/halal-bihalal-2026': (_) => FakeResponse.json(200, postJson()),
          '/posts/halal-bihalal-2026/like': (options) => options.method == 'PUT' ? pending.future : _like(options),
        },
      );
      await scrollUntil(tester, find.byKey(const ValueKey('post-like')));
      expect(find.text('3 suka'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('post-like')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('post-like')), warnIfMissed: false);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.adapter.requestsTo('/posts/halal-bihalal-2026/like'), hasLength(1));

      pending.complete(FakeResponse.json(200, likeStateJson(liked: true, count: 4)));
      await settle(tester);
      expect(find.text('4 suka'), findsOneWidget);
      expect(find.text('Disukai'), findsOneWidget);

      // Batal suka: DELETE idempoten, jumlah kembali dari server.
      await tester.tap(find.byKey(const ValueKey('post-like')));
      await settle(tester);
      final requests = app.adapter.requestsTo('/posts/halal-bihalal-2026/like');
      expect(requests.map((r) => r.method), ['PUT', 'DELETE']);
      expect(find.text('3 suka'), findsOneWidget);
      expect(find.text('Suka'), findsOneWidget);
    });

    testWidgets('AC F08-3 like gagal: jumlah tidak berubah dan galat ditampilkan', (tester) async {
      await pumpMemberApp(
        tester,
        location: '/news/halal-bihalal-2026',
        routes: {
          '/posts/halal-bihalal-2026': (_) => FakeResponse.json(200, postJson()),
          '/posts/halal-bihalal-2026/like': (_) =>
              FakeResponse.json(500, errorJson('INTERNAL', 'Terjadi kesalahan pada server.')),
        },
      );
      await scrollUntil(tester, find.byKey(const ValueKey('post-like')));
      await tester.tap(find.byKey(const ValueKey('post-like')));
      await settle(tester);
      expect(find.text('3 suka'), findsOneWidget);
      expect(find.text('Suka'), findsOneWidget);
      expect(find.text('Terjadi kesalahan pada server.'), findsOneWidget);
    });

    testWidgets('AC F08-3 keadaan like dari detail tercermin di feed tanpa memuat ulang', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/news',
        routes: {
          '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
          '/posts': (_) => FakeResponse.json(200, postPageJson([postSummaryJson(withCover: false)])),
          '/posts/halal-bihalal-2026': (_) => FakeResponse.json(200, postJson()),
          '/posts/halal-bihalal-2026/like': _like,
        },
      );
      await tester.tap(find.text('Halal Bihalal Alumni 2026'));
      await settle(tester);
      expect(app.location, '/news/halal-bihalal-2026');
      await scrollUntil(tester, find.byKey(const ValueKey('post-like')));
      await tester.tap(find.byKey(const ValueKey('post-like')));
      await settle(tester);
      app.router.pop();
      await settle(tester);
      expect(app.location, '/news');
      expect(find.text('4 suka'), findsOneWidget);
      expect(app.adapter.requestsTo('/posts'), hasLength(1));
    });

    testWidgets('N-11 detail berita pada teks 200 % tanpa meluap', (tester) async {
      await pumpMemberApp(
        tester,
        textScale: 2,
        location: '/news/halal-bihalal-2026',
        routes: {'/posts/halal-bihalal-2026': (_) => FakeResponse.json(200, postJson())},
      );
      expect(tester.takeException(), isNull);
      await scrollUntil(tester, find.byKey(const ValueKey('post-like')));
      expect(tester.takeException(), isNull);
    });
  });
}
