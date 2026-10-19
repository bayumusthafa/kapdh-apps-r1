import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/redirect.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/app_gate/app_gate.dart';
import 'package:kapdh_mobile/core/config/server_clock.dart';
import 'package:kapdh_mobile/core/deep_link/deep_links.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/features/auth/auth_flow.dart';
import 'package:kapdh_mobile/features/auth/otp_challenge.dart';

import '../../support/fakes.dart';

const linkId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

String? go(SessionState session, String location, {GateStatus gate = GateStatus.ok}) =>
    resolveRedirect(RedirectState(gate: gate, session: session), Uri.parse(location));

SessionState authed(String status) => SessionState.authenticated(meOf(status: status), syncedAt: testNow);

void main() {
  group('tautan challenge OTP (AC F16-4, kontrak C1 forgotPassword)', () {
    test('AC F16-4: challenge_id dibaca dari ?challenge= atau ?challenge_id=, hanya UUID', () {
      expect(DeepLinks.challengeId(Uri.parse('/forgot/otp?challenge=$linkId')), linkId);
      expect(DeepLinks.challengeId(Uri.parse('/forgot/otp?challenge_id=$linkId')), linkId);
      expect(DeepLinks.challengeId(Uri.parse('/forgot/otp?challenge=${linkId.toUpperCase()}')), linkId);
      expect(DeepLinks.challengeId(Uri.parse('/forgot/otp?challenge=bukan-uuid')), isNull);
      expect(DeepLinks.challengeId(Uri.parse('/forgot/otp?challenge=$linkId%27%3B')), isNull);
      expect(DeepLinks.challengeId(Uri.parse('/forgot/otp')), isNull);
    });

    test('AC F16-4: anonim membuka /forgot/otp?challenge=<uuid> tanpa challenge di memori', () {
      const anon = SessionState.anonymous();
      expect(go(anon, '/forgot/otp?challenge=$linkId'), isNull);
      expect(go(anon, '/forgot/otp?challenge=bukan-uuid'), '/forgot');
      expect(go(anon, '/forgot/otp'), '/forgot');
      expect(go(anon, '/register/otp?challenge=$linkId'), isNull);
    });

    test('AC F16-4: App Link https://kapdh.or.id/app/forgot/otp?challenge= dinormalkan ke rute internal', () {
      expect(go(const SessionState.anonymous(), '/app/forgot/otp?challenge=$linkId'), '/forgot/otp?challenge=$linkId');
    });

    test('AC F16-4: tautan saat aplikasi baru dibuka ditunda di splash lalu langsung ke layar OTP, bukan login', () {
      final pending = go(const SessionState.unknown(), '/forgot/otp?challenge=$linkId', gate: GateStatus.checking);
      expect(pending, startsWith('/splash?from='));
      expect(Uri.parse(pending!).queryParameters['from'], '/forgot/otp?challenge=$linkId');
      // Gerbang selesai, sesi masih dimuat: tetap di splash.
      expect(go(const SessionState.unknown(), pending), isNull);
      // Anonim: langsung ke layar OTP dari tautan.
      expect(go(const SessionState.anonymous(), pending), '/forgot/otp?challenge=$linkId');
    });

    test('AC F16-4: tautan tertunda bertahan melewati maintenance', () {
      final pending = go(const SessionState.anonymous(), '/forgot/otp?challenge=$linkId', gate: GateStatus.maintenance);
      expect(pending, startsWith('/maintenance?from='));
      expect(go(const SessionState.anonymous(), pending!), '/forgot/otp?challenge=$linkId');
    });

    test('AC F16-4: tautan reset saat masih masuk tidak dibuang; layar pemulihan menawarkan keluar', () {
      // Reset pengurus mencabut seluruh sesi: tautan dibuka (layar menjelaskan dan menawarkan keluar).
      expect(go(authed('verified'), '/forgot/otp?challenge=$linkId'), isNull);
      expect(go(authed('suspended'), '/forgot/otp?challenge=$linkId'), isNull);
      final pending = go(authed('verified'), '/forgot/otp?challenge=$linkId', gate: GateStatus.checking);
      expect(go(authed('verified'), pending!), '/forgot/otp?challenge=$linkId');
      // Tanpa challenge sah, atau tautan aktivasi: tetap ke rute awal status.
      expect(go(authed('verified'), '/forgot/otp'), '/home');
      expect(go(authed('verified'), '/forgot/otp?challenge=bukan-uuid'), '/home');
      expect(go(authed('verified'), '/register/otp?challenge=$linkId'), '/home');
      expect(go(authed('verified'), '/forgot/reset'), '/home');
    });

    test('AC F16-4: tautan reset saat maintenance dan masih masuk ditunda lalu dipulihkan', () {
      final pending = go(authed('verified'), '/forgot/otp?challenge=$linkId', gate: GateStatus.maintenance);
      expect(pending, startsWith('/maintenance?from='));
      expect(go(authed('verified'), pending!), '/forgot/otp?challenge=$linkId');
    });

    test('AC F13-3: rute auth tanpa challenge tetap tidak boleh menjadi tujuan tertunda', () {
      final pending = go(const SessionState.unknown(), '/forgot/reset', gate: GateStatus.checking);
      expect(pending, '/splash');
    });
  });

  group('slot aktivasi signup/email_change (kontrak C1, PRD 2.2)', () {
    test('F-01: challenge email_change hasil koreksi email membuka layar OTP pendaftaran', () {
      expect(
        go(SessionState.anonymous(challenge: challengeOf(purpose: OtpPurpose.emailChange)), '/register/otp'),
        isNull,
      );
      expect(go(SessionState.anonymous(challenge: challengeOf()), '/register/otp'), isNull);
      expect(
        go(SessionState.anonymous(challenge: challengeOf(purpose: OtpPurpose.passwordReset)), '/register/otp'),
        '/login',
      );
    });

    test('PRD 2.2: isActivationPurpose hanya signup dan email_change', () {
      expect(isActivationPurpose(OtpPurpose.signup), isTrue);
      expect(isActivationPurpose(OtpPurpose.emailChange), isTrue);
      expect(isActivationPurpose(OtpPurpose.passwordReset), isFalse);
      expect(isActivationPurpose(OtpPurpose.deletion), isFalse);
      expect(isActivationPurpose(null), isFalse);
    });
  });

  group('hasil mutasi tidak diketahui (PRD 4.5, kontrak C1)', () {
    test('AC F01-4: jaringan, 5xx dan 408 tidak diketahui; 4xx lain pasti', () {
      expect(isUnknownOutcome(networkError()), isTrue);
      expect(isUnknownOutcome(apiError(502, 'INTERNAL_ERROR', 'Gateway')), isTrue);
      expect(isUnknownOutcome(apiError(408, 'INTERNAL_ERROR', 'Timeout')), isTrue);
      expect(
        isUnknownOutcome(const ApiException(kind: ApiFailureKind.invalidResponse, operationId: 'verifyOtp')),
        isTrue,
      );
      expect(isUnknownOutcome(apiError(410, 'OTP_EXPIRED', 'Kedaluwarsa')), isFalse);
      expect(isUnknownOutcome(apiError(400, 'VALIDATION_ERROR', 'Kode salah')), isFalse);
      expect(isUnknownOutcome(apiError(429, 'RATE_LIMITED', 'Tunggu', retryAfterSeconds: 30)), isFalse);
    });
  });

  group('kredensial aktivasi hanya di memori selama alur OTP (kontrak C1 verifyOtp)', () {
    test('AC F01-4: dilepas saat alur aktivasi berakhir atau berganti ke pemulihan', () {
      final container = makeContainer();
      addTearDown(container.dispose);
      final session = container.read(sessionProvider.notifier)..setChallenge(challengeOf());
      container
          .read(activationCredentialsProvider.notifier)
          .remember(email: ' ahmad@kapdh.test ', password: 'Rahasia#1');
      expect(container.read(activationCredentialsProvider)?.email, 'ahmad@kapdh.test');
      expect(container.read(activationCredentialsProvider).toString(), isNot(contains('Rahasia')));

      session.setChallenge(challengeOf(id: 'challenge-2', purpose: OtpPurpose.emailChange));
      expect(container.read(activationCredentialsProvider), isNotNull, reason: 'koreksi email tetap alur aktivasi');

      session.setChallenge(challengeOf(id: 'challenge-3', purpose: OtpPurpose.passwordReset));
      expect(container.read(activationCredentialsProvider), isNull);

      session.setChallenge(challengeOf(id: 'challenge-4'));
      container.read(activationCredentialsProvider.notifier).remember(email: 'a@kapdh.test', password: 'x');
      session.clearFlow();
      expect(container.read(activationCredentialsProvider), isNull);
    });

    test('AC F02-4: batas berlaku reset_token dilepas bersama tokennya', () {
      final container = makeContainer();
      addTearDown(container.dispose);
      final session = container.read(sessionProvider.notifier)..setResetToken('reset-1');
      container.read(resetGrantExpiryProvider.notifier).set(testNow.add(const Duration(minutes: 10)));
      expect(container.read(resetGrantExpiryProvider), isNotNull);
      session.clearFlow();
      expect(container.read(resetGrantExpiryProvider), isNull);
    });
  });

  group('OtpChallengeTracker (PRD 2.5, AC F01-3)', () {
    late TestClock clock;
    late ServerClock serverClock;
    late OtpChallengeTracker tracker;

    setUp(() {
      clock = TestClock();
      serverClock = ServerClock(clock: clock.call);
      tracker = OtpChallengeTracker(serverClock);
    });

    test('AC F01-3: max_attempts dari server dipakai untuk "n dari m"; challenge baru mengatur ulang percobaan', () {
      final challenge = OtpChallenge.fromJson({...otpChallengeJson(attemptsLeft: 2), 'max_attempts': 5});
      expect(tracker.sync(challenge), isTrue);
      expect(tracker.attemptsLeft, 2);
      expect(tracker.maxAttempts, 5);
      expect(tracker.sync(challenge), isFalse);
      tracker.wrongCode(apiError(400, 'VALIDATION_ERROR', 'Kode salah. Sisa percobaan 1.'));
      expect(tracker.attemptsLeft, 1);
      tracker.wrongCode(apiError(400, 'VALIDATION_ERROR', 'Kode salah.'));
      expect(tracker.attemptsLeft, 0);
      expect(tracker.codeExpired(challenge), isTrue);
      expect(tracker.sync(challengeOf(id: 'challenge-2')), isTrue);
      expect(tracker.attemptsLeft, 5);
      expect(tracker.expired, isFalse);
    });

    test('PRD 2.5: kirim ulang mengikuti resend_available_at, RATE_LIMITED memperpanjang', () {
      final challenge = challengeOf(resendAvailableAt: testNow.add(const Duration(seconds: 42)));
      tracker.sync(challenge);
      expect(tracker.resendWait(challenge), const Duration(seconds: 42));
      clock.advance(const Duration(seconds: 42));
      expect(tracker.resendWait(challenge), Duration.zero);
      tracker.rateLimited(const Duration(minutes: 2));
      expect(tracker.resendWait(challenge), const Duration(minutes: 2));
      tracker.clearRateLimit();
      expect(tracker.resendWait(challenge), Duration.zero);
    });

    test('PRD 2.5: challenge dari tautan yang sudah kedaluwarsa menurut jam server langsung menawarkan kode baru', () {
      serverClock.observe(testNow.add(const Duration(minutes: 30)));
      final challenge = OtpChallenge.fromJson(
        otpChallengeJson(expiresAt: testNow.add(const Duration(minutes: 10)), resendAvailableAt: testNow),
      );
      tracker.sync(challenge);
      expect(tracker.codeExpired(challenge), isTrue);
      expect(tracker.resendWait(challenge), Duration.zero);
    });

    test('AC F01-3: kode dari tautan dengan percobaan habis (attempts_left 0) dianggap tidak berlaku', () {
      final challenge = challengeOf(attemptsLeft: 0);
      tracker.sync(challenge);
      expect(tracker.codeExpired(challenge), isTrue);
    });
  });

  test('PRD 2.1: provider jam server dipakai bersama layar OTP', () {
    final container = makeContainer();
    addTearDown(container.dispose);
    expect(identical(container.read(serverClockProvider), container.read(serverClockProvider)), isTrue);
  });
}
