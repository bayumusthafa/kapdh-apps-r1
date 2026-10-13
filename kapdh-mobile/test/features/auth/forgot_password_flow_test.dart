import 'dart:io' show HttpDate;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/auth/auth_flow.dart';
import 'package:kapdh_mobile/features/auth/forgot_otp_screen.dart';
import 'package:kapdh_mobile/features/auth/forgot_password_screen.dart';
import 'package:kapdh_mobile/features/auth/login_screen.dart';
import 'package:kapdh_mobile/features/auth/reset_password_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

Finder fieldOf(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextFormField));
Finder get otpInput => find.byKey(const ValueKey('otp-input'));
Finder get verifyButton => find.byKey(const ValueKey('otp-submit'));
Finder get resendButton => find.byKey(const ValueKey('otp-resend'));

Map<String, Object?> resetChallengeJson({
  String id = 'reset-challenge-1',
  String emailMasked = 'ah***@email.com',
  DateTime? resendAvailableAt,
  int attemptsLeft = 5,
}) => otpChallengeJson(
  id: id,
  purpose: 'password_reset',
  emailMasked: emailMasked,
  resendAvailableAt: resendAvailableAt,
  attemptsLeft: attemptsLeft,
);

Map<String, Object?> grantJson({DateTime? expiresAt}) => {
  'reset_token': 'reset-token-rahasia',
  'expires_at': (expiresAt ?? testNow.add(const Duration(minutes: 10))).toUtc().toIso8601String(),
};

/// Penangan alur pemulihan yang berhasil; [overrides] mengganti endpoint tertentu.
FakeHandler recoveryRoutes([Map<String, FakeHandler> overrides = const {}]) => apiRoutes({
  '/auth/password/forgot': (_) => FakeResponse.json(202, resetChallengeJson()),
  '/auth/password/forgot/verify': (_) => FakeResponse.json(200, grantJson()),
  '/auth/password/reset': (_) => FakeResponse.json(204),
  ...overrides,
});

Future<AppHarness> openForgot(WidgetTester tester, FakeHandler handler, {double textScale = 1}) async {
  final app = await pumpApp(tester, handler: handler, textScale: textScale);
  app.router.go('/forgot');
  await settle(tester);
  return app;
}

Future<void> requestCode(WidgetTester tester, {String email = 'ahmad.islam@email.com'}) async {
  await tester.enterText(fieldOf('forgot-email'), email);
  await scrollAndTap(tester, find.byKey(const ValueKey('forgot-submit')));
  await settle(tester);
}

/// Sampai ke layar Password Baru lewat email dan kode yang benar.
Future<AppHarness> openReset(WidgetTester tester, FakeHandler handler, {double textScale = 1}) async {
  final app = await openForgot(tester, handler, textScale: textScale);
  await requestCode(tester);
  await tester.enterText(otpInput, '482913');
  await settle(tester);
  return app;
}

Future<void> enterNewPassword(WidgetTester tester, String password, {String? confirm}) async {
  await scrollTo(tester, fieldOf('reset-password'));
  await tester.enterText(fieldOf('reset-password'), password);
  await scrollTo(tester, fieldOf('reset-confirm'));
  await tester.enterText(fieldOf('reset-confirm'), confirm ?? password);
  await tester.pump();
}

Future<void> saveNewPassword(WidgetTester tester) async {
  await scrollAndTap(tester, find.byKey(const ValueKey('reset-submit')));
  await settle(tester);
}

void main() {
  group('Lupa Password: email (F-02, PRD 2.5)', () {
    testWidgets('AC F02-4: email dikirim lalu layar kode pemulihan dengan salinan non-enumerasi', (tester) async {
      final app = await openForgot(tester, recoveryRoutes());
      expect(find.byType(ForgotPasswordScreen), findsOneWidget);
      expect(find.bySemanticsLabel('Langkah 1 dari 3: Email'), findsOneWidget);
      expect(find.text(forgotPasswordNeutralCopy), findsOneWidget);

      await requestCode(tester, email: '  ahmad.islam@email.com ');

      expect(app.adapter.requestsTo('/auth/password/forgot').single.data, {'email': 'ahmad.islam@email.com'});
      expect(app.location, '/forgot/otp');
      expect(find.byType(ForgotOtpScreen), findsOneWidget);
      expect(find.bySemanticsLabel('Langkah 2 dari 3: Kode OTP'), findsOneWidget);
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);
      // PRD 2.5: tidak menyatakan email terdaftar; hanya "bila terdaftar dan aktif".
      expect(find.textContaining('Bila akun dengan email ahmad.islam@email.com terdaftar dan aktif'), findsOneWidget);
      expect(find.textContaining('Kode berlaku 10 menit'), findsOneWidget);
      expect(find.textContaining('tidak terdaftar'), findsNothing);
      expect(app.container.read(sessionProvider).challenge?.purpose, OtpPurpose.passwordReset);
    });

    testWidgets('PRD 2.5: email tidak terdaftar mendapat jawaban dan layar yang sama (challenge pengganti)', (
      tester,
    ) async {
      // Server mengembalikan challenge pengganti berbentuk sama untuk email yang tidak terdaftar.
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/password/forgot': (_) =>
              FakeResponse.json(202, resetChallengeJson(id: 'pengganti-1', emailMasked: 'ti***@email.com')),
          '/auth/password/forgot/verify': (_) => FakeResponse.json(
            400,
            errorJson(
              'VALIDATION_ERROR',
              'Kode salah. Sisa percobaan 4.',
              fieldErrors: {
                'code': ['Kode salah. Sisa percobaan 4.'],
              },
            ),
          ),
        }),
      );
      await requestCode(tester, email: 'tidak.ada@email.com');
      expect(app.location, '/forgot/otp');
      expect(find.textContaining('Bila akun dengan email tidak.ada@email.com terdaftar dan aktif'), findsOneWidget);
      await tester.enterText(otpInput, '111111');
      await settle(tester);
      expect(find.text('Sisa percobaan: 4 dari 5'), findsOneWidget);
    });

    testWidgets('PRD 2.5: batas kirim (429) menampilkan hitung mundur pada tombol', (tester) async {
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/password/forgot': (_) => FakeResponse.json(
            429,
            errorJson('RATE_LIMITED', 'Terlalu banyak permintaan kode.', retryAfterSeconds: 90),
          ),
        }),
      );
      await requestCode(tester);
      expect(find.text('Terlalu banyak permintaan kode.'), findsOneWidget);
      expect(find.text('Coba lagi dalam 1:30'), findsOneWidget);
      expect(tester.widget<KapdhButton>(find.byKey(const ValueKey('forgot-submit'))).onPressed, isNull);
      expect(app.location, '/forgot');

      app.clock.advance(const Duration(seconds: 91));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Kirim kode'), findsOneWidget);
    });

    testWidgets('validasi email lokal sebelum dikirim', (tester) async {
      final app = await openForgot(tester, recoveryRoutes());
      await requestCode(tester, email: 'bukan-email');
      expect(find.text('Masukkan email yang valid'), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/password/forgot'), isEmpty);
    });

    testWidgets('offline: pesan koneksi dan email tetap terisi (PRD 4.5)', (tester) async {
      await openForgot(tester, recoveryRoutes({'/auth/password/forgot': (_) => FakeResponse.network()}));
      await requestCode(tester);
      expect(find.textContaining('Tidak dapat terhubung'), findsOneWidget);
      expect(find.text('ahmad.islam@email.com'), findsOneWidget);
    });

    testWidgets('PRD 2.5: cooldown login tidak menutup Lupa Password; email dari login diisi otomatis', (tester) async {
      final app = await pumpApp(
        tester,
        handler: recoveryRoutes({
          '/auth/login': (_) =>
              FakeResponse.json(429, errorJson('RATE_LIMITED', 'Terlalu banyak percobaan.', retryAfterSeconds: 900)),
        }),
      );
      await tester.enterText(fieldOf('login-email'), 'ahmad.islam@email.com');
      await tester.enterText(fieldOf('login-password'), 'Salah#123');
      await tester.pump();
      await scrollAndTap(tester, find.byKey(const ValueKey('login-submit')));
      await settle(tester);
      expect(find.text('Coba lagi dalam 15:00'), findsOneWidget);
      expect(find.textContaining('tetap dapat memulihkan akun lewat Lupa Password'), findsOneWidget);

      await scrollAndTap(tester, find.byKey(const ValueKey('login-forgot')));
      await settle(tester);
      expect(app.location, '/forgot');
      expect(find.text('ahmad.islam@email.com'), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('forgot-submit')));
      await settle(tester);
      expect(app.location, '/forgot/otp');
    });

    testWidgets('kembali dari kode ke email dapat melanjutkan kode yang sudah dikirim', (tester) async {
      final app = await openForgot(tester, recoveryRoutes());
      await requestCode(tester);
      await tester.tap(find.byTooltip('Kembali'));
      await settle(tester);
      expect(app.location, '/forgot');
      await scrollAndTap(tester, find.byKey(const ValueKey('forgot-continue')));
      await settle(tester);
      expect(app.location, '/forgot/otp');
      expect(app.adapter.requestsTo('/auth/password/forgot'), hasLength(1));
    });
  });

  group('Lupa Password: kode pemulihan (AC F02-4, PRD 2.5)', () {
    testWidgets('AC F02-4: kode benar ditukar reset_token lalu layar Password Baru', (tester) async {
      final app = await openReset(tester, recoveryRoutes());
      expect(app.adapter.requestsTo('/auth/password/forgot/verify').single.data, {
        'challenge_id': 'reset-challenge-1',
        'code': '482913',
      });
      expect(app.location, '/forgot/reset');
      expect(find.byType(ResetPasswordScreen), findsOneWidget);
      expect(find.bySemanticsLabel('Langkah 3 dari 3: Password Baru'), findsOneWidget);
      final session = app.container.read(sessionProvider);
      expect(session.resetToken, 'reset-token-rahasia');
      expect(session.challenge, isNull, reason: 'challenge pemulihan sudah dikonsumsi');
    });

    testWidgets('AC F01-3: kode salah menampilkan sisa percobaan; percobaan habis menawarkan kode baru', (
      tester,
    ) async {
      var left = 2;
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/password/forgot/verify': (_) {
            left--;
            if (left < 0) return FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Kode tidak berlaku lagi.'));
            return FakeResponse.json(
              400,
              errorJson(
                'VALIDATION_ERROR',
                'Kode salah. Sisa percobaan $left.',
                fieldErrors: {
                  'code': ['Kode salah. Sisa percobaan $left.'],
                },
              ),
            );
          },
        }),
      );
      await requestCode(tester);
      await tester.enterText(otpInput, '111111');
      await settle(tester);
      expect(find.text('Sisa percobaan: 1 dari 5'), findsOneWidget);
      expect(tester.widget<TextField>(otpInput).controller!.text, isEmpty);
      await tester.enterText(otpInput, '222222');
      await settle(tester);
      expect(find.text('Kode tidak berlaku lagi. Minta kode baru.'), findsOneWidget);
      expect(tester.widget<KapdhButton>(verifyButton).onPressed, isNull);
      expect(app.location, '/forgot/otp');
    });

    testWidgets('PRD 2.5: kirim ulang setelah cooldown mengganti challenge', (tester) async {
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/otp/resend': (_) => FakeResponse.json(
            200,
            resetChallengeJson(id: 'reset-challenge-2', resendAvailableAt: testNow.add(const Duration(seconds: 103))),
          ),
        }),
      );
      await requestCode(tester);
      expect(find.text('Kirim ulang dalam 0:42'), findsOneWidget);
      app.clock.advance(const Duration(seconds: 43));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(resendButton);
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/otp/resend').single.data, {'challenge_id': 'reset-challenge-1'});
      expect(app.container.read(sessionProvider).challenge?.challengeId, 'reset-challenge-2');
      expect(find.text('Kode baru dikirim bila email terdaftar dan aktif.'), findsOneWidget);
      expect(find.text('Kirim ulang dalam 1:00'), findsOneWidget);
    });

    testWidgets('kirim ulang 410: challenge tidak dapat diperbarui, mulai ulang dari email', (tester) async {
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/otp/resend': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Mulai ulang lupa password.')),
        }),
      );
      await requestCode(tester);
      app.clock.advance(const Duration(seconds: 43));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(resendButton);
      await settle(tester);
      await scrollAndTap(tester, find.byKey(const ValueKey('otp-restart')));
      await settle(tester);
      expect(app.location, '/forgot');
      expect(find.text('ahmad.islam@email.com'), findsOneWidget, reason: 'email terakhir diisi otomatis');
      expect(app.container.read(sessionProvider).challenge, isNull);
    });

    testWidgets('kontrak C1: respons verifikasi hilang lalu 410 berarti kode sudah terpakai; minta kode baru', (
      tester,
    ) async {
      var attempts = 0;
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/password/forgot/verify': (_) => ++attempts == 1
              ? FakeResponse.network()
              : FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Kode tidak berlaku lagi.')),
        }),
      );
      await requestCode(tester);
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(find.textContaining('Koneksi terputus sebelum hasil verifikasi diterima'), findsOneWidget);
      expect(tester.widget<TextField>(otpInput).controller!.text, '482913', reason: 'kode dipertahankan');

      await scrollAndTap(tester, verifyButton);
      await settle(tester);
      expect(find.text('Kode sudah terpakai'), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/otp/resend'), isEmpty, reason: 'tidak langsung meminta kode baru');
      await scrollAndTap(tester, find.byKey(const ValueKey('otp-restart')));
      await settle(tester);
      expect(app.location, '/forgot');
    });

    testWidgets('verifikasi ditolak RATE_LIMITED: tombol Verifikasi nonaktif sampai jeda selesai', (tester) async {
      final app = await openForgot(
        tester,
        recoveryRoutes({
          '/auth/password/forgot/verify': (_) =>
              FakeResponse.json(429, errorJson('RATE_LIMITED', 'Terlalu banyak percobaan.', retryAfterSeconds: 30)),
        }),
      );
      await requestCode(tester);
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(find.text('Terlalu banyak percobaan.'), findsOneWidget);
      expect(tester.widget<KapdhButton>(verifyButton).onPressed, isNull);
      app.clock.advance(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 1));
      expect(tester.widget<KapdhButton>(verifyButton).onPressed, isNotNull);
    });
  });

  group('Lupa Password: password baru (AC F02-4, PRD 2.5)', () {
    testWidgets('AC F02-4: sandi baru disimpan dengan reset_token, sukses lalu masuk dengan email terisi', (
      tester,
    ) async {
      final app = await openReset(tester, recoveryRoutes());
      expect(find.text('Buat password baru'), findsOneWidget);
      await enterNewPassword(tester, 'Baru#2026kapdh');
      await saveNewPassword(tester);

      expect(app.adapter.requestsTo('/auth/password/reset').single.data, {
        'reset_token': 'reset-token-rahasia',
        'new_password': 'Baru#2026kapdh',
      });
      expect(find.text('Password berhasil diganti'), findsOneWidget);
      expect(find.textContaining('semua perangkat yang masuk ke akun ini telah dikeluarkan'), findsOneWidget);

      await scrollAndTap(tester, find.byKey(const ValueKey('reset-signin')));
      await settle(tester);
      expect(app.location, '/login');
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.byKey(const ValueKey('login-notice')), findsOneWidget);
      expect(find.text('ahmad.islam@email.com'), findsOneWidget);
      final session = app.container.read(sessionProvider);
      expect(session.resetToken, isNull, reason: 'token sekali pakai dilepas dari memori');
      expect(app.container.read(loginNoticeProvider), isNull, reason: 'pemberitahuan hanya tampil sekali');
    });

    testWidgets('PRD 2.5: aturan dihitung dalam byte UTF-8; lebih dari 72 byte ditolak, tidak dipotong', (
      tester,
    ) async {
      final app = await openReset(tester, recoveryRoutes());
      Color counterColor(String text) => tester.widget<Text>(find.text(text)).style!.color!;
      await scrollTo(tester, fieldOf('reset-password'));
      expect(find.text('0/8'), findsOneWidget);

      // "é" = 2 byte: 4 karakter tetapi 8 byte, belum memenuhi huruf besar/angka/simbol.
      await tester.enterText(fieldOf('reset-password'), 'éééé');
      await tester.pump();
      expect(find.text('8/8'), findsOneWidget);
      expect(find.bySemanticsLabel('8 sampai 72 byte, terpenuhi'), findsOneWidget);
      expect(find.bySemanticsLabel('Huruf besar, belum terpenuhi'), findsOneWidget);

      // 37 karakter "é" + "A1#" = 77 byte (> 72): ditolak.
      final tooLong = '${'é' * 37}A1#';
      await tester.enterText(fieldOf('reset-password'), tooLong);
      await tester.pump();
      expect(find.text('77/72'), findsOneWidget);
      expect(counterColor('77/72'), KapdhColors.danger);
      await enterNewPassword(tester, tooLong);
      await saveNewPassword(tester);
      expect(find.text('Belum memenuhi aturan password'), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/password/reset'), isEmpty);

      final field = tester.widget<TextField>(
        find.descendant(of: find.byKey(const ValueKey('reset-password')), matching: find.byType(TextField)),
      );
      expect(field.controller!.text, tooLong, reason: 'tidak dipotong diam-diam');
    });

    testWidgets('konfirmasi password harus sama', (tester) async {
      final app = await openReset(tester, recoveryRoutes());
      await enterNewPassword(tester, 'Baru#2026kapdh', confirm: 'Baru#2026kapdx');
      await saveNewPassword(tester);
      expect(find.text('Password tidak sama'), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/password/reset'), isEmpty);
    });

    testWidgets('tombol tampil/sembunyikan password pada field password baru', (tester) async {
      await openReset(tester, recoveryRoutes());
      TextField field() => tester.widget<TextField>(
        find.descendant(of: find.byKey(const ValueKey('reset-password')), matching: find.byType(TextField)),
      );
      await scrollTo(tester, fieldOf('reset-password'));
      expect(field().obscureText, isTrue);
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('reset-password')),
          matching: find.byTooltip('Tampilkan password'),
        ),
      );
      await tester.pump();
      expect(field().obscureText, isFalse);
    });

    testWidgets('galat server field_errors.new_password tampil di field', (tester) async {
      await openReset(
        tester,
        recoveryRoutes({
          '/auth/password/reset': (_) => FakeResponse.json(
            400,
            errorJson(
              'VALIDATION_ERROR',
              'Periksa isian.',
              fieldErrors: {
                'new_password': ['Password terlalu umum'],
              },
            ),
          ),
        }),
      );
      await enterNewPassword(tester, 'Baru#2026kapdh');
      await saveNewPassword(tester);
      await scrollTo(tester, find.text('Password terlalu umum'));
      expect(find.text('Password terlalu umum'), findsOneWidget);
    });

    testWidgets('AC F02-4: reset_token tidak berlaku (410): sesi pemulihan berakhir, ulangi lupa password', (
      tester,
    ) async {
      final app = await openReset(
        tester,
        recoveryRoutes({
          '/auth/password/reset': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Token tidak berlaku.')),
        }),
      );
      await enterNewPassword(tester, 'Baru#2026kapdh');
      await saveNewPassword(tester);
      expect(find.text('Sesi pemulihan berakhir'), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('reset-restart')));
      await settle(tester);
      expect(app.location, '/forgot');
      expect(app.container.read(sessionProvider).resetToken, isNull);
    });

    testWidgets('kontrak C1, PRD 4.5: respons hilang lalu 410, arahkan masuk dengan sandi baru dahulu', (tester) async {
      var attempts = 0;
      final app = await openReset(
        tester,
        recoveryRoutes({
          '/auth/password/reset': (_) => ++attempts == 1
              ? FakeResponse.network()
              : FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Token tidak berlaku.')),
        }),
      );
      await enterNewPassword(tester, 'Baru#2026kapdh');
      await saveNewPassword(tester);
      expect(find.textContaining('Koneksi terputus sebelum hasil diterima'), findsOneWidget);

      await saveNewPassword(tester);
      expect(find.text('Password baru mungkin sudah tersimpan'), findsOneWidget);
      expect(find.byKey(const ValueKey('reset-restart')), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('reset-try-login')));
      await settle(tester);
      expect(app.location, '/login');
      expect(find.textContaining('Coba masuk dengan password baru Anda'), findsOneWidget);
    });

    testWidgets('AC F02-4: reset_token berlaku 10 menit menurut jam server; setelah habis formulir dikunci', (
      tester,
    ) async {
      // Jam perangkat maju 7 jam; jam server diketahui dari header Date respons verifikasi.
      final app = await pumpApp(
        tester,
        handler: recoveryRoutes(),
        clock: TestClock(testNow.add(const Duration(hours: 7))),
      );
      app.container.read(serverClockProvider).observe(testNow);
      app.container.read(resetGrantExpiryProvider.notifier).set(testNow.add(const Duration(minutes: 10)));
      app.container.read(sessionProvider.notifier).setResetToken('reset-token-rahasia');
      app.router.go('/forgot/reset');
      await settle(tester);
      expect(find.text('Selesaikan dalam 10:00'), findsOneWidget);

      app.clock.advance(const Duration(minutes: 9, seconds: 30));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Selesaikan dalam 0:30'), findsOneWidget);

      app.clock.advance(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 1));
      expect(find.textContaining('Waktu membuat password baru sudah habis'), findsOneWidget);
      expect(tester.widget<KapdhButton>(find.byKey(const ValueKey('reset-submit'))).onPressed, isNull);
      await scrollAndTap(tester, find.byKey(const ValueKey('reset-expired-restart')));
      await settle(tester);
      expect(app.location, '/forgot');
    });

    testWidgets('tanpa reset_token di memori: /forgot/reset dialihkan ke Lupa Password', (tester) async {
      final app = await pumpApp(tester, handler: recoveryRoutes());
      app.router.go('/forgot/reset');
      await settle(tester);
      expect(app.location, '/forgot');
    });
  });

  testWidgets('jam server dari header Date: kode tetap berlaku pada perangkat yang jamnya maju (PRD 2.1)', (
    tester,
  ) async {
    final skewed = TestClock(testNow.add(const Duration(hours: 7)));
    final app = await pumpApp(
      tester,
      clock: skewed,
      handler: recoveryRoutes({
        '/auth/password/forgot': (_) =>
            FakeResponse.json(202, resetChallengeJson(), {'date': HttpDate.format(testNow)}),
      }),
    );
    app.router.go('/forgot');
    await settle(tester);
    await requestCode(tester);
    expect(find.text('Sisa percobaan: 5 dari 5'), findsOneWidget);
    expect(tester.widget<TextField>(otpInput).enabled, isTrue);
  });

  for (final route in ['/forgot', '/forgot/otp', '/forgot/reset']) {
    testWidgets('N-11: teks 200 % pada $route tanpa meluap', (tester) async {
      final app = await pumpApp(tester, handler: recoveryRoutes(), textScale: 2);
      final session = app.container.read(sessionProvider.notifier);
      if (route == '/forgot/otp') session.setChallenge(OtpChallenge.fromJson(resetChallengeJson()));
      if (route == '/forgot/reset') session.setResetToken('reset-token-rahasia');
      app.router.go(route);
      await settle(tester);
      expect(tester.takeException(), isNull);
      final target = switch (route) {
        '/forgot' => find.byKey(const ValueKey('forgot-submit')),
        '/forgot/otp' => resendButton,
        _ => find.byKey(const ValueKey('reset-submit')),
      };
      await scrollTo(tester, target);
      expect(tester.takeException(), isNull);
    });
  }
}
