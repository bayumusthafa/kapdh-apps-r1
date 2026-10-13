import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/payments/payment_presentation.dart';
import 'package:kapdh_mobile/features/payments/proof_file.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'payments_fixtures.dart';

final starts = DateTime.utc(2026, 10, 12, 7);
final expires = DateTime.utc(2027, 10, 12, 7);
final opens = DateTime.utc(2027, 9, 12, 7);

/// GET /me/fees untuk anggota yang iuran pendaftarannya sudah lunas.
Map<String, Object?> renewalFees({
  bool eligible = true,
  String? ineligibleReason,
  String? openPaymentId,
  DateTime? renewalOpensAt,
  bool instructionsHidden = false,
}) => feesJson(
  registration: feeQuoteJson(type: 'registration', eligible: false, ineligibleReason: 'already_registered'),
  renewal: feeQuoteJson(
    type: 'renewal',
    eligible: eligible,
    ineligibleReason: ineligibleReason,
    openPaymentId: openPaymentId,
    renewalOpensAt: renewalOpensAt,
  ),
  instructionsHidden: instructionsHidden,
);

Future<AppHarness> openRenewal(
  WidgetTester tester, {
  String status = 'verified',
  DateTime? meExpiresAt,
  required Map<String, Object?> membership,
  required Map<String, Object?> fees,
  Map<String, FakeHandler> routes = const {},
  FakeProofPicker? picker,
  bool navigate = true,
  double textScale = 1,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    overrides: [proofPickerProvider.overrideWithValue(picker ?? FakeProofPicker())],
    handler: apiRoutes({
      '/me': (_) => FakeResponse.json(200, meJson(status: status, expiresAt: meExpiresAt ?? expires)),
      '/me/membership': (_) => FakeResponse.json(200, membership),
      '/me/fees': (_) => FakeResponse.json(200, fees),
      '/me/card': (_) => FakeResponse.json(200, memberCardJson(expiresAt: meExpiresAt ?? expires)),
      '/payment-methods': (_) => FakeResponse.json(200, methodsJson()),
      ...routes,
    }),
  );
  await useTallScreen(tester);
  if (navigate) {
    app.router.go('/renewal');
    await settle(tester);
  }
  return app;
}

Finder buttonLabelled(String label) => find.widgetWithText(KapdhButton, label);

void main() {
  testWidgets('AC F07-5: jendela perpanjangan belum dibuka: masa aktif, tanggal pembukaan dan Perpanjang nonaktif', (
    tester,
  ) async {
    final app = await openRenewal(
      tester,
      membership: membershipJson(status: 'verified', startsAt: starts, expiresAt: expires, renewalOpensAt: opens),
      fees: renewalFees(eligible: false, ineligibleReason: 'renewal_window_not_open', renewalOpensAt: opens),
    );

    expect(find.text('Perpanjang KTA'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: KTA Aktif'), findsOneWidget);
    expect(find.text('Masa keanggotaan'), findsOneWidget);
    expect(find.text('12 Okt 2026'), findsOneWidget);
    expect(find.text('Berlaku sampai'), findsOneWidget);
    expect(find.text('12 Okt 2027'), findsOneWidget);
    expect(find.text('Dibuka mulai 12 Sep 2027'), findsOneWidget);
    expect(find.text('Perpanjangan KTA'), findsOneWidget);
    expect(find.text('Rp10.000'), findsWidgets);
    expect(
      find.text('Perpanjangan dibuka mulai 12 Sep 2027, 30 hari sebelum masa aktif berakhir.'),
      findsOneWidget,
    );
    expect(tester.widget<KapdhButton>(buttonLabelled('Perpanjang')).onPressed, isNull);
    expect(app.adapter.requestsTo('/me/payments').where((r) => r.method == 'POST'), isEmpty);
  });

  testWidgets('AC F07-1, AC F03-1: jendela terbuka: alur pembayaran yang sama dengan jenis renewal sampai bukti '
      'menunggu verifikasi', (tester) async {
    final soon = testNow.add(const Duration(days: 20));
    var stage = 'awaiting_transfer';
    final app = await openRenewal(
      tester,
      status: 'expiring',
      meExpiresAt: soon,
      membership: membershipJson(
        status: 'expiring',
        startsAt: starts.subtract(const Duration(days: 345)),
        expiresAt: soon,
        renewalEligible: true,
        renewalOpensAt: soon.subtract(const Duration(days: 30)),
      ),
      fees: renewalFees(),
      routes: {
        '/me/payments': (options) => options.method == 'POST'
            ? FakeResponse.json(201, awaitingTransferJson(type: 'renewal'))
            : FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
        '/me/payments/pay-1': (_) => FakeResponse.json(
          200,
          stage == 'awaiting_transfer' ? awaitingTransferJson(type: 'renewal') : awaitingReviewJson(type: 'renewal'),
        ),
        '/files': (_) => FakeResponse.json(201, fileRefJson()),
        '/me/payments/pay-1/proof': (_) {
          stage = 'awaiting_review';
          return FakeResponse.json(200, awaitingReviewJson(type: 'renewal', proofFileId: 'file-2'));
        },
      },
    );

    expect(find.bySemanticsLabel('Status: Segera Berakhir'), findsOneWidget);
    expect(find.textContaining('sisa masa aktif tidak hilang'), findsOneWidget);
    await tester.tap(buttonLabelled('Lanjut ke pembayaran'));
    await settle(tester);

    final create = app.adapter.requestsTo('/me/payments').where((r) => r.method == 'POST').single;
    expect(bodyOf(create), {'type': 'renewal', 'payment_method_id': 'method-1'});
    expect(app.location, '/payments/pay-1');
    expect(find.text('Iuran perpanjangan'), findsOneWidget);
    expect(find.text('Transfer tepat sebesar'), findsOneWidget);
    expect(find.text('Rp10.000'), findsOneWidget);
    // Langkah pendaftaran tidak tampil untuk perpanjangan.
    expect(find.bySemanticsLabel('Langkah 4 dari 4: Pembayaran'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('proof-upload-tile')));
    await settle(tester);
    await tester.tap(find.text('Pilih dari galeri'));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('proof-submit')));
    await settle(tester);

    final put = app.adapter.requestsTo('/me/payments/pay-1/proof').single;
    expect(bodyOf(put)['expected_proof_version'], 0);
    expect(idempotencyKeyOf(put), isNotEmpty);
    expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
  });

  testWidgets('AC F07-2: anggota expired: rute awal Perpanjang KTA, tanggal berakhir dan perpanjangan dari '
      'verifikasi', (tester) async {
    final past = testNow.subtract(const Duration(days: 3));
    final app = await openRenewal(
      tester,
      status: 'expired',
      meExpiresAt: past,
      navigate: false,
      membership: membershipJson(
        status: 'expired',
        startsAt: past.subtract(const Duration(days: 365)),
        expiresAt: past,
        renewalEligible: true,
        renewalOpensAt: past.subtract(const Duration(days: 30)),
      ),
      fees: renewalFees(),
    );
    await settle(tester);

    expect(app.location, '/renewal');
    expect(find.bySemanticsLabel('Status: KTA Kedaluwarsa'), findsOneWidget);
    expect(find.text('Berakhir'), findsOneWidget);
    expect(find.text('9 Okt 2026'), findsOneWidget);
    expect(find.textContaining('dihitung sejak iuran diverifikasi pengurus'), findsOneWidget);
    expect(tester.widget<KapdhButton>(buttonLabelled('Lanjut ke pembayaran')).onPressed, isNotNull);
  });

  testWidgets('AC F03-1, F03-2: iuran perpanjangan berjalan: Lanjutkan membuka payment yang sama; setelah bukti '
      'terkirim layar perpanjangan memuat status terbaru', (tester) async {
    var meStage = 'awaiting_proof';
    var paymentStage = 'awaiting_transfer';
    Map<String, Object?> renewalPayment() => meMembershipPaymentJson(
      stage: meStage,
      amount: '10000.00',
      proofVersion: meStage == 'awaiting_proof' ? 0 : 1,
    );
    final app = await openRenewal(
      tester,
      status: 'expiring',
      meExpiresAt: testNow.add(const Duration(days: 20)),
      membership: membershipJson(
        status: 'expiring',
        startsAt: starts.subtract(const Duration(days: 345)),
        expiresAt: testNow.add(const Duration(days: 20)),
        renewalEligible: true,
        renewalOpensAt: testNow.subtract(const Duration(days: 10)),
        renewalPayment: renewalPayment(),
      ),
      fees: renewalFees(openPaymentId: 'pay-1'),
      routes: {
        '/me': (_) => FakeResponse.json(200, {
          ...meJson(status: 'expiring', expiresAt: testNow.add(const Duration(days: 20))),
          'renewal_payment': renewalPayment(),
        }),
        '/me/membership': (_) => FakeResponse.json(
          200,
          membershipJson(
            status: 'expiring',
            startsAt: starts.subtract(const Duration(days: 345)),
            expiresAt: testNow.add(const Duration(days: 20)),
            renewalEligible: true,
            renewalOpensAt: testNow.subtract(const Duration(days: 10)),
            renewalPayment: renewalPayment(),
          ),
        ),
        '/me/payments/pay-1': (_) => FakeResponse.json(
          200,
          paymentStage == 'awaiting_transfer'
              ? awaitingTransferJson(type: 'renewal')
              : awaitingReviewJson(type: 'renewal'),
        ),
        '/files': (_) => FakeResponse.json(201, fileRefJson()),
        '/me/payments/pay-1/proof': (_) {
          meStage = 'awaiting_review';
          paymentStage = 'awaiting_review';
          return FakeResponse.json(200, awaitingReviewJson(type: 'renewal', proofFileId: 'file-2'));
        },
      },
    );

    expect(find.byKey(const ValueKey('renewal-open')), findsOneWidget);
    expect(find.textContaining('Instruksi perpanjangan sebesar Rp10.000 sudah dibuat'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('renewal-continue')));
    await settle(tester);
    expect(app.location, '/payments/pay-1');
    expect(app.adapter.requestsTo('/me/payments').where((r) => r.method == 'POST'), isEmpty);

    await tester.tap(find.byKey(const ValueKey('proof-upload-tile')));
    await settle(tester);
    await tester.tap(find.text('Pilih dari galeri'));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('proof-submit')));
    await settle(tester);
    expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);

    await tester.tap(find.byTooltip('Kembali'));
    await settle(tester);
    expect(app.location, '/renewal');
    expect(find.textContaining('Bukti perpanjangan sedang diperiksa pengurus'), findsOneWidget);
  });

  testWidgets('AC F03-3: bukti perpanjangan ditolak: alasan pengurus dan tidak perlu transfer ulang', (tester) async {
    const reason = 'Nominal pada bukti tidak sesuai.';
    await openRenewal(
      tester,
      status: 'expiring',
      meExpiresAt: testNow.add(const Duration(days: 20)),
      membership: membershipJson(
        status: 'expiring',
        expiresAt: testNow.add(const Duration(days: 20)),
        renewalEligible: true,
        renewalPayment: meMembershipPaymentJson(stage: 'rejected', amount: '10000.00', rejectionReason: reason),
      ),
      fees: renewalFees(openPaymentId: 'pay-1'),
    );

    expect(
      find.text('Bukti perpanjangan perlu diperbaiki: $reason. Anda tidak perlu transfer ulang.'),
      findsOneWidget,
    );
    expect(find.text('Lanjutkan pembayaran'), findsOneWidget);
  });

  testWidgets('D13: instruksi iuran disembunyikan untuk platform ini: tanpa tombol bayar, arahan ke pengurus', (
    tester,
  ) async {
    await openRenewal(
      tester,
      status: 'expiring',
      meExpiresAt: testNow.add(const Duration(days: 20)),
      membership: membershipJson(status: 'expiring', expiresAt: testNow.add(const Duration(days: 20))),
      fees: renewalFees(instructionsHidden: true),
    );

    expect(find.byKey(const ValueKey('dues-hidden')), findsOneWidget);
    expect(find.text(duesHiddenMessage), findsOneWidget);
    expect(find.byKey(const ValueKey('renewal-pay')), findsNothing);
    expect(find.text('Lanjut ke pembayaran'), findsNothing);
  });

  testWidgets('F-07: riwayat periode aktivasi dan perpanjangan dari server', (tester) async {
    await openRenewal(
      tester,
      membership: membershipJson(
        status: 'verified',
        startsAt: starts,
        expiresAt: expires,
        renewalOpensAt: opens,
        periods: [
          {
            'kind': 'activation',
            'starts_at': iso(DateTime.utc(2025, 10, 12, 7)),
            'expires_at': iso(starts),
            'approved_at': iso(DateTime.utc(2025, 10, 12, 7)),
            'payment_id': 'pay-0',
          },
          {
            'kind': 'renewal',
            'starts_at': iso(starts),
            'expires_at': iso(expires),
            'approved_at': iso(DateTime.utc(2026, 10, 1, 3)),
            'payment_id': 'pay-1',
          },
        ],
      ),
      fees: renewalFees(eligible: false, ineligibleReason: 'renewal_window_not_open', renewalOpensAt: opens),
    );

    expect(find.text('Riwayat periode'), findsOneWidget);
    expect(find.text('Aktivasi KTA'), findsOneWidget);
    expect(find.text('Perpanjangan KTA'), findsWidgets);
    expect(find.text('12 Okt 2026 - 12 Okt 2027\nDiverifikasi 1 Okt 2026, 10.00 WIB'), findsOneWidget);
  });

  testWidgets('PRD 4.5: gagal memuat masa keanggotaan saat offline: pesan galat lalu coba lagi', (tester) async {
    var online = false;
    await openRenewal(
      tester,
      membership: membershipJson(status: 'verified', startsAt: starts, expiresAt: expires, renewalOpensAt: opens),
      fees: renewalFees(eligible: false, ineligibleReason: 'renewal_window_not_open', renewalOpensAt: opens),
      routes: {
        '/me/membership': (_) => online
            ? FakeResponse.json(
                200,
                membershipJson(status: 'verified', startsAt: starts, expiresAt: expires, renewalOpensAt: opens),
              )
            : FakeResponse.network(),
      },
    );

    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    online = true;
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Masa keanggotaan'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % pada Perpanjang KTA tanpa meluap', (tester) async {
    await openRenewal(
      tester,
      textScale: 2,
      membership: membershipJson(status: 'verified', startsAt: starts, expiresAt: expires, renewalOpensAt: opens),
      fees: renewalFees(eligible: false, ineligibleReason: 'renewal_window_not_open', renewalOpensAt: opens),
    );

    expect(tester.takeException(), isNull);
    expect(find.text('Masa keanggotaan'), findsOneWidget);
  });
}
