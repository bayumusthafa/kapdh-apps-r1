import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/features/auth/register_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

Finder fieldOf(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextFormField));
Finder get submit => find.byKey(const ValueKey('register-submit'));

Future<AppHarness> openRegister(WidgetTester tester, FakeHandler handler, {double textScale = 1}) async {
  final app = await pumpApp(tester, handler: handler, textScale: textScale);
  app.router.go('/register');
  await settle(tester);
  return app;
}

Future<void> choose(WidgetTester tester, String key, String item) async {
  await scrollAndTap(tester, find.byKey(ValueKey(key)));
  await settle(tester);
  await tester.tap(find.text(item).last);
  await settle(tester);
}

Future<void> fillForm(WidgetTester tester, {String email = 'ahmad.islam@email.com'}) async {
  await tester.enterText(fieldOf('register-name'), 'Ahmad Islam');
  await choose(tester, 'register-gender', 'Laki-laki');
  await scrollTo(tester, fieldOf('register-email'));
  await tester.enterText(fieldOf('register-email'), email);
  await scrollTo(tester, fieldOf('register-password'));
  await tester.enterText(fieldOf('register-password'), 'Rahasia#123');
  await tester.pump();
  await choose(tester, 'register-cohort', 'Angkatan 29 (lulus 2025)');
  await choose(tester, 'register-class-in', 'Kelas 1 (1 MTs)');
  await choose(tester, 'register-class-out', 'Kelas 6 (3 Aliyah)');
  await scrollAndTap(tester, find.byKey(const ValueKey('register-consent')));
  await settle(tester);
}

void main() {
  test('versi kebijakan yang disetujui mencatat kedua halaman legal', () {
    expect(policyVersionString(privacy: '2026-10', terms: '3'), 'kebijakan-privasi@2026-10;ketentuan@3');
  });

  testWidgets('Data Diri tanpa Nomor KTP; pratinjau tahun akademik; kirim membuat challenge OTP (AC F01-1)', (
    tester,
  ) async {
    final app = await openRegister(
      tester,
      apiRoutes({'/auth/register': (_) => FakeResponse.json(201, otpChallengeJson())}),
    );
    expect(find.text('Daftar Alumni'), findsOneWidget);
    expect(find.bySemanticsLabel('Langkah 1 dari 4: Data Diri'), findsOneWidget);
    expect(find.textContaining('KTP'), findsNothing);

    await fillForm(tester);
    expect(find.text('Perhitungan Tahun Akademik'), findsOneWidget);
    expect(find.text('2019'), findsOneWidget);
    expect(find.text('2025'), findsNWidgets(2));

    await scrollAndTap(tester, submit);
    await settle(tester);

    final request = app.adapter.requestsTo('/auth/register').single;
    expect(request.headers['Idempotency-Key'], isA<String>());
    expect(request.data, {
      'full_name': 'Ahmad Islam',
      'gender': 'male',
      'email': 'ahmad.islam@email.com',
      'password': 'Rahasia#123',
      'cohort': 29,
      'class_in': 1,
      'class_out': 6,
      'accept_policy_version': 'kebijakan-privasi@2026-10;ketentuan@2026-10',
    });
    expect(app.location, '/register/otp');
    expect(app.container.read(sessionProvider).challenge?.challengeId, 'challenge-1');
  });

  testWidgets('jaringan putus lalu kirim ulang memakai Idempotency-Key yang sama (AC F01-4)', (tester) async {
    var attempts = 0;
    final app = await openRegister(
      tester,
      apiRoutes({
        '/auth/register': (_) => ++attempts == 1 ? FakeResponse.network() : FakeResponse.json(201, otpChallengeJson()),
      }),
    );
    await fillForm(tester);
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(find.textContaining('Tidak dapat terhubung'), findsOneWidget);
    expect(find.text('Ahmad Islam'), findsOneWidget, reason: 'isian tetap tersimpan setelah gagal jaringan (PRD 4.5)');

    await scrollAndTap(tester, submit);
    await settle(tester);

    final keys = app.adapter.requestsTo('/auth/register').map((r) => r.headers['Idempotency-Key']).toList();
    expect(keys, hasLength(2));
    expect(keys.first, keys.last);
    expect(app.location, '/register/otp');
  });

  testWidgets('email terdaftar: galat server di field email', (tester) async {
    await openRegister(
      tester,
      apiRoutes({
        '/auth/register': (_) => FakeResponse.json(
          409,
          errorJson(
            'VALIDATION_ERROR',
            'Periksa isian.',
            fieldErrors: {
              'email': ['Email sudah terdaftar'],
            },
          ),
        ),
      }),
    );
    await fillForm(tester);
    await scrollAndTap(tester, submit);
    await settle(tester);
    await scrollTo(tester, find.text('Email sudah terdaftar'));
    expect(find.text('Email sudah terdaftar'), findsOneWidget);
  });

  testWidgets('validasi lokal dan persetujuan wajib sebelum mengirim', (tester) async {
    final app = await openRegister(tester, apiRoutes({}));
    await scrollAndTap(tester, submit);
    await settle(tester);
    expect(app.adapter.requestsTo('/auth/register'), isEmpty);
    expect(find.text('Setujui Kebijakan Privasi dan Ketentuan untuk melanjutkan.'), findsOneWidget);
    await scrollTo(tester, find.text('Isi nama lengkap'));
    expect(find.text('Isi nama lengkap'), findsOneWidget);
  });

  testWidgets('versi kebijakan gagal dimuat: peringatan dengan coba lagi', (tester) async {
    await openRegister(tester, apiRoutes({'/public/pages/kebijakan-privasi': (_) => FakeResponse.network()}));
    await scrollTo(tester, find.text('Versi kebijakan belum dapat dimuat. Periksa koneksi Anda.'));
    expect(find.text('Versi kebijakan belum dapat dimuat. Periksa koneksi Anda.'), findsOneWidget);
  });

  testWidgets('teks 200 % tanpa meluap', (tester) async {
    await openRegister(tester, apiRoutes({}), textScale: 2);
    expect(tester.takeException(), isNull);
    await scrollTo(tester, submit);
    expect(tester.takeException(), isNull);
  });
}
