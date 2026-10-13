import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/chat/chat_realtime.dart';
import 'package:kapdh_mobile/features/network/blocked_users_screen.dart';
import 'package:kapdh_mobile/features/network/my_reports_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../chat/chat_fixtures.dart';
import 'network_fixtures.dart';

Future<AppHarness> _open(
  WidgetTester tester,
  String location, {
  required Map<String, FakeHandler> routes,
  String status = 'verified',
  double textScale = 1,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: status)), ...routes}),
    overrides: [chatRealtimeProvider.overrideWithValue(FakeChatRealtime())],
  );
  app.router.go('/account');
  await settle(tester);
  app.router.push(location);
  await settle(tester);
  return app;
}

void main() {
  group('Akun > Pengguna Diblokir (F-12)', () {
    testWidgets('AC F12-1: daftar blokir milik sendiri dan buka blokir dengan konfirmasi', (tester) async {
      final app = await _open(
        tester,
        '/account/blocked',
        routes: {
          '/blocks': (_) => FakeResponse.json(
            200,
            pageJson([blockedJson('user-2', 'Gamerisa Dewi'), blockedJson('user-3', 'Budi Santoso')]),
          ),
          '/blocks/user-2': (_) => FakeResponse.json(204),
        },
      );
      expect(find.byType(BlockedUsersScreen), findsOneWidget);
      expect(find.text('Gamerisa Dewi'), findsOneWidget);
      expect(find.textContaining('Diblokir sejak'), findsNWidgets(2));

      await tester.tap(find.text('Buka blokir').first);
      await settle(tester);
      expect(find.text('Buka blokir Gamerisa Dewi?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Buka blokir').last);
      await settle(tester);
      expect(app.adapter.requestsTo('/blocks/user-2').single.method, 'DELETE');
      expect(find.text('Gamerisa Dewi'), findsNothing);
      expect(find.text('Budi Santoso'), findsOneWidget);
    });

    testWidgets('kosong dan galat', (tester) async {
      var fail = true;
      await _open(
        tester,
        '/account/blocked',
        routes: {'/blocks': (_) => fail ? FakeResponse.network() : FakeResponse.json(200, pageJson(const []))},
      );
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(find.text('Tidak ada pengguna yang diblokir'), findsOneWidget);
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await _open(
        tester,
        '/account/blocked',
        textScale: 2,
        routes: {
          '/blocks': (_) => FakeResponse.json(200, pageJson([blockedJson('user-2', 'Gamerisa Dewi Lestari')])),
        },
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('PRD 2.2: anggota expired tidak membuka tindakan komunitas', (tester) async {
      final app = await _open(
        tester,
        '/account/blocked',
        status: 'expired',
        routes: {'/blocks': (_) => FakeResponse.json(200, pageJson(const []))},
      );
      expect(find.byType(BlockedUsersScreen), findsNothing);
      expect(app.adapter.requestsTo('/blocks'), isEmpty);
    });
  });

  group('Akun > Laporan Saya (F-12, AC F12-2)', () {
    testWidgets('AC F12-2: status dan hasil laporan milik sendiri tanpa bukti/identitas pengurus', (tester) async {
      await _open(
        tester,
        '/account/reports',
        routes: {
          '/reports': (_) => FakeResponse.json(
            200,
            pageJson([
              reportJson(id: 'r-1', category: 'violence_threat', priority: 'urgent'),
              reportJson(
                id: 'r-2',
                category: 'spam',
                targetType: 'message',
                roomName: 'Angkatan 29',
                status: 'resolved',
                outcome: 'action_taken',
              ),
              reportJson(
                id: 'r-3',
                category: 'other',
                targetType: 'room',
                targetName: null,
                roomName: 'Jual Beli',
                status: 'dismissed',
                outcome: 'no_action',
              ),
            ]),
          ),
          '/reports/r-2': (_) => FakeResponse.json(
            200,
            reportJson(
              id: 'r-2',
              category: 'spam',
              targetType: 'message',
              roomName: 'Angkatan 29',
              status: 'resolved',
              outcome: 'action_taken',
              description: 'Promosi berulang.',
            ),
          ),
        },
      );
      expect(find.byType(MyReportsScreen), findsOneWidget);
      expect(find.text('Ancaman kekerasan atau keselamatan'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Menunggu tinjauan'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Selesai'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Ditutup'), findsOneWidget);
      expect(find.text('Pesan dari Gamerisa Dewi di grup Angkatan 29'), findsOneWidget);
      expect(find.text('Grup: Jual Beli'), findsOneWidget);
      expect(find.text('Pengurus telah mengambil tindakan.'), findsOneWidget);
      expect(find.text('Tidak ada tindakan yang diperlukan.'), findsOneWidget);

      await tester.tap(find.text('Spam'));
      await settle(tester);
      expect(find.text('Rincian laporan'), findsOneWidget);
      expect(find.text('Promosi berulang.'), findsOneWidget);
    });

    testWidgets('banding: pesan pengurus untuk pemohon ditampilkan', (tester) async {
      await _open(
        tester,
        '/account/reports',
        routes: {
          '/reports': (_) => FakeResponse.json(
            200,
            pageJson([
              reportJson(
                id: 'a-1',
                category: 'appeal',
                targetName: 'Ahmad Islam',
                status: 'dismissed',
                outcome: 'no_action',
              ),
            ]),
          ),
          '/reports/a-1': (_) => FakeResponse.json(
            200,
            reportJson(
              id: 'a-1',
              category: 'appeal',
              targetName: 'Ahmad Islam',
              status: 'dismissed',
              outcome: 'no_action',
              decisionMessage: 'Bukti pelanggaran sudah jelas.',
            ),
          ),
        },
      );
      expect(find.text('Banding'), findsOneWidget);
      expect(find.text('Banding pembatasan akun'), findsOneWidget);
      expect(find.text('Banding ditolak.'), findsOneWidget);
      await tester.tap(find.text('Banding'));
      await settle(tester);
      expect(find.text('Bukti pelanggaran sudah jelas.'), findsOneWidget);
    });

    testWidgets('kosong', (tester) async {
      await _open(tester, '/account/reports', routes: {'/reports': (_) => FakeResponse.json(200, pageJson(const []))});
      expect(find.text('Belum ada laporan'), findsOneWidget);
    });

    testWidgets('AC F12-2, PRD 2.2: anggota expired tetap membuka Laporan Saya (riwayat sendiri, member_access any)', (
      tester,
    ) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: 'expired')),
          '/reports': (_) => FakeResponse.json(200, pageJson([reportJson(id: 'r-1')])),
        }),
        overrides: [chatRealtimeProvider.overrideWithValue(FakeChatRealtime())],
      );
      // Tautan notifikasi hasil moderasi (kategori account, C6) dibuka langsung.
      app.router.go('/account/reports');
      await settle(tester);
      expect(app.location, '/account/reports');
      expect(find.byType(MyReportsScreen), findsOneWidget);
      expect(app.adapter.requestsTo('/reports'), hasLength(1));
    });

    testWidgets('PRD 3.12: anggota suspended melihat hasil banding dari tautan notifikasi /account/reports', (
      tester,
    ) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: 'suspended')),
          '/reports': (_) => FakeResponse.json(
            200,
            pageJson([
              reportJson(
                id: 'a-1',
                category: 'appeal',
                targetName: 'Ahmad Islam',
                status: 'dismissed',
                outcome: 'no_action',
              ),
            ]),
          ),
        }),
        overrides: [chatRealtimeProvider.overrideWithValue(FakeChatRealtime())],
      );
      expect(app.location, '/restricted');
      app.router.push('/account/reports');
      await settle(tester);
      expect(find.byType(MyReportsScreen), findsOneWidget);
      expect(find.text('Banding pembatasan akun'), findsOneWidget);
      expect(find.text('Banding ditolak.'), findsOneWidget);
      // Daftar blokir tetap hanya untuk anggota aktif.
      app.router.go('/account/blocked');
      await settle(tester);
      expect(app.location, '/restricted');
      expect(find.byType(BlockedUsersScreen), findsNothing);
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await _open(
        tester,
        '/account/reports',
        textScale: 2,
        routes: {
          '/reports': (_) => FakeResponse.json(200, pageJson([reportJson()])),
        },
      );
      expect(tester.takeException(), isNull);
    });
  });
}
