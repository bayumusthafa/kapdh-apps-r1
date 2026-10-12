import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/auth/otp_screen.dart';
import 'package:kapdh_mobile/features/auth/registration_draft.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

Finder get otpInput => find.byKey(const ValueKey('otp-input'));
Finder get verifyButton => find.byKey(const ValueKey('otp-submit'));
Finder get resendButton => find.byKey(const ValueKey('otp-resend'));

/// Membuka layar OTP dengan challenge signup yang sedang berjalan.
Future<AppHarness> openOtp(
  WidgetTester tester,
  FakeHandler handler, {
  double textScale = 1,
  bool withDraft = true,
  TestClock? clock,
  DateTime? serverTime,
}) async {
  final app = await pumpApp(
    tester,
    handler: handler,
    textScale: textScale,
    clock: clock,
    beforeStart: (container) async {
      // Jam server dari header Date respons yang membawa challenge.
      if (serverTime != null) container.read(serverClockProvider).observe(serverTime);
      container.read(sessionProvider.notifier).setChallenge(challengeOf());
      if (withDraft) {
        container.read(registrationDraftProvider.notifier)
          ..save(const RegistrationDraft(fullName: 'Ahmad Islam', email: 'ahmad.islam@email.com'))
          ..markSubmitted();
      }
    },
  );
  app.router.go('/register/otp');
  await settle(tester);
  return app;
}

void main() {
  test('sisa percobaan dibaca dari field_errors.code server', () {
    expect(
      attemptsLeftFrom(
        apiError(
          400,
          'VALIDATION_ERROR',
          'x',
          fieldErrors: {
            'code': ['Kode salah. Sisa percobaan 3.'],
          },
        ),
      ),
      3,
    );
    expect(attemptsLeftFrom(apiError(400, 'VALIDATION_ERROR', 'Kode salah. Sisa percobaan: 0')), 0);
    expect(attemptsLeftFrom(apiError(400, 'VALIDATION_ERROR', 'Kode salah.')), isNull);
  });

  testWidgets('prototipe layar 1: email, 6 kotak, sisa percobaan, kirim ulang mengikuti cooldown', (tester) async {
    await openOtp(tester, apiRoutes({}));

    expect(find.byType(OtpScreen), findsOneWidget);
    expect(find.text('Masukkan kode verifikasi'), findsOneWidget);
    expect(find.textContaining('ahmad.islam@email.com'), findsOneWidget);
    expect(find.byType(OtpBoxes), findsOneWidget);
    expect(find.text('Sisa percobaan: 5 dari 5'), findsOneWidget);
    expect(find.text('Kirim ulang dalam 0:42'), findsOneWidget);
    expect(tester.widget<TextButton>(resendButton).onPressed, isNull);
    expect(find.text('Salah email? Ubah alamat email'), findsOneWidget);
    expect(find.bySemanticsLabel('Langkah 2 dari 4: OTP'), findsOneWidget);
    expect(tester.widget<KapdhButton>(verifyButton).onPressed, isNull);
  });

  testWidgets('kode salah: pesan dan sisa percobaan dari server, kotak dikosongkan (AC F01-3)', (tester) async {
    final app = await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/verify': (_) => FakeResponse.json(
          400,
          errorJson(
            'VALIDATION_ERROR',
            'Kode salah. Sisa percobaan 3.',
            fieldErrors: {
              'code': ['Kode salah. Sisa percobaan 3.'],
            },
          ),
        ),
      }),
    );
    await tester.enterText(otpInput, '111111');
    await settle(tester);

    expect(app.adapter.requestsTo('/auth/otp/verify'), hasLength(1));
    expect(find.text('Kode salah. Sisa percobaan 3.'), findsOneWidget);
    expect(find.text('Sisa percobaan: 3 dari 5'), findsOneWidget);
    expect(tester.widget<TextField>(otpInput).controller!.text, isEmpty);
  });

  testWidgets('OTP_EXPIRED: verifikasi nonaktif dan diminta kode baru', (tester) async {
    await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/verify': (_) =>
            FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Kode tidak berlaku lagi. Minta kode baru.')),
      }),
    );
    await tester.enterText(otpInput, '123456');
    await settle(tester);
    expect(find.text('Kode tidak berlaku lagi. Minta kode baru.'), findsNWidgets(2));
    expect(tester.widget<KapdhButton>(verifyButton).onPressed, isNull);
  });

  testWidgets('kode benar: sesi terbit dan router melanjutkan ke Biaya KTA (AC F01-2)', (tester) async {
    final app = await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/verify': (_) => FakeResponse.json(200, {'session': tokenPairJson()}),
        '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
      }),
    );
    await tester.enterText(otpInput, '482913');
    await settle(tester);

    final request = app.adapter.requestsTo('/auth/otp/verify').single.data as Map<String, Object?>;
    expect(request, {'challenge_id': 'challenge-1', 'code': '482913', 'device_name': 'Aplikasi KAPDH Android'});
    expect(app.location, '/onboarding/fees');
    expect(app.container.read(sessionProvider).effectiveStatus, EffectiveStatus.unverified);
    expect(app.container.read(registrationDraftProvider), isNull);
  });

  testWidgets('kirim ulang setelah cooldown: challenge baru, percobaan kembali penuh', (tester) async {
    final app = await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/resend': (_) => FakeResponse.json(
          200,
          otpChallengeJson(id: 'challenge-2', resendAvailableAt: testNow.add(const Duration(seconds: 103))),
        ),
      }),
    );
    app.clock.advance(const Duration(seconds: 43));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Kirim ulang'), findsOneWidget);

    await tester.tap(resendButton);
    await settle(tester);

    expect(app.adapter.requestsTo('/auth/otp/resend'), hasLength(1));
    expect(app.container.read(sessionProvider).challenge?.challengeId, 'challenge-2');
    expect(find.textContaining('Kode baru dikirim'), findsOneWidget);
    expect(find.text('Kirim ulang dalam 1:00'), findsOneWidget);
  });

  testWidgets('kirim ulang ditolak RATE_LIMITED memperpanjang cooldown sesuai retry_after_seconds', (tester) async {
    final app = await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/resend': (_) =>
            FakeResponse.json(429, errorJson('RATE_LIMITED', 'Tunggu sebentar.', retryAfterSeconds: 120)),
      }),
    );
    app.clock.advance(const Duration(seconds: 43));
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(resendButton);
    await settle(tester);
    expect(find.text('Kirim ulang dalam 2:00'), findsOneWidget);
    expect(find.text('Tunggu sebentar.'), findsOneWidget);
  });

  testWidgets('challenge tidak dapat diperbarui: tawaran mulai ulang pendaftaran', (tester) async {
    final app = await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/resend': (_) =>
            FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Mulai ulang pendaftaran atau masuk kembali.')),
      }),
    );
    app.clock.advance(const Duration(seconds: 43));
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(resendButton);
    await settle(tester);

    await scrollAndTap(tester, find.text('Mulai ulang pendaftaran'));
    await settle(tester);
    expect(app.location, '/register');
    expect(find.text('Ahmad Islam'), findsOneWidget, reason: 'isian non-rahasia dipulihkan dari draf');
  });

  testWidgets('tempel kode dari email lalu verifikasi otomatis', (tester) async {
    final app = await openOtp(
      tester,
      apiRoutes({
        '/auth/otp/verify': (_) => FakeResponse.json(200, {'session': tokenPairJson()}),
        '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
      }),
    );
    await tester.enterText(otpInput, 'Kode KAPDH Anda: 482 913');
    await settle(tester);
    expect((app.adapter.requestsTo('/auth/otp/verify').single.data as Map)['code'], '482913');
  });

  group('jam perangkat melenceng dari server (PRD 2.1; AC F01-2)', () {
    final verifyOk = apiRoutes({
      '/auth/otp/verify': (_) => FakeResponse.json(200, {'session': tokenPairJson()}),
      '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
    });

    testWidgets('jam perangkat maju 7 jam (zona waktu UTC), jam server diketahui: kode tetap dapat dikirim', (
      tester,
    ) async {
      final app = await openOtp(
        tester,
        verifyOk,
        clock: TestClock(testNow.add(const Duration(hours: 7))),
        serverTime: testNow,
      );
      expect(find.text('Sisa percobaan: 5 dari 5'), findsOneWidget);
      expect(find.text('Kirim ulang dalam 0:42'), findsOneWidget);
      expect(tester.widget<TextField>(otpInput).enabled, isTrue);

      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/otp/verify'), hasLength(1));
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('jam server belum diketahui dan jam perangkat maju: server yang memutuskan kedaluwarsa', (
      tester,
    ) async {
      final app = await openOtp(tester, verifyOk, clock: TestClock(testNow.add(const Duration(hours: 7))));
      expect(tester.widget<TextField>(otpInput).enabled, isTrue);
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/otp/verify'), hasLength(1));
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('jam perangkat mundur 1 jam: kirim ulang terkunci paling lama 60 detik (PRD 2.5)', (tester) async {
      final clock = TestClock(testNow.subtract(const Duration(hours: 1)));
      await openOtp(tester, apiRoutes({}), clock: clock);
      expect(find.text('Kirim ulang dalam 1:00'), findsOneWidget);
      clock.advance(const Duration(seconds: 30));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Kirim ulang dalam 0:30'), findsOneWidget);
      clock.advance(const Duration(seconds: 30));
      await tester.pump(const Duration(seconds: 1));
      expect(tester.widget<TextButton>(resendButton).onPressed, isNotNull);
    });

    testWidgets('10 menit sejak challenge terlihat: kode pasti kedaluwarsa walau jam server belum diketahui', (
      tester,
    ) async {
      final clock = TestClock(testNow.subtract(const Duration(hours: 1)));
      await openOtp(tester, apiRoutes({}), clock: clock);
      clock.advance(const Duration(minutes: 10));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Kode tidak berlaku lagi. Minta kode baru.'), findsOneWidget);
      expect(tester.widget<TextField>(otpInput).enabled, isFalse);
    });
  });

  testWidgets('tanpa challenge: arahan masuk kembali', (tester) async {
    final app = await pumpApp(tester, handler: apiRoutes({}));
    app.router.go('/register/otp');
    await settle(tester);
    expect(app.location, '/login');
  });

  testWidgets('teks 200 %: tidak meluap, tombol Verifikasi tetap terlihat (N-11)', (tester) async {
    await openOtp(tester, apiRoutes({}), textScale: 2);
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
    expect(verifyButton, findsOneWidget);
    expect(tester.getSize(verifyButton).height, greaterThanOrEqualTo(52));
    await scrollTo(tester, resendButton);
    expect(tester.takeException(), isNull);
  });
}
