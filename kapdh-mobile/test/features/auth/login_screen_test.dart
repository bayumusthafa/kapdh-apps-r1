import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/auth/auth_flow.dart';
import 'package:kapdh_mobile/features/auth/login_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

Finder get emailField =>
    find.descendant(of: find.byKey(const ValueKey('login-email')), matching: find.byType(TextFormField));
Finder get passwordField =>
    find.descendant(of: find.byKey(const ValueKey('login-password')), matching: find.byType(TextFormField));
Finder get submit => find.byKey(const ValueKey('login-submit'));

bool submitEnabled(WidgetTester tester) => tester.widget<KapdhButton>(submit).onPressed != null;

Future<void> fillAndSubmit(
  WidgetTester tester, {
  String email = 'ahmad@email.com',
  String password = 'Rahasia#123',
}) async {
  await tester.enterText(emailField, email);
  await tester.enterText(passwordField, password);
  await tester.pump();
  await scrollAndTap(tester, submit);
  await settle(tester);
}

void main() {
  testWidgets('anonim diarahkan dari splash ke login (guideline hal. 5)', (tester) async {
    await pumpApp(tester, handler: apiRoutes({}));
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.textContaining('Datang kembali !!!'), findsOneWidget);
    expect(find.text('Masuk untuk melanjutkan silaturahmi bersama alumni'), findsOneWidget);
    expect(find.text('Email'), findsOneWidget);
    expect(find.text('Password'), findsOneWidget);
    expect(find.text('Lupa Password'), findsOneWidget);
    expect(find.text('Daftar'), findsOneWidget);
    expect(submitEnabled(tester), isFalse);

    await tester.enterText(emailField, 'ahmad@email.com');
    await tester.enterText(passwordField, 'x');
    await tester.pump();
    expect(submitEnabled(tester), isTrue);
  });

  testWidgets('password salah (401): pesan server tampil, tidak ada refresh dan tetap di login', (tester) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Email atau password salah.')),
      }),
    );
    await fillAndSubmit(tester);
    expect(find.text('Email atau password salah.'), findsOneWidget);
    expect(app.adapter.requestsTo('/auth/refresh'), isEmpty);
    expect(app.location, '/login');
  });

  testWidgets('galat per field dari server ditampilkan di field', (tester) async {
    await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(
          400,
          errorJson(
            'VALIDATION_ERROR',
            'Periksa isian.',
            fieldErrors: {
              'email': ['Format email tidak valid'],
            },
          ),
        ),
      }),
    );
    await fillAndSubmit(tester, email: 'bukan-email');
    expect(find.text('Format email tidak valid'), findsOneWidget);
  });

  testWidgets('RATE_LIMITED: tombol menampilkan hitung mundur dan nonaktif', (tester) async {
    await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) =>
            FakeResponse.json(429, errorJson('RATE_LIMITED', 'Terlalu banyak percobaan.', retryAfterSeconds: 90)),
      }),
    );
    await fillAndSubmit(tester);
    expect(find.text('Terlalu banyak percobaan.'), findsOneWidget);
    expect(find.text('Coba lagi dalam 1:30'), findsOneWidget);
    expect(submitEnabled(tester), isFalse);
  });

  testWidgets('offline: pesan koneksi, bukan "tidak ditemukan"', (tester) async {
    await pumpApp(tester, handler: apiRoutes({'/auth/login': (_) => FakeResponse.network()}));
    await fillAndSubmit(tester);
    expect(find.textContaining('Tidak dapat terhubung'), findsOneWidget);
  });

  testWidgets('berhasil: token tersimpan dan router membuka rute status (verified → Beranda)', (tester) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
        '/me': (_) => FakeResponse.json(200, meJson()),
      }),
    );
    await fillAndSubmit(tester);
    expect(app.location, '/home');
    expect(find.text('Beranda'), findsWidgets);
    expect(app.container.read(sessionProvider).userId, 'user-1');
  });

  testWidgets('deep link tertunda dibuka setelah login (AC F13-3)', (tester) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
        '/me': (_) => FakeResponse.json(200, meJson()),
      }),
    );
    app.router.go('/payments/pay-1');
    await settle(tester);
    expect(app.location, '/login?from=%2Fpayments%2Fpay-1');

    await fillAndSubmit(tester);
    expect(app.location, '/payments/pay-1');
    expect(find.text('Status Pembayaran'), findsWidgets);
  });

  testWidgets('F-02, guideline hal. 5: pita hijau bermotif dengan logo, "Datang kembali !!!" emas, toggle password', (
    tester,
  ) async {
    await pumpApp(tester, handler: apiRoutes({}));
    final header = tester.widget<BrandHeader>(find.byType(BrandHeader));
    expect(header.pattern, isTrue);
    expect(find.bySemanticsLabel('Logo KAPDH'), findsOneWidget);

    final greeting = tester.widget<Text>(find.textContaining('Datang kembali !!!'));
    final spans = (greeting.textSpan! as TextSpan).children!.cast<TextSpan>();
    expect(spans.firstWhere((s) => s.text == 'Datang kembali !!!').style!.color, KapdhColors.accent);
    expect(spans.firstWhere((s) => s.text!.startsWith('Selamat')).style!.color, KapdhColors.textOnDark);

    TextField password() => tester.widget<TextField>(
      find.descendant(of: find.byKey(const ValueKey('login-password')), matching: find.byType(TextField)),
    );
    expect(password().obscureText, isTrue);
    await tester.tap(find.byTooltip('Tampilkan password'));
    await tester.pump();
    expect(password().obscureText, isFalse);
    await tester.tap(find.byTooltip('Sembunyikan password'));
    await tester.pump();
    expect(password().obscureText, isTrue);

    final forgot = tester.widget<TextButton>(find.byKey(const ValueKey('login-forgot')));
    expect(forgot.style!.textStyle!.resolve({})!.decoration, TextDecoration.underline);
    expect(tester.getSize(find.byKey(const ValueKey('login-forgot'))).height, greaterThanOrEqualTo(48));
  });

  testWidgets('F-02: Lupa Password membuka pemulihan dengan email yang sudah diketik', (tester) async {
    final app = await pumpApp(tester, handler: apiRoutes({}));
    await tester.enterText(emailField, 'ahmad@email.com');
    await tester.pump();
    await scrollAndTap(tester, find.byKey(const ValueKey('login-forgot')));
    await settle(tester);
    expect(app.location, '/forgot');
    expect(find.text('ahmad@email.com'), findsOneWidget);
  });

  testWidgets('AC F02-1: login akun pending_otp yang emailnya pernah dikoreksi membuka OTP email_change', (
    tester,
  ) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) =>
            FakeResponse.json(200, {'next': 'verify_otp', 'challenge': otpChallengeJson(purpose: 'email_change')}),
      }),
    );
    await fillAndSubmit(tester, email: 'ahmad.benar@email.com');
    expect(app.location, '/register/otp');
    expect(find.textContaining('dikirim ke email baru ahmad.benar@email.com'), findsOneWidget);
    // Kredensial hanya di memori untuk pemulihan hasil verifikasi yang tidak diketahui (kontrak C1).
    expect(app.container.read(activationCredentialsProvider)?.email, 'ahmad.benar@email.com');
  });

  testWidgets('akun pending_otp diarahkan ke OTP dengan challenge baru (AC F02-1)', (tester) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {'next': 'verify_otp', 'challenge': otpChallengeJson()}),
      }),
    );
    await fillAndSubmit(tester);
    expect(app.location, '/register/otp');
    expect(find.text('Masukkan kode verifikasi'), findsOneWidget);
  });

  testWidgets('akun deletion_pending: status penghapusan tampil di login, tanpa sesi (F-14, PRD 2.2)', (tester) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {
          'next': 'deletion_pending',
          'deletion': {
            'request_number': 'DEL-2026-7K3Q9X',
            'status': 'pending',
            'source': 'app',
            'requested_at': testNow.toIso8601String(),
            'estimated_completion_at': DateTime.utc(2026, 10, 19, 3).toIso8601String(),
            'completed_at': null,
          },
        }),
      }),
    );
    await fillAndSubmit(tester);
    expect(app.location, '/login');
    expect(find.text('Penghapusan akun sedang diproses'), findsOneWidget);
    expect(find.textContaining('DEL-2026-7K3Q9X (Permintaan Diterima)'), findsOneWidget);
    expect(find.textContaining('19 Okt 2026, 10.00 WIB'), findsOneWidget);
    expect(find.text('Hubungi pengurus'), findsOneWidget);
    expect(app.container.read(sessionProvider).hasSession, isFalse);
    expect(app.adapter.requestsTo('/me'), isEmpty);
  });

  testWidgets('akun disabled: pesan akun tidak aktif dan kontak pengurus, tanpa sesi (PRD 2.2)', (tester) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {'next': 'account_disabled'}),
      }),
    );
    await fillAndSubmit(tester);
    expect(app.location, '/login');
    expect(find.text('Akun tidak aktif'), findsOneWidget);
    expect(find.text('Hubungi pengurus'), findsOneWidget);
    expect(app.container.read(sessionProvider).hasSession, isFalse);
  });

  testWidgets('teks 200 %: tidak meluap dan tombol tetap dapat dijangkau (N-11)', (tester) async {
    await pumpApp(tester, handler: apiRoutes({}), textScale: 2);
    expect(tester.takeException(), isNull);
    await scrollTo(tester, submit);
    expect(tester.takeException(), isNull);
    expect(tester.getSize(submit).height, greaterThanOrEqualTo(52));
  });

  for (final (size, keyboard) in [(const Size(390, 844), 336.0), (const Size(360, 640), 280.0)]) {
    testWidgets(
      'teks 200 % dengan keyboard terbuka di ${size.width.toInt()}x${size.height.toInt()}: tidak meluap, kepala '
      'ikut bergulir (N-11)',
      (tester) async {
        await pumpApp(tester, handler: apiRoutes({}), textScale: 2);
        tester.view.physicalSize = size;
        tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
        addTearDown(tester.view.resetViewInsets);
        await tester.pump();
        expect(tester.takeException(), isNull);

        await tester.tap(emailField);
        await tester.pump();
        await tester.enterText(emailField, 'ahmad@email.com');
        await tester.enterText(passwordField, 'Rahasia#123');
        await tester.pump();
        expect(tester.takeException(), isNull);
        await scrollTo(tester, submit);
        expect(tester.takeException(), isNull);
        expect(submitEnabled(tester), isTrue);
        // Tombol masuk dapat dijangkau di atas keyboard.
        expect(tester.getBottomLeft(submit).dy, lessThanOrEqualTo(size.height - keyboard));
      },
    );
  }
}
