import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/auth/auth_flow.dart';
import 'package:kapdh_mobile/features/auth/email_correction_sheet.dart';
import 'package:kapdh_mobile/features/auth/otp_screen.dart';
import 'package:kapdh_mobile/features/auth/registration_draft.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

Finder get otpInput => find.byKey(const ValueKey('otp-input'));
Finder get verifyButton => find.byKey(const ValueKey('otp-submit'));
Finder get resendButton => find.byKey(const ValueKey('otp-resend'));

/// Membuka layar OTP dengan challenge signup yang sedang berjalan. [withCredentials]: email dan sandi dari langkah
/// Data Diri masih di memori (kontrak C1 verifyOtp).
Future<AppHarness> openOtp(
  WidgetTester tester,
  FakeHandler handler, {
  double textScale = 1,
  bool withDraft = true,
  bool withCredentials = false,
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
      if (withCredentials) {
        container
            .read(activationCredentialsProvider.notifier)
            .remember(email: 'ahmad.islam@email.com', password: 'Rahasia#123');
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

  group('Salah email? Ubah alamat email (PRD 2.2, kontrak C1 correctPendingEmail)', () {
    Finder sheetField(String key) =>
        find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextFormField));

    Future<void> openSheet(WidgetTester tester) async {
      await scrollAndTap(tester, find.byKey(const ValueKey('otp-change-email')));
      await settle(tester);
      expect(find.byType(EmailCorrectionSheet), findsOneWidget);
    }

    Future<void> submitCorrection(WidgetTester tester, {String email = 'ahmad.benar@email.com'}) async {
      await tester.enterText(sheetField('correction-email'), email);
      await tester.enterText(sheetField('correction-password'), 'Rahasia#123');
      await scrollAndTap(tester, find.byKey(const ValueKey('correction-submit')));
      await settle(tester);
    }

    testWidgets('F-01: email dikoreksi lewat challenge + sandi; kode email_change dikirim ke email baru', (
      tester,
    ) async {
      final app = await openOtp(
        tester,
        apiRoutes({
          '/auth/email-correction': (_) => FakeResponse.json(
            200,
            otpChallengeJson(id: 'challenge-2', purpose: 'email_change', emailMasked: 'ah***@email.com'),
          ),
        }),
        withCredentials: true,
      );
      await openSheet(tester);
      expect(find.text('Ubah alamat email'), findsOneWidget);
      await submitCorrection(tester);

      expect(app.adapter.requestsTo('/auth/email-correction').single.data, {
        'challenge_id': 'challenge-1',
        'password': 'Rahasia#123',
        'new_email': 'ahmad.benar@email.com',
      });
      expect(find.byType(EmailCorrectionSheet), findsNothing);
      expect(app.location, '/register/otp', reason: 'challenge email_change tetap di layar OTP aktivasi');
      final challenge = app.container.read(sessionProvider).challenge!;
      expect(challenge.challengeId, 'challenge-2');
      expect(challenge.purpose, OtpPurpose.emailChange);
      expect(find.textContaining('Kode 6 digit sudah dikirim ke email baru ahmad.benar@email.com'), findsOneWidget);
      expect(find.text('Email diubah. Kode baru dikirim ke ah***@email.com.'), findsOneWidget);
      expect(find.text('Sisa percobaan: 5 dari 5'), findsOneWidget);
      expect(app.container.read(registrationDraftProvider)?.email, 'ahmad.benar@email.com');
      expect(app.container.read(activationCredentialsProvider)?.email, 'ahmad.benar@email.com');
    });

    testWidgets('F-01: kode dari email baru mengaktifkan akun (AC F01-2)', (tester) async {
      final app = await openOtp(
        tester,
        apiRoutes({
          '/auth/email-correction': (_) =>
              FakeResponse.json(200, otpChallengeJson(id: 'challenge-2', purpose: 'email_change')),
          '/auth/otp/verify': (_) => FakeResponse.json(200, {'session': tokenPairJson()}),
          '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
        }),
      );
      await openSheet(tester);
      await submitCorrection(tester);
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/otp/verify').single.data, containsPair('challenge_id', 'challenge-2'));
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('sandi salah dan email baru terdaftar tampil di field lembar', (tester) async {
      var calls = 0;
      await openOtp(
        tester,
        apiRoutes({
          '/auth/email-correction': (_) => ++calls == 1
              ? FakeResponse.json(
                  400,
                  errorJson(
                    'VALIDATION_ERROR',
                    'Periksa isian.',
                    fieldErrors: {
                      'password': ['Password salah'],
                    },
                  ),
                )
              : FakeResponse.json(
                  409,
                  errorJson(
                    'VALIDATION_ERROR',
                    'Email sudah terdaftar.',
                    fieldErrors: {
                      'new_email': ['Email sudah terdaftar'],
                    },
                  ),
                ),
        }),
      );
      await openSheet(tester);
      await submitCorrection(tester);
      expect(find.text('Password salah'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(
              find.descendant(of: find.byKey(const ValueKey('correction-password')), matching: find.byType(TextField)),
            )
            .controller!
            .text,
        isEmpty,
      );
      await submitCorrection(tester);
      expect(find.text('Email sudah terdaftar'), findsOneWidget);
      expect(find.byType(EmailCorrectionSheet), findsOneWidget);
    });

    testWidgets('email baru sama dengan email sebelumnya ditolak lokal', (tester) async {
      final app = await openOtp(tester, apiRoutes({}));
      await openSheet(tester);
      await submitCorrection(tester, email: 'Ahmad.Islam@email.com');
      expect(find.text('Email baru sama dengan email sebelumnya'), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/email-correction'), isEmpty);
    });

    testWidgets('batas kirim (429) mengunci tombol lembar dengan hitung mundur', (tester) async {
      await openOtp(
        tester,
        apiRoutes({
          '/auth/email-correction': (_) =>
              FakeResponse.json(429, errorJson('RATE_LIMITED', 'Terlalu banyak percobaan.', retryAfterSeconds: 120)),
        }),
      );
      await openSheet(tester);
      await submitCorrection(tester);
      expect(find.text('Terlalu banyak percobaan.'), findsOneWidget);
      expect(find.text('Coba lagi dalam 2:00'), findsOneWidget);
    });

    testWidgets('challenge tidak berlaku lagi (410): lembar ditutup, tawaran mulai ulang pendaftaran', (tester) async {
      final app = await openOtp(
        tester,
        apiRoutes({
          '/auth/email-correction': (_) =>
              FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Kode tidak berlaku lagi. Mulai ulang.')),
        }),
      );
      await openSheet(tester);
      await submitCorrection(tester);
      expect(find.byType(EmailCorrectionSheet), findsNothing);
      await scrollAndTap(tester, find.text('Mulai ulang pendaftaran'));
      await settle(tester);
      expect(app.location, '/register');
    });

    testWidgets('batal menutup lembar tanpa request', (tester) async {
      final app = await openOtp(tester, apiRoutes({}));
      await openSheet(tester);
      await tester.tap(find.byKey(const ValueKey('correction-cancel')));
      await settle(tester);
      expect(find.byType(EmailCorrectionSheet), findsNothing);
      expect(app.adapter.requestsTo('/auth/email-correction'), isEmpty);
    });

    testWidgets('N-11: lembar koreksi pada teks 200 % tanpa meluap', (tester) async {
      await openOtp(tester, apiRoutes({}), textScale: 2);
      await openSheet(tester);
      expect(tester.takeException(), isNull);
      await scrollTo(tester, find.byKey(const ValueKey('correction-submit')));
      expect(tester.takeException(), isNull);
    });
  });

  group('hasil verifikasi tidak diketahui (kontrak C1 verifyOtp, AC F01-4)', () {
    FakeHandler lostThenGone({required Map<String, Object?> loginBody}) {
      var verifies = 0;
      return apiRoutes({
        '/auth/otp/verify': (_) => ++verifies == 1
            ? FakeResponse.network()
            : FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Kode tidak berlaku lagi.')),
        '/auth/login': (_) => FakeResponse.json(200, loginBody),
        '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
      });
    }

    testWidgets('AC F01-4: respons hilang lalu 410: login dengan kredensial di memori, akun sudah aktif', (
      tester,
    ) async {
      final app = await openOtp(
        tester,
        lostThenGone(loginBody: {'next': 'home', 'session': tokenPairJson()}),
        withCredentials: true,
      );
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(find.textContaining('Koneksi terputus sebelum hasil verifikasi diterima'), findsOneWidget);
      expect(tester.widget<TextField>(otpInput).controller!.text, '482913');

      await scrollAndTap(tester, verifyButton);
      await settle(tester);

      expect(app.adapter.requestsTo('/auth/otp/resend'), isEmpty, reason: 'tidak langsung meminta kode baru');
      expect(app.adapter.requestsTo('/auth/login').single.data, {
        'email': 'ahmad.islam@email.com',
        'password': 'Rahasia#123',
        'device_name': 'Aplikasi KAPDH Android',
      });
      expect(app.location, '/onboarding/fees');
      expect(app.container.read(sessionProvider).effectiveStatus, EffectiveStatus.unverified);
      expect(app.container.read(activationCredentialsProvider), isNull, reason: 'sandi dilepas dari memori');
    });

    testWidgets('AC F01-4: login pemulihan menjawab verify_otp: challenge aktivasi terkini dipakai', (tester) async {
      final app = await openOtp(
        tester,
        lostThenGone(
          loginBody: {
            'next': 'verify_otp',
            'challenge': otpChallengeJson(id: 'challenge-9', purpose: 'email_change', attemptsLeft: 4),
          },
        ),
        withCredentials: true,
      );
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      await scrollAndTap(tester, verifyButton);
      await settle(tester);
      expect(app.location, '/register/otp');
      expect(app.container.read(sessionProvider).challenge?.challengeId, 'challenge-9');
      expect(find.text('Akun belum aktif. Masukkan kode terbaru yang dikirim ke email Anda.'), findsOneWidget);
      expect(find.text('Sisa percobaan: 4 dari 5'), findsOneWidget);
      expect(tester.widget<TextField>(otpInput).controller!.text, isEmpty);
    });

    testWidgets('AC F01-4: tanpa kredensial di memori: diminta masuk untuk memeriksa status', (tester) async {
      final app = await openOtp(tester, lostThenGone(loginBody: {'next': 'home', 'session': tokenPairJson()}));
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      await scrollAndTap(tester, verifyButton);
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/login'), isEmpty);
      expect(find.textContaining('Verifikasi sebelumnya mungkin sudah berhasil'), findsOneWidget);
      await scrollAndTap(tester, find.text('Masuk untuk memeriksa status'));
      await settle(tester);
      expect(app.location, '/login');
      expect(find.text('ahmad.islam@email.com'), findsNothing, reason: 'tanpa kredensial, email tidak diketahui');
    });

    testWidgets('AC F01-4: kirim ulang 410 setelah hasil tidak diketahui juga memeriksa lewat login', (tester) async {
      final app = await openOtp(
        tester,
        apiRoutes({
          '/auth/otp/verify': (_) => FakeResponse.network(),
          '/auth/otp/resend': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Tidak berlaku.')),
          '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
          '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
        }),
        withCredentials: true,
      );
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      app.clock.advance(const Duration(seconds: 43));
      await tester.pump(const Duration(seconds: 1));
      await scrollAndTap(tester, resendButton);
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/login'), hasLength(1));
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('jawaban pasti (kode salah) setelah putus koneksi: tidak memicu login', (tester) async {
      var verifies = 0;
      final app = await openOtp(
        tester,
        apiRoutes({
          '/auth/otp/verify': (_) => ++verifies == 1
              ? FakeResponse.network()
              : FakeResponse.json(
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
        withCredentials: true,
      );
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      await scrollAndTap(tester, verifyButton);
      await settle(tester);
      expect(find.text('Sisa percobaan: 4 dari 5'), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/login'), isEmpty);
    });

    testWidgets('server 502 dianggap hasil tidak diketahui', (tester) async {
      var verifies = 0;
      final app = await openOtp(
        tester,
        apiRoutes({
          '/auth/otp/verify': (_) => ++verifies == 1
              ? FakeResponse.json(502, errorJson('INTERNAL_ERROR', 'Gateway bermasalah.'))
              : FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Tidak berlaku.')),
          '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
          '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
        }),
        withCredentials: true,
      );
      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(find.textContaining('Hasil verifikasi belum diketahui'), findsOneWidget);
      await scrollAndTap(tester, verifyButton);
      await settle(tester);
      expect(app.location, '/onboarding/fees');
    });
  });
}
