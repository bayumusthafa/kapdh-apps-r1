import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/payments/payment_updates.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'payments_fixtures.dart';

Map<String, Object?> ticketRef() => {
  'ticket_id': 'tk-1',
  'event_id': 'ev-1',
  'event_title': 'Silaturahmi Akbar',
  'event_starts_at': iso(testNow.add(const Duration(days: 10))),
  'event_timezone': 'Asia/Jakarta',
  'ticket_status': 'paid',
  'hold_expires_at': null,
  'event_status': 'open',
  'ticket_cancelled_by': null,
};

Map<String, Object?> page(List<Map<String, Object?>> items, {String? next}) => {'items': items, 'next_cursor': next};

/// Membuka riwayat pembayaran (`/payments`) untuk anggota berstatus [status].
Future<AppHarness> openHistory(
  WidgetTester tester,
  FutureOr<FakeResponse> Function(Map<String, String> query) list, {
  String status = 'verified',
  Map<String, FakeHandler> routes = const {},
  bool settleAfter = true,
  Stream<NotificationCreatedPayload>? updates,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    overrides: [realtimeNotificationsProvider.overrideWithValue(updates ?? const Stream.empty())],
    handler: apiRoutes({
      '/me': (_) => FakeResponse.json(200, meJson(status: status, expiresAt: DateTime.utc(2027, 10, 12, 7))),
      '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      '/me/membership': (_) => FakeResponse.json(200, membershipJson(status: status)),
      '/me/payments': (options) => list(options.queryParameters.map((k, v) => MapEntry(k, '$v'))),
      ...routes,
    }),
  );
  app.router.go('/payments');
  if (settleAfter) {
    await settle(tester);
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }
  return app;
}

void main() {
  testWidgets('AC F03-2: riwayat pembayaran: jenis, nominal, tanggal dan badge berlabel; ketuk membuka status', (
    tester,
  ) async {
    final app = await openHistory(
      tester,
      (_) => FakeResponse.json(
        200,
        page([
          awaitingReviewJson(),
          paymentJson(
            id: 'pay-2',
            type: 'ticket',
            status: 'paid',
            stage: 'paid',
            proofVersion: 1,
            decidedAt: testNow,
            ticket: ticketRef(),
          ),
          paymentJson(id: 'pay-3', type: 'renewal', status: 'cancelled', stage: 'cancelled', cancelledAt: testNow),
        ]),
      ),
      routes: {'/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson())},
    );

    expect(find.text('Riwayat Pembayaran'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Iuran pendaftaran, Rp60.000, 12 Okt 2026, status Menunggu Verifikasi'),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel('Tiket Silaturahmi Akbar, Rp75.000, 12 Okt 2026, status Lunas'), findsOneWidget);
    expect(find.bySemanticsLabel('Iuran perpanjangan, Rp10.000, 12 Okt 2026, status Dibatalkan'), findsOneWidget);
    expect(find.text('Rp60.000 · 12 Okt 2026'), findsOneWidget);
    final request = app.adapter.requestsTo('/me/payments').single;
    expect(request.queryParameters['limit'], 30);

    await tester.tap(find.text('Iuran pendaftaran'));
    await settle(tester);
    expect(app.location, '/payments/pay-1');
    expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
  });

  testWidgets('PRD 2.2: anggota expired tetap dapat membaca riwayat pembayaran sendiri', (tester) async {
    final app = await openHistory(
      tester,
      status: 'expired',
      (_) => FakeResponse.json(200, page([paymentJson(status: 'paid', stage: 'paid', proofVersion: 1)])),
    );

    expect(app.location, '/payments');
    expect(find.bySemanticsLabel('Iuran pendaftaran, Rp60.000, 12 Okt 2026, status Lunas'), findsOneWidget);
  });

  testWidgets('PRD 5.2: halaman berikutnya memakai cursor keyset tanpa duplikasi', (tester) async {
    final app = await openHistory(tester, (query) {
      if (query['cursor'] == 'c2') {
        return FakeResponse.json(
          200,
          page([
            paymentJson(id: 'pay-2', type: 'renewal', status: 'paid', stage: 'paid', proofVersion: 1),
            // Item yang sudah tampil (mis. berubah saat menggulir) tidak digandakan.
            awaitingReviewJson(),
          ]),
        );
      }
      return FakeResponse.json(200, page([awaitingReviewJson()], next: 'c2'));
    });

    expect(find.text('Muat lagi'), findsOneWidget);
    await tester.tap(find.text('Muat lagi'));
    await settle(tester);

    expect(app.adapter.requestsTo('/me/payments').last.queryParameters['cursor'], 'c2');
    expect(find.text('Iuran pendaftaran'), findsOneWidget);
    expect(find.text('Iuran perpanjangan'), findsOneWidget);
    expect(find.text('Muat lagi'), findsNothing);
  });

  testWidgets('PRD 4.5: kosong untuk anggota unverified: ajakan bayar iuran pendaftaran', (tester) async {
    final app = await openHistory(tester, status: 'unverified', (_) => FakeResponse.json(200, page(const [])));

    expect(find.text('Belum ada pembayaran'), findsOneWidget);
    await tester.tap(find.text('Bayar iuran'));
    await settle(tester);
    expect(app.location, '/onboarding/fees');
  });

  testWidgets('PRD 4.5: kosong untuk anggota aktif: tanpa ajakan bayar', (tester) async {
    await openHistory(tester, (_) => FakeResponse.json(200, page(const [])));

    expect(find.text('Belum ada pembayaran'), findsOneWidget);
    expect(find.text('Bayar iuran'), findsNothing);
  });

  testWidgets('PRD 4.5: gagal memuat saat offline: pesan galat lalu coba lagi', (tester) async {
    var online = false;
    await openHistory(
      tester,
      (_) => online ? FakeResponse.json(200, page([awaitingReviewJson()])) : FakeResponse.network(),
    );

    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    online = true;
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Iuran pendaftaran'), findsOneWidget);
  });

  testWidgets('PRD 4.5: memuat riwayat: kerangka pemuatan', (tester) async {
    final pending = Completer<FakeResponse>();
    await openHistory(tester, (_) => pending.future, settleAfter: false);

    expect(find.bySemanticsLabel('Memuat riwayat pembayaran'), findsOneWidget);
    pending.complete(FakeResponse.json(200, page([awaitingReviewJson()])));
    await settle(tester);
    expect(find.text('Iuran pendaftaran'), findsOneWidget);
  });

  group('Status riwayat tetap terbaru (PRD 4.1, 4.5)', () {
    Map<String, Object?> paid({String id = 'pay-1'}) =>
        paymentJson(id: id, status: 'paid', stage: 'paid', proofVersion: 1, decidedAt: testNow);
    const waitingLabel = 'Iuran pendaftaran, Rp60.000, 12 Okt 2026, status Menunggu Verifikasi';
    const paidLabel = 'Iuran pendaftaran, Rp60.000, 12 Okt 2026, status Lunas';

    testWidgets('PRD 4.1: keputusan pengurus (notifikasi realtime) memperbarui badge riwayat tanpa tarik layar', (
      tester,
    ) async {
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var decided = false;
      await openHistory(
        tester,
        (_) => FakeResponse.json(200, page([decided ? paid() : awaitingReviewJson()])),
        updates: updates.stream,
      );
      expect(find.bySemanticsLabel(waitingLabel), findsOneWidget);

      decided = true;
      updates.add(notificationOf('payment'));
      await settle(tester);

      expect(find.bySemanticsLabel(paidLabel), findsOneWidget);
      expect(find.byKey(const ValueKey('refresh-failed')), findsNothing);
    });

    testWidgets('AC F03-2: kembali dari layar status setelah bukti/pembatalan: badge riwayat dimuat ulang', (
      tester,
    ) async {
      var decided = false;
      final app = await openHistory(
        tester,
        (_) => FakeResponse.json(200, page([decided ? paid() : awaitingReviewJson()])),
        routes: {'/me/payments/pay-1': (_) => FakeResponse.json(200, decided ? paid() : awaitingReviewJson())},
      );
      await tester.tap(find.bySemanticsLabel(waitingLabel));
      await settle(tester);
      expect(app.location, '/payments/pay-1');

      decided = true;
      app.router.pop();
      await settle(tester);

      expect(app.location, '/payments');
      expect(find.bySemanticsLabel(paidLabel), findsOneWidget);
    });

    testWidgets('PRD 5.2: muat ulang latar menggabungkan halaman pertama terbaru tanpa membuang halaman berikutnya '
        'yang sudah dimuat dan tanpa duplikasi', (tester) async {
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var newer = false;
      final app = await openHistory(tester, (query) {
        if (query['cursor'] == 'c2') {
          return FakeResponse.json(200, page([paymentJson(id: 'pay-2', type: 'renewal', status: 'paid', stage: 'paid')]));
        }
        return FakeResponse.json(
          200,
          page([
            if (newer) paymentJson(id: 'pay-3', type: 'renewal'),
            newer ? paid() : awaitingReviewJson(),
          ], next: 'c2'),
        );
      }, updates: updates.stream);
      await tester.tap(find.text('Muat lagi'));
      await settle(tester);
      expect(find.text('Iuran perpanjangan'), findsOneWidget);

      newer = true;
      updates.add(notificationOf('payment'));
      await settle(tester);

      expect(find.byKey(const ValueKey('payment-pay-3')), findsOneWidget);
      expect(find.byKey(const ValueKey('payment-pay-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('payment-pay-2')), findsOneWidget);
      expect(find.bySemanticsLabel(paidLabel), findsOneWidget);
      // Halaman kedua sudah dimuat: tidak ada tombol "Muat lagi" untuk halaman yang sama.
      expect(find.text('Muat lagi'), findsNothing);
      expect(app.adapter.requestsTo('/me/payments').where((r) => r.queryParameters['cursor'] == 'c2'), hasLength(1));
    });

    testWidgets('PRD 4.5: tarik untuk memuat ulang gagal: riwayat lama tetap tampil dengan pemberitahuan dan Coba '
        'lagi', (tester) async {
      var failing = false;
      var decided = false;
      await openHistory(
        tester,
        (_) => failing
            ? FakeResponse.network()
            : FakeResponse.json(200, page([decided ? paid() : awaitingReviewJson()])),
      );

      failing = true;
      unawaited(tester.state<RefreshIndicatorState>(find.byType(RefreshIndicator)).show());
      await settle(tester);

      expect(find.byKey(const ValueKey('refresh-failed')), findsOneWidget);
      expect(find.text('Riwayat terbaru belum dapat dimuat'), findsOneWidget);
      expect(find.bySemanticsLabel(waitingLabel), findsOneWidget);

      failing = false;
      decided = true;
      await tester.tap(
        find.descendant(of: find.byKey(const ValueKey('refresh-failed')), matching: find.text('Coba lagi')),
      );
      await settle(tester);

      expect(find.byKey(const ValueKey('refresh-failed')), findsNothing);
      expect(find.bySemanticsLabel(paidLabel), findsOneWidget);
    });
  });
}
