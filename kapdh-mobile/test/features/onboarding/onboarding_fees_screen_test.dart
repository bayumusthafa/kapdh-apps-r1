import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/payments/payment_presentation.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../payments/payments_fixtures.dart';

/// Anggota unverified yang baru lolos OTP: rute awal Biaya KTA (routeForStatus, AC F01-2).
Future<AppHarness> openFees(
  WidgetTester tester, {
  Map<String, Object?>? me,
  Map<String, FakeHandler> routes = const {},
  double textScale = 1,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    handler: apiRoutes({
      '/me': (_) => FakeResponse.json(200, me ?? meJson(status: 'unverified')),
      '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      '/me/membership': (_) => FakeResponse.json(200, membershipJson()),
      '/payment-methods': (_) => FakeResponse.json(200, methodsJson()),
      ...routes,
    }),
  );
  await useTallScreen(tester);
  await settle(tester);
  return app;
}

/// GET /me unverified dengan penunjuk iuran pendaftaran (kontrak C2 `registration_payment`).
Map<String, Object?> meWithRegistration(Map<String, Object?> payment) => {
  ...meJson(status: 'unverified'),
  'registration_payment': payment,
};

void main() {
  testWidgets('AC F01-2, AC F05-1, AC F03-1: Biaya KTA (prototipe layar 2): langkah 3, KTA Tidak Aktif bernomor, '
      'rincian iuran dari server, lalu instruksi bayar dibuat server', (tester) async {
    final app = await openFees(
      tester,
      routes: {
        '/me/payments': (options) => FakeResponse.json(201, awaitingTransferJson()),
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
      },
    );

    expect(app.location, '/onboarding/fees');
    expect(find.text('Daftar Alumni'), findsOneWidget);
    // Layar pertama setelah OTP: tidak ada tujuan kembali.
    expect(find.byTooltip('Kembali'), findsNothing);
    expect(find.bySemanticsLabel('Langkah 3 dari 4: Biaya KTA'), findsOneWidget);
    expect(find.text('KTA Anda sudah dibuat'), findsOneWidget);
    expect(find.text('KTA akan aktif setelah iuran pendaftaran diverifikasi pengurus.'), findsOneWidget);
    expect(find.text('Ahmad Islam'), findsOneWidget);
    expect(find.text('Angkatan 29 | Lulus 2025'), findsOneWidget);
    expect(find.text('29.01.01.7'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: KTA Tidak Aktif'), findsOneWidget);
    expect(find.text('Rincian iuran pendaftaran'), findsOneWidget);
    expect(find.text('Register alumni baru'), findsOneWidget);
    expect(find.text('Rp50.000'), findsOneWidget);
    expect(find.text('Pembuatan KTA'), findsOneWidget);
    expect(find.text('Rp10.000'), findsOneWidget);
    expect(find.text('Total'), findsOneWidget);
    expect(find.text('Rp60.000'), findsOneWidget);
    expect(
      find.text('Masa aktif 12 bulan sejak iuran diverifikasi. Perpanjangan berikutnya Rp10.000 per tahun.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Lanjut ke pembayaran'));
    await settle(tester);

    final create = app.adapter.requestsTo('/me/payments').single;
    expect(create.method, 'POST');
    // Nominal tidak dikirim klien (PRD 3.3).
    expect(bodyOf(create), {'type': 'registration', 'payment_method_id': 'method-1'});
    expect(idempotencyKeyOf(create), isNotEmpty);
    expect(app.location, '/payments/pay-1');
    expect(find.text('Transfer tepat sebesar'), findsOneWidget);
    expect(find.text('Rp60.000'), findsOneWidget);
  });

  testWidgets('AC F03-1: instruksi sudah ada: Lanjutkan pembayaran membuka payment_id yang sama tanpa instruksi baru', (
    tester,
  ) async {
    final app = await openFees(
      tester,
      routes: {
        '/me/fees': (_) => FakeResponse.json(
          200,
          feesJson(
            registration: feeQuoteJson(type: 'registration', openPaymentId: 'pay-1'),
          ),
        ),
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
      },
    );

    expect(find.text('Lanjutkan pembayaran'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('fees-continue')));
    await settle(tester);

    expect(app.location, '/payments/pay-1');
    expect(app.adapter.requestsTo('/me/payments'), isEmpty);
    expect(find.text('Transfer tepat sebesar'), findsOneWidget);
  });

  testWidgets('AC F03-2: bukti sudah dikirim (prototipe layar 4): Biaya KTA langsung membuka status menunggu', (
    tester,
  ) async {
    final app = await openFees(
      tester,
      me: meWithRegistration(meMembershipPaymentJson()),
      routes: {'/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson())},
    );

    expect(app.location, '/payments/pay-1');
    expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
  });

  testWidgets('AC F03-3: bukti ditolak (prototipe layar 5): Biaya KTA langsung membuka catatan dan unggah ulang', (
    tester,
  ) async {
    const reason = 'Foto bukti buram sehingga nominal tidak terbaca.';
    final app = await openFees(
      tester,
      me: meWithRegistration(meMembershipPaymentJson(stage: 'rejected', rejectionReason: reason)),
      routes: {'/me/payments/pay-1': (_) => FakeResponse.json(200, needsFixJson(reason: reason))},
    );

    expect(app.location, '/payments/pay-1');
    expect(find.text(reason), findsOneWidget);
    expect(find.text('Unggah ulang bukti'), findsOneWidget);
  });

  testWidgets('D13: instruksi iuran disembunyikan untuk platform ini: tanpa tombol bayar, arahan ke pengurus', (
    tester,
  ) async {
    final app = await openFees(
      tester,
      routes: {'/me/fees': (_) => FakeResponse.json(200, feesJson(instructionsHidden: true))},
    );

    expect(find.byKey(const ValueKey('dues-hidden')), findsOneWidget);
    expect(find.text(duesHiddenMessage), findsOneWidget);
    expect(find.text('Hubungi pengurus'), findsOneWidget);
    expect(find.byKey(const ValueKey('fees-continue')), findsNothing);
    expect(find.text('Lanjut ke pembayaran'), findsNothing);
    expect(app.adapter.requestsTo('/me/payments'), isEmpty);
  });

  testWidgets('AC F07-5: iuran pendaftaran sudah lunas (data usang): tanpa tombol bayar, arahan ke KTA', (
    tester,
  ) async {
    await openFees(
      tester,
      routes: {
        '/me/fees': (_) => FakeResponse.json(
          200,
          feesJson(
            registration: feeQuoteJson(type: 'registration', eligible: false, ineligibleReason: 'already_registered'),
          ),
        ),
      },
    );

    expect(find.byKey(const ValueKey('fees-continue')), findsNothing);
    expect(find.text('Iuran pendaftaran Anda sudah lunas. KTA dapat dilihat di menu KTA.'), findsOneWidget);
    expect(find.widgetWithText(KapdhButton, 'Lihat KTA'), findsOneWidget);
  });

  testWidgets('PRD 4.5: rincian iuran gagal dimuat saat offline: pesan galat, coba lagi menampilkan rincian', (
    tester,
  ) async {
    var online = false;
    await openFees(
      tester,
      routes: {'/me/fees': (_) => online ? FakeResponse.json(200, feesJson()) : FakeResponse.network()},
    );

    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    expect(find.bySemanticsLabel('Langkah 3 dari 4: Biaya KTA'), findsOneWidget);
    online = true;
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);

    expect(find.text('Rincian iuran pendaftaran'), findsOneWidget);
    expect(find.text('Lanjut ke pembayaran'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % pada Biaya KTA tanpa meluap', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: 2,
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
        '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      }),
    );

    expect(app.location, '/onboarding/fees');
    expect(tester.takeException(), isNull);
    expect(find.text('Lanjut ke pembayaran'), findsOneWidget);
  });
}
