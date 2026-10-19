import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/auth/forgot_otp_screen.dart';
import 'package:kapdh_mobile/features/auth/otp_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

const linkId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

Finder get otpInput => find.byKey(const ValueKey('otp-input'));
Finder get verifyButton => find.byKey(const ValueKey('otp-submit'));
Finder get resendButton => find.byKey(const ValueKey('otp-resend'));

/// Challenge `password_reset` yang diterbitkan pengurus (AC F16-4): kode dikirim 3 menit lalu.
Map<String, Object?> adminResetChallenge({
  String purpose = 'password_reset',
  int attemptsLeft = 5,
  DateTime? expiresAt,
  DateTime? resendAvailableAt,
}) => otpChallengeJson(
  id: linkId,
  purpose: purpose,
  emailMasked: 'ah***@contoh.test',
  attemptsLeft: attemptsLeft,
  expiresAt: expiresAt ?? testNow.add(const Duration(minutes: 7)),
  resendAvailableAt: resendAvailableAt ?? testNow.subtract(const Duration(minutes: 2)),
);

/// Aplikasi dibuka dingin oleh tautan email (Android meneruskan path+query sebagai rute awal).
Future<AppHarness> coldStart(WidgetTester tester, String link, FakeHandler handler) async {
  tester.binding.platformDispatcher.defaultRouteNameTestValue = link;
  addTearDown(tester.binding.platformDispatcher.clearDefaultRouteNameTestValue);
  return pumpApp(tester, handler: handler);
}

void main() {
  group('tautan email reset dari pengurus (AC F16-4, kontrak C1 forgotPassword)', () {
    testWidgets('AC F16-4: aplikasi dibuka dari tautan: status dibaca tanpa kirim ulang, kode email dipakai', (
      tester,
    ) async {
      final app = await coldStart(
        tester,
        '/forgot/otp?challenge=$linkId',
        apiRoutes({
          '/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge()),
          '/auth/password/forgot/verify': (_) => FakeResponse.json(200, {
            'reset_token': 'reset-token-rahasia',
            'expires_at': testNow.add(const Duration(minutes: 10)).toIso8601String(),
          }),
        }),
      );

      expect(app.location, '/forgot/otp?challenge=$linkId');
      expect(find.byType(ForgotOtpScreen), findsOneWidget);
      // POST /auth/otp/status hanya-baca dengan challenge_id di body (tidak di URL API).
      final status = app.adapter.requestsTo('/auth/otp/status').single;
      expect(status.method, 'POST');
      expect(status.data, {'challenge_id': linkId});
      expect(status.queryParameters, isEmpty);
      expect(app.adapter.requestsTo('/auth/otp/resend'), isEmpty, reason: 'kode yang baru diterima tidak diganti');
      expect(app.adapter.requestsTo('/auth/password/forgot'), isEmpty);

      // Email tersamar dari server, masa berlaku, sisa percobaan, kirim ulang sudah tersedia.
      expect(find.textContaining('ah***@contoh.test'), findsOneWidget);
      expect(find.text('Sisa percobaan: 5 dari 5'), findsOneWidget);
      expect(find.text('Kirim ulang'), findsOneWidget);

      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/password/forgot/verify').single.data, {
        'challenge_id': linkId,
        'code': '482913',
      });
      expect(app.location, '/forgot/reset');
    });

    testWidgets('AC F16-4: App Link https://kapdh.or.id/app/forgot/otp?challenge_id= (bentuk lama) diterima', (
      tester,
    ) async {
      final app = await coldStart(
        tester,
        '/app/forgot/otp?challenge_id=$linkId',
        apiRoutes({'/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge())}),
      );
      expect(app.location, '/forgot/otp?challenge_id=$linkId');
      expect(app.adapter.requestsTo('/auth/otp/status').single.data, {'challenge_id': linkId});
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);
    });

    testWidgets('AC F16-4: tautan dibuka saat aplikasi sudah di layar login', (tester) async {
      final app = await pumpApp(
        tester,
        handler: apiRoutes({'/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge())}),
      );
      expect(app.location, '/login');
      app.router.go('/forgot/otp?challenge=$linkId');
      await settle(tester);
      expect(app.location, '/forgot/otp?challenge=$linkId');
      expect(app.container.read(sessionProvider).challenge?.challengeId, linkId);
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);
    });

    testWidgets('AC F16-4: tautan sudah dipakai/diganti (410): tidak berlaku, minta kode baru', (tester) async {
      final app = await coldStart(
        tester,
        '/forgot/otp?challenge=$linkId',
        apiRoutes({
          '/auth/otp/status': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Challenge tidak berlaku.')),
        }),
      );
      expect(find.text('Tautan pemulihan tidak berlaku'), findsOneWidget);
      expect(find.byKey(const ValueKey('otp-input')), findsNothing);
      await tester.tap(find.text('Minta kode baru'));
      await settle(tester);
      expect(app.location, '/forgot');
    });

    testWidgets('AC F16-4: challenge bertujuan lain di tautan pemulihan diperlakukan tidak berlaku', (tester) async {
      await coldStart(
        tester,
        '/forgot/otp?challenge=$linkId',
        apiRoutes({'/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge(purpose: 'signup'))}),
      );
      expect(find.text('Tautan pemulihan tidak berlaku'), findsOneWidget);
    });

    testWidgets('AC F16-4: gagal jaringan saat membaca tautan: galat dengan coba lagi, lalu berhasil', (tester) async {
      var calls = 0;
      final app = await coldStart(
        tester,
        '/forgot/otp?challenge=$linkId',
        apiRoutes({
          '/auth/otp/status': (_) =>
              ++calls == 1 ? FakeResponse.network() : FakeResponse.json(200, adminResetChallenge()),
        }),
      );
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/otp/status'), hasLength(2));
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);
    });

    testWidgets('AC F16-4: kode dari tautan sudah kedaluwarsa: kotak nonaktif, kirim ulang ditawarkan', (tester) async {
      final app = await coldStart(
        tester,
        '/forgot/otp?challenge=$linkId',
        apiRoutes({
          '/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge(attemptsLeft: 0)),
          '/auth/otp/resend': (_) => FakeResponse.json(
            200,
            otpChallengeJson(
              id: 'reset-challenge-2',
              purpose: 'password_reset',
              resendAvailableAt: testNow.add(const Duration(seconds: 60)),
            ),
          ),
        }),
      );
      expect(find.text('Kode tidak berlaku lagi. Minta kode baru.'), findsOneWidget);
      expect(tester.widget<KapdhButton>(verifyButton).onPressed, isNull);
      await tester.tap(resendButton);
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/otp/resend').single.data, {'challenge_id': linkId});
      expect(find.text('Sisa percobaan: 5 dari 5'), findsOneWidget);
      // Challenge baru dipakai walau tautan lama masih di URL; status tidak dibaca ulang.
      expect(app.adapter.requestsTo('/auth/otp/status'), hasLength(1));
    });

    testWidgets('AC F16-4: tautan dengan challenge tidak sah tidak dibaca dan tidak dibuka', (tester) async {
      // Saat aplikasi baru dibuka: tidak menjadi tujuan tertunda, mendarat di login.
      final app = await coldStart(tester, '/forgot/otp?challenge=bukan-uuid', apiRoutes({}));
      expect(app.location, '/login');
      // Saat aplikasi sudah berjalan: dialihkan ke Lupa Password.
      app.router.go('/forgot/otp?challenge=bukan-uuid');
      await settle(tester);
      expect(app.location, '/forgot');
      expect(app.adapter.requestsTo('/auth/otp/status'), isEmpty);
    });

    testWidgets('AC F16-4: tautan pengurus saat kode pemulihan lain di memori: status tautan diutamakan', (
      tester,
    ) async {
      final status = <Completer<FakeResponse>>[];
      final app = await pumpApp(
        tester,
        handler: apiRoutes({
          '/auth/otp/status': (_) {
            final next = Completer<FakeResponse>();
            status.add(next);
            return next.future;
          },
          '/auth/password/forgot/verify': (_) => FakeResponse.json(200, {
            'reset_token': 'reset-token-rahasia',
            'expires_at': testNow.add(const Duration(minutes: 10)).toIso8601String(),
          }),
        }),
        // Anggota sudah meminta kode sendiri sebelum pengurus mereset; challenge itu dibatalkan server.
        beforeStart: (container) async => container
            .read(sessionProvider.notifier)
            .setChallenge(OtpChallenge.fromJson(otpChallengeJson(id: 'challenge-old', purpose: 'password_reset'))),
      );
      app.router.go('/forgot/otp?challenge=$linkId');
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }

      // Memuat: challenge lama tidak dapat dipakai.
      expect(status, hasLength(1));
      expect(find.byType(LoadingSkeleton), findsOneWidget);
      expect(otpInput, findsNothing);

      // Gagal: galat dengan coba lagi, bukan challenge lama.
      status.single.complete(FakeResponse.network());
      await settle(tester);
      expect(find.text('Coba lagi'), findsOneWidget);
      expect(find.text('Masukkan kode pemulihan'), findsNothing);
      expect(otpInput, findsNothing);

      await tester.tap(find.text('Coba lagi'));
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      status.last.complete(FakeResponse.json(200, adminResetChallenge()));
      await settle(tester);
      expect(app.container.read(sessionProvider).challenge?.challengeId, linkId);
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);

      await tester.enterText(otpInput, '482913');
      await settle(tester);
      expect(
        app.adapter.requestsTo('/auth/password/forgot/verify').single.data,
        containsPair('challenge_id', linkId),
        reason: 'kode dari email pengurus dikirim untuk challenge tautan',
      );
    });

    testWidgets('AC F16-4: tautan tidak berlaku (410) walau kode pemulihan lain masih di memori', (tester) async {
      final app = await pumpApp(
        tester,
        handler: apiRoutes({
          '/auth/otp/status': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Challenge tidak berlaku.')),
        }),
        beforeStart: (container) async => container
            .read(sessionProvider.notifier)
            .setChallenge(OtpChallenge.fromJson(otpChallengeJson(id: 'challenge-old', purpose: 'password_reset'))),
      );
      app.router.go('/forgot/otp?challenge=$linkId');
      await settle(tester);
      expect(find.text('Tautan pemulihan tidak berlaku'), findsOneWidget);
      expect(otpInput, findsNothing);
      await tester.tap(find.text('Minta kode baru'));
      await settle(tester);
      expect(app.location, '/forgot');
      expect(app.container.read(sessionProvider).challenge, isNull);
    });
  });

  group('tautan pemulihan saat anggota masih masuk (AC F16-4: reset pengurus mencabut seluruh sesi)', () {
    FakeHandler signedInRoutes() => apiRoutes({
      '/me': (_) => FakeResponse.json(200, meJson()),
      '/auth/logout': (_) => FakeResponse.json(204),
      '/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge()),
    });

    testWidgets('AC F16-4: tautan tidak dibuang; keluar dari perangkat ini lalu tautan yang sama dilanjutkan', (
      tester,
    ) async {
      final app = await pumpApp(tester, tokens: savedTokens(), handler: signedInRoutes());
      expect(app.location, '/home');
      app.router.go('/forgot/otp?challenge=$linkId');
      await settle(tester);

      expect(app.location, '/forgot/otp?challenge=$linkId');
      expect(find.text('Tautan pemulihan password'), findsOneWidget);
      expect(find.byKey(const ValueKey('forgot-link-signout')), findsOneWidget);
      expect(app.adapter.requestsTo('/auth/otp/status'), isEmpty, reason: 'challenge tidak dibaca selama ada sesi');
      expect(otpInput, findsNothing);

      await scrollAndTap(tester, find.byKey(const ValueKey('forgot-link-signout')));
      await settle(tester);

      expect(app.adapter.requestsTo('/auth/logout'), hasLength(1));
      expect(app.container.read(sessionProvider).hasSession, isFalse);
      expect(app.location, '/forgot/otp?challenge=$linkId');
      expect(app.adapter.requestsTo('/auth/otp/status').single.data, {'challenge_id': linkId});
      expect(app.container.read(sessionProvider).challenge?.challengeId, linkId);
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);
    });

    testWidgets('AC F16-4: sesi dicabut server saat pemberitahuan tampil: tautan langsung dilanjutkan', (tester) async {
      var revoked = false;
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: (options) {
          if (revoked && (options.path == '/me' || options.path == '/auth/refresh')) {
            return FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir. Silakan masuk kembali.'));
          }
          return signedInRoutes()(options);
        },
      );
      app.router.go('/forgot/otp?challenge=$linkId');
      await settle(tester);
      expect(find.text('Tautan pemulihan password'), findsOneWidget);

      // Reset pengurus mencabut sesi: /me 401 lalu refresh ditolak, sesi menjadi anonim tanpa tindakan pengguna.
      revoked = true;
      unawaited(app.container.read(sessionProvider.notifier).refreshQuietly());
      await settle(tester);
      expect(app.adapter.requestsTo('/auth/refresh'), isNotEmpty);
      expect(app.container.read(sessionProvider).hasSession, isFalse);
      expect(app.adapter.requestsTo('/auth/logout'), isEmpty);
      expect(app.location, '/forgot/otp?challenge=$linkId');
      expect(find.text('Masukkan kode pemulihan'), findsOneWidget);
    });

    testWidgets('AC F16-4: kembali ke beranda tanpa keluar', (tester) async {
      final app = await pumpApp(tester, tokens: savedTokens(), handler: signedInRoutes());
      app.router.go('/forgot/otp?challenge=$linkId');
      await settle(tester);
      await scrollAndTap(tester, find.byKey(const ValueKey('forgot-link-home')));
      await settle(tester);
      expect(app.location, '/home');
      expect(app.container.read(sessionProvider).hasSession, isTrue);
      expect(app.adapter.requestsTo('/auth/logout'), isEmpty);
      expect(app.adapter.requestsTo('/auth/otp/status'), isEmpty);
    });

    testWidgets('AC F16-4: aplikasi dibuka dari tautan saat sesi tersimpan: pemberitahuan, bukan beranda', (
      tester,
    ) async {
      tester.binding.platformDispatcher.defaultRouteNameTestValue = '/forgot/otp?challenge=$linkId';
      addTearDown(tester.binding.platformDispatcher.clearDefaultRouteNameTestValue);
      final app = await pumpApp(tester, tokens: savedTokens(), handler: signedInRoutes());
      expect(app.location, '/forgot/otp?challenge=$linkId');
      expect(find.byKey(const ValueKey('forgot-link-signout')), findsOneWidget);
    });

    testWidgets('AC F16-4: tautan aktivasi /register/otp?challenge= saat masuk tetap ke beranda', (tester) async {
      final app = await pumpApp(tester, tokens: savedTokens(), handler: signedInRoutes());
      app.router.go('/register/otp?challenge=$linkId');
      await settle(tester);
      expect(app.location, '/home');
      expect(app.adapter.requestsTo('/auth/otp/status'), isEmpty);
    });
  });

  testWidgets('AC F01-2, kontrak C1: layar OTP pendaftaran dari ?challenge= membaca status challenge aktivasi', (
    tester,
  ) async {
    final app = await coldStart(
      tester,
      '/register/otp?challenge=$linkId',
      apiRoutes({
        '/auth/otp/status': (_) => FakeResponse.json(200, adminResetChallenge(purpose: 'signup')),
        '/auth/otp/verify': (_) => FakeResponse.json(200, {'session': tokenPairJson()}),
        '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
      }),
    );
    expect(find.byType(OtpScreen), findsOneWidget);
    expect(app.container.read(sessionProvider).challenge?.purpose, OtpPurpose.signup);
    await tester.enterText(otpInput, '482913');
    await settle(tester);
    expect(app.location, '/onboarding/fees');
  });

  testWidgets('AC F01-3, kontrak C1: challenge aktivasi dari tautan yang tidak berlaku menawarkan masuk', (
    tester,
  ) async {
    final app = await coldStart(
      tester,
      '/register/otp?challenge=$linkId',
      apiRoutes({'/auth/otp/status': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Tidak berlaku.'))}),
    );
    expect(find.text('Kode verifikasi tidak berlaku'), findsOneWidget);
    await tester.tap(find.text('Ke halaman masuk'));
    await settle(tester);
    expect(app.location, '/login');
  });
}
