import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/app_gate/app_gate.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/core/session/me_snapshot_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/system/maintenance_screen.dart';
import 'package:kapdh_mobile/features/system/splash_screen.dart';
import 'package:kapdh_mobile/features/system/update_required_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

void main() {
  group('Splash (PRD 4.6 Flutter sistem)', () {
    testWidgets('memuat: logo dan indikator', (tester) async {
      await pumpApp(tester, handler: apiRoutes({}), settle: false);
      expect(find.byType(SplashScreen), findsOneWidget);
      expect(find.bySemanticsLabel('Logo KAPDH'), findsOneWidget);
      expect(find.bySemanticsLabel('Memuat aplikasi'), findsOneWidget);
      await settle(tester);
    });

    testWidgets('offline tanpa snapshot: "Tanpa koneksi", sesi tidak dihapus, coba lagi memulihkan', (tester) async {
      var online = false;
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: (options) {
          if (!online) return FakeResponse.network();
          return apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())})(options);
        },
      );
      expect(find.text('Tanpa koneksi'), findsOneWidget);
      expect(app.container.read(sessionProvider).issue, SessionIssue.offline);
      expect(app.location, '/splash');

      online = true;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(app.location, '/home');
    });

    testWidgets('offline dengan snapshot: status terakhir, pita Offline tepat di bawah app bar (prototipe 7)', (
      tester,
    ) async {
      final store = MemorySecureStore();
      await MeSnapshotStore(store).save(meOf(), testNow.subtract(const Duration(hours: 5)));
      final app = await pumpApp(tester, store: store, tokens: savedTokens(), handler: (_) => FakeResponse.network());
      expect(app.location, '/home');
      expect(app.container.read(sessionProvider).isOffline, isTrue);
      expect(find.textContaining('Tersinkron 12 Okt 2026, 09.00 WIB'), findsOneWidget);
      expect(find.byType(OfflineBanner), findsOneWidget);
      final appBarBottom = tester.getBottomLeft(find.byType(AppBar)).dy;
      expect(tester.getTopLeft(find.byType(OfflineBanner)).dy, closeTo(appBarBottom, 1));
      expect(
        tester.getBottomLeft(find.byType(OfflineBanner)).dy,
        lessThan(tester.getTopLeft(find.byType(NavigationBar)).dy - 100),
        reason: 'bukan di atas navigasi bawah',
      );
    });

    testWidgets('secure storage gagal dibaca: pesan dan coba lagi, bukan berputar tanpa akhir', (tester) async {
      final inner = MemorySecureStore();
      await TokenStore(inner).save(savedTokens());
      final app = await pumpApp(
        tester,
        store: FlakySecureStore(inner),
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}),
      );
      expect(app.location, '/splash');
      expect(find.text('Data sesi belum dapat dibaca'), findsOneWidget);
      expect(app.container.read(sessionProvider).issue, SessionIssue.storage);

      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(app.location, '/home');
    });

    testWidgets('server bermasalah: pesan server, bukan offline', (tester) async {
      await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: (_) => FakeResponse.json(500, errorJson('INTERNAL_ERROR', 'Galat')),
      );
      expect(find.text('Server belum dapat dihubungi'), findsOneWidget);
    });
  });

  group('Wajib update (PRD 4.5)', () {
    testWidgets('versi di bawah minimum: tautan Play Store dan periksa lagi', (tester) async {
      var minimum = '2.0.0';
      final app = await pumpApp(
        tester,
        handler: (options) => apiRoutes({}, config: publicConfigJson(android: minimum))(options),
      );
      expect(find.byType(UpdateRequiredScreen), findsOneWidget);
      expect(app.location, '/update-required');
      expect(find.textContaining('Versi aplikasi ini (1.2.0) tidak lagi didukung'), findsOneWidget);
      expect(find.textContaining('2.0.0'), findsOneWidget);

      await tester.tap(find.text('Perbarui di Play Store'));
      await settle(tester);
      expect(app.launched.single.host, 'play.google.com');

      minimum = '1.0.0';
      await scrollAndTap(tester, find.text('Periksa lagi'));
      await settle(tester);
      expect(app.container.read(appGateProvider).status, GateStatus.ok);
      expect(app.location, '/login');
    });

    testWidgets('tautan toko belum tersedia: arahan menghubungi pengurus', (tester) async {
      await pumpApp(
        tester,
        handler: apiRoutes({}, config: publicConfigJson(android: '9.0.0', androidStore: null)),
      );
      expect(find.textContaining('Tautan toko aplikasi belum tersedia'), findsOneWidget);
      await scrollTo(tester, find.text('bantuan@kapdh.or.id'));
      expect(find.text('bantuan@kapdh.or.id'), findsOneWidget);
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await pumpApp(
        tester,
        handler: apiRoutes({}, config: publicConfigJson(android: '2.0.0')),
        textScale: 2,
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('Maintenance (PRD 4.5)', () {
    testWidgets('pesan, estimasi WIB, kontak dukungan dan coba lagi', (tester) async {
      var maintenance = true;
      final app = await pumpApp(
        tester,
        handler: (options) => apiRoutes(
          {},
          config: publicConfigJson(
            maintenance: maintenance,
            maintenanceMessage: 'Peningkatan server malam ini.',
            maintenanceUntil: DateTime.utc(2026, 10, 12, 9),
            supportWhatsapp: '0812-3456-7890',
          ),
        )(options),
      );
      expect(find.byType(MaintenanceScreen), findsOneWidget);
      expect(find.text('Peningkatan server malam ini.'), findsOneWidget);
      expect(find.textContaining('Perkiraan selesai: 12 Okt 2026, 16.00 WIB'), findsOneWidget);
      expect(find.text('Tampilkan KTA'), findsNothing, reason: 'anonim tidak punya KTA');
      expect(find.text('Lanjut dalam mode baca'), findsNothing, reason: 'anonim tidak dapat login selama maintenance');

      await scrollAndTap(tester, find.text('0812-3456-7890'));
      await settle(tester);
      expect(app.launched.single.toString(), 'https://wa.me/6281234567890');

      maintenance = false;
      await scrollAndTap(tester, find.text('Coba lagi'));
      await settle(tester);
      expect(app.location, '/login');
    });

    testWidgets('anggota aktif tetap dapat menunjukkan KTA saat maintenance', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson()),
        }, config: publicConfigJson(maintenance: true)),
      );
      expect(app.location, '/maintenance');
      await scrollAndTap(tester, find.text('Tampilkan KTA'));
      await settle(tester);
      expect(app.location, '/kta');
    });

    testWidgets('lanjut dalam mode baca: rute baca terbuka dengan pita Pemeliharaan di bawah app bar', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson()),
        }, config: publicConfigJson(maintenance: true, maintenanceUntil: DateTime.utc(2026, 10, 12, 9))),
      );
      expect(app.location, '/maintenance');
      await scrollAndTap(tester, find.text('Lanjut dalam mode baca'));
      await settle(tester);
      expect(app.location, '/home');
      expect(find.byType(MaintenanceBanner), findsOneWidget);
      expect(find.textContaining('Perubahan data ditunda sampai sekitar 12 Okt 2026, 16.00 WIB'), findsOneWidget);
      final appBarBottom = tester.getBottomLeft(find.byType(AppBar)).dy;
      expect(tester.getTopLeft(find.byType(MaintenanceBanner)).dy, closeTo(appBarBottom, 1));

      // Alur khusus mutasi tetap ke layar maintenance.
      app.router.go('/renewal');
      await settle(tester);
      expect(app.location, '/maintenance?from=%2Frenewal');
    });

    testWidgets('503 MAINTENANCE dari request mana pun memasang mode baca terkendali', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson()),
          '/home': (_) =>
              FakeResponse.json(503, errorJson('MAINTENANCE', 'Pemeliharaan mendadak.', retryAfterSeconds: 600)),
        }),
      );
      expect(app.location, '/home');
      expect(find.byType(MaintenanceBanner), findsNothing);
      unawaited(app.container.read(kapdhApiProvider).content.getHome().then<void>((_) {}, onError: (Object _) {}));
      await settle(tester);
      // Layar baca tetap terbuka (PRD 4.5 read-only terkontrol) dengan pita Pemeliharaan.
      expect(app.location, '/home');
      expect(find.byType(MaintenanceBanner), findsOneWidget);

      await tester.tap(find.text('Detail'));
      await settle(tester);
      expect(app.location, '/maintenance?from=%2Fhome');
      expect(find.text('Pemeliharaan mendadak.'), findsOneWidget);
      await scrollAndTap(tester, find.text('Lanjut dalam mode baca'));
      await settle(tester);
      expect(app.location, '/home');
    });
  });

  testWidgets('rute tidak dikenal untuk anggota aktif kembali ke rute status', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}),
    );
    app.router.go('/tidak-ada');
    await settle(tester);
    expect(app.location, '/home');
  });

  testWidgets('wajib update dari status anggota yang belum dikenal aplikasi', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, {...meJson(), 'effective_status': 'status_baru'}),
      }),
    );
    expect(app.location, '/update-required');
    expect(find.text('Aplikasi perlu diperbarui untuk menampilkan status akun Anda dengan benar.'), findsOneWidget);
  });

  testWidgets('legal terbuka sebelum login', (tester) async {
    final app = await pumpApp(tester, handler: apiRoutes({}));
    await tester.tap(find.text('Kebijakan Privasi'));
    await settle(tester);
    expect(app.location, '/legal/kebijakan-privasi');
    expect(find.text('Sedang dibangun'), findsOneWidget);
    await tester.tap(find.byTooltip('Kembali'));
    await settle(tester);
    expect(app.location, '/login');
    expect(find.byType(Scaffold), findsWidgets);
  });
}
