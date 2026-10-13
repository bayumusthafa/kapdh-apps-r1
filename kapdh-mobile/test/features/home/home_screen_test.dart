import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/home/home_repository.dart';
import 'package:kapdh_mobile/features/home/shared/links.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'content_fixtures.dart';
import 'feature_harness.dart';

void main() {
  group('Beranda anggota aktif (F-08, PRD 3.8)', () {
    testWidgets('F-08 sapaan, banner aktif, event mendatang, berita terbaru dan akses cepat KTA/notifikasi', (
      tester,
    ) async {
      final app = await pumpMemberApp(tester, routes: {'/home': (_) => FakeResponse.json(200, homeJson())});
      expect(app.location, '/home');
      expect(find.text("Assalamu'alaikum,"), findsOneWidget);
      expect(find.text('Ahmad Islam'), findsOneWidget);
      expect(find.byTooltip('Notifikasi, 2 belum dibaca'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^Banner 1 dari 1: Reuni Akbar 2026')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^KTA, 29.01.01.7')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^Notifikasi, 2 belum dibaca')), findsOneWidget);

      await scrollUntil(tester, find.text('Event Mendatang'));
      await scrollUntil(tester, find.text('Camping Alumni KAPDH'));
      expect(find.textContaining('Pendaftaran Dibuka'), findsOneWidget);
      expect(find.text('Rp200.000'), findsOneWidget);
      await scrollUntil(tester, find.text('Berita Terbaru'));
      await scrollUntil(tester, find.text('Halal Bihalal Alumni 2026'));
      expect(find.text('3 suka'), findsOneWidget);
      // Gambar hanya dimuat dari URL http(s) payload.
      expect(requestedImages, everyElement(startsWith('https://files.kapdh.or.id/')));

      // Cache Beranda tersimpan per akun untuk keadaan offline (AC F08-4).
      final cached = await HomeCacheStore(app.container.read(secureStoreProvider)).read('user-1');
      expect(cached?.generatedAt, testNow);
    });

    testWidgets('F-08 akses cepat membuka KTA, notifikasi dan event dari Beranda', (tester) async {
      final app = await pumpMemberApp(tester, routes: {'/home': (_) => FakeResponse.json(200, homeJson())});
      await tester.tap(find.byKey(const ValueKey('quick-notifications')));
      await settle(tester);
      expect(app.location, '/notifications');
      app.router.pop();
      await settle(tester);

      await tester.tap(find.byKey(const ValueKey('quick-kta')));
      await settle(tester);
      expect(app.location, '/kta');

      app.router.go('/home');
      await settle(tester);
      await scrollAndTap(tester, find.text('Camping Alumni KAPDH'));
      await settle(tester);
      expect(app.location, '/events/event-1');
    });

    testWidgets('AC F08-2 banner yang targetnya sudah tidak tersedia menampilkan pesan yang jelas', (tester) async {
      final app = await pumpMemberApp(
        tester,
        routes: {
          '/home': (_) => FakeResponse.json(
            200,
            homeJson(banners: [bannerJson(title: 'Berita lama', available: false, route: null)]),
          ),
        },
      );
      expect(tester.getSemantics(find.bySemanticsLabel('Banner 1 dari 1: Berita lama')).hint, 'konten tidak tersedia');
      await tester.tap(find.text('Berita lama'));
      await settle(tester);
      expect(find.text(unavailableTargetMessage), findsOneWidget);
      expect(app.location, '/home');
    });

    testWidgets('AC F08-2 banner berita membuka detail berita di dalam aplikasi', (tester) async {
      final app = await pumpMemberApp(
        tester,
        routes: {
          '/home': (_) => FakeResponse.json(200, homeJson()),
          '/posts/halal-bihalal-2026': (_) => FakeResponse.json(200, postJson()),
        },
      );
      await tester.tap(find.text('Reuni Akbar 2026'));
      await settle(tester);
      expect(app.location, '/news/halal-bihalal-2026');
      expect(find.text('Detail Berita'), findsOneWidget);
    });

    testWidgets('AC F08-2 banner tautan luar ditandai, dikonfirmasi dengan nama domain lalu dibuka di luar aplikasi', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        routes: {
          '/home': (_) => FakeResponse.json(
            200,
            homeJson(
              banners: [bannerJson(title: 'Donasi Pondok', type: 'url', route: null, url: 'https://contoh.org/donasi')],
            ),
          ),
        },
      );
      expect(find.text('Tautan luar'), findsOneWidget);
      expect(tester.getSemantics(find.bySemanticsLabel('Banner 1 dari 1: Donasi Pondok')).hint, 'membuka tautan luar');

      await tester.tap(find.text('Donasi Pondok'));
      await settle(tester);
      expect(find.text('Buka tautan luar?'), findsOneWidget);
      expect(find.textContaining('contoh.org', findRichText: true), findsWidgets);
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(app.launched, isEmpty);

      await tester.tap(find.text('Donasi Pondok'));
      await settle(tester);
      await tester.tap(find.text('Buka'));
      await settle(tester);
      expect(app.launched, [Uri.parse('https://contoh.org/donasi')]);
    });

    testWidgets('AC F08-4 feed kosong: keadaan kosong yang membantu dengan muat ulang', (tester) async {
      var calls = 0;
      final app = await pumpMemberApp(
        tester,
        routes: {
          '/home': (_) {
            calls++;
            return FakeResponse.json(200, emptyHomeJson());
          },
        },
      );
      expect(find.text('Belum ada kabar terbaru'), findsOneWidget);
      expect(find.textContaining('Tarik layar ke bawah untuk memuat ulang'), findsOneWidget);
      // Akses cepat tetap tersedia walau feed kosong.
      expect(find.byKey(const ValueKey('quick-kta')), findsOneWidget);
      await scrollAndTap(tester, find.text('Muat ulang'));
      await settle(tester);
      expect(calls, 2);
      expect(app.adapter.requestsTo('/home'), hasLength(2));
    });

    testWidgets('AC F08-4 jaringan putus tanpa cache: keadaan galat dengan coba lagi yang memulihkan', (tester) async {
      var online = false;
      await pumpMemberApp(
        tester,
        routes: {'/home': (_) => online ? FakeResponse.json(200, homeJson()) : FakeResponse.network()},
      );
      expect(find.byType(ErrorState), findsOneWidget);
      expect(find.text('Tidak ada koneksi'), findsOneWidget);

      online = true;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(find.byType(ErrorState), findsNothing);
      expect(find.bySemanticsLabel(RegExp('^Banner 1 dari 1')), findsOneWidget);
    });

    testWidgets('AC F08-4 offline dengan cache lama: data tersimpan tampil dengan waktu pembaruannya', (tester) async {
      final store = MemorySecureStore();
      await HomeCacheStore(store).save(
        'user-1',
        Home.fromJson(
          homeJson(
            posts: [postSummaryJson(title: 'Berita tersimpan')],
            generatedAt: testNow.subtract(const Duration(hours: 5)),
          ),
        ),
      );
      var online = false;
      await pumpMemberApp(
        tester,
        store: store,
        routes: {'/home': (_) => online ? FakeResponse.json(200, homeJson()) : FakeResponse.network()},
      );
      expect(find.text('Offline'), findsOneWidget);
      expect(find.textContaining('Diperbarui 12 Okt 2026, 09.00 WIB.'), findsOneWidget);
      expect(find.textContaining('Periksa koneksi internet Anda.'), findsOneWidget);
      await scrollUntil(tester, find.text('Berita tersimpan'));
      expect(find.text('Berita tersimpan'), findsOneWidget);

      online = true;
      await scrollUntil(tester, find.widgetWithText(TextButton, 'Coba lagi'), delta: -200);
      await tester.tap(find.widgetWithText(TextButton, 'Coba lagi'));
      await settle(tester);
      expect(find.textContaining('Diperbarui'), findsNothing);
      expect(find.text('Berita tersimpan'), findsNothing);
    });

    testWidgets('AC F08-4 cache milik akun lain tidak pernah ditampilkan dan dihapus', (tester) async {
      final store = MemorySecureStore();
      await HomeCacheStore(store).save('user-lain', Home.fromJson(homeJson(posts: [postSummaryJson(title: 'Rahasia')])));
      await pumpMemberApp(tester, store: store, routes: {'/home': (_) => FakeResponse.network()});
      expect(find.text('Rahasia'), findsNothing);
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      expect(await store.read(HomeCacheStore.storageKey), isNull);
    });

    testWidgets('F-07 status expiring: ajakan perpanjang dari Beranda', (tester) async {
      final app = await pumpMemberApp(
        tester,
        status: 'expiring',
        routes: {
          '/home': (_) => FakeResponse.json(200, homeJson(status: 'expiring', expiresAt: DateTime.utc(2026, 11, 1, 5))),
        },
      );
      expect(find.text('Masa aktif KTA segera berakhir'), findsOneWidget);
      expect(find.textContaining('1 Nov 2026'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Perpanjang'));
      await settle(tester);
      expect(app.location, '/renewal');
    });

    testWidgets('PRD 2.2 GET /home ditolak MEMBERSHIP_REQUIRED: /me dimuat ulang dan Beranda mengikuti status baru', (
      tester,
    ) async {
      var status = 'verified';
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        overrides: [testImagesOverride],
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/home': (_) {
            status = 'expired';
            return FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Fitur ini khusus anggota aktif.'));
          },
        }),
      );
      expect(app.adapter.requestsTo('/me'), hasLength(greaterThanOrEqualTo(2)));
      expect(app.location, '/home');
      expect(find.text('Masa keanggotaan berakhir'), findsOneWidget);
      expect(find.text('Fitur ini khusus anggota aktif.'), findsNothing);
    });

    testWidgets('N-11 teks 200 % tanpa meluap', (tester) async {
      await pumpMemberApp(tester, textScale: 2, routes: {'/home': (_) => FakeResponse.json(200, homeJson())});
      expect(tester.takeException(), isNull);
      await scrollUntil(tester, find.text('Halal Bihalal Alumni 2026'));
      expect(tester.takeException(), isNull);
    });
  });

  group('Beranda status lain (PRD 2.2)', () {
    testWidgets('unverified: tanpa GET /home; ajakan menyelesaikan iuran dan akses cepat yang diizinkan', (tester) async {
      final app = await pumpMemberApp(tester, status: 'unverified', location: '/home', push: false);
      expect(app.location, '/home');
      expect(app.adapter.requestsTo('/home'), isEmpty);
      expect(find.text('KTA Anda belum aktif'), findsOneWidget);
      expect(find.byKey(const ValueKey('quick-tickets')), findsNothing);
      await tester.tap(find.text('Selesaikan Iuran Pendaftaran'));
      await settle(tester);
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('expired: ajakan perpanjang dan Tiket Saya tetap dapat dibuka (tiket lunas tetap berlaku)', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        status: 'expired',
        location: '/home',
        push: false,
        routes: {'/me/tickets': (_) => FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null})},
      );
      expect(app.adapter.requestsTo('/home'), isEmpty);
      expect(find.text('Masa keanggotaan berakhir'), findsOneWidget);
      expect(find.textContaining('Tiket event yang sudah lunas tetap berlaku'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('quick-tickets')));
      await settle(tester);
      expect(app.location, '/tickets');
    });
  });
}
