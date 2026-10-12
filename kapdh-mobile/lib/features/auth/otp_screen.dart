import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../core/session/repositories.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'registration_draft.dart';

/// Batas percobaan OTP (PRD 2.5).
const int otpMaxAttempts = 5;

/// Sisa percobaan dari pesan galat server, mis. field_errors.code "Kode salah. Sisa percobaan 3." (AC F01-3).
int? attemptsLeftFrom(ApiException error) {
  final pattern = RegExp(r'[Ss]isa percobaan\s*:?\s*(\d+)');
  final candidates = [...?error.fieldErrors['code'], error.message];
  for (final text in candidates) {
    final match = pattern.firstMatch(text);
    if (match != null) return int.parse(match.group(1)!);
  }
  return null;
}

/// Langkah 2 pendaftaran: verifikasi OTP email (prototipe layar 1; AC F01-2, F01-3). Enam kotak (ketik, tempel,
/// isi otomatis), sisa percobaan dari jawaban server, kirim ulang mengikuti cooldown dan RATE_LIMITED, serta
/// tawaran challenge baru saat kode kedaluwarsa/habis percobaan. Setelah berhasil, sesi terbit dan router
/// melanjutkan ke Biaya KTA (rute status unverified).
class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key});

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  final _code = TextEditingController();
  Timer? _ticker;
  String? _challengeId;
  int _attemptsLeft = otpMaxAttempts;
  bool _expired = false;
  bool _verifying = false;
  bool _resending = false;
  String? _error;
  DateTime? _rateLimitedUntil;

  /// Challenge tidak dapat diperbarui lagi (resend menjawab OTP_EXPIRED): mulai ulang daftar atau masuk kembali.
  bool _challengeDead = false;

  @override
  void initState() {
    super.initState();
    _syncChallenge(ref.read(sessionProvider).challenge);
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _code.dispose();
    super.dispose();
  }

  DateTime _now() => ref.read(clockProvider)();

  void _syncChallenge(OtpChallenge? challenge) {
    if (challenge == null || challenge.challengeId == _challengeId) return;
    _challengeId = challenge.challengeId;
    _attemptsLeft = challenge.attemptsLeft;
    _expired = challenge.attemptsLeft <= 0;
    _challengeDead = false;
    _error = null;
    _code.clear();
  }

  Duration _resendWait(OtpChallenge challenge) {
    final now = _now();
    var until = challenge.resendAvailableAt;
    final limited = _rateLimitedUntil;
    if (limited != null && limited.isAfter(until)) until = limited;
    final left = until.difference(now);
    return left.isNegative ? Duration.zero : left;
  }

  bool _codeExpired(OtpChallenge challenge) => _expired || !_now().isBefore(challenge.expiresAt);

  Future<void> _verify() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _verifying || _code.text.length != 6 || _codeExpired(challenge)) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _verifying = true;
      _error = null;
    });
    try {
      final response = await ref
          .read(authRepositoryProvider)
          .verifyOtp(challengeId: challenge.challengeId, code: _code.text);
      final session = response.session;
      if (session == null) {
        throw const ApiException(kind: ApiFailureKind.invalidResponse, operationId: 'verifyOtp');
      }
      ref.read(registrationDraftProvider.notifier).clear();
      await ref.read(sessionProvider.notifier).establishSession(session);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _applyError(error, verifying: true));
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  void _applyError(ApiException error, {required bool verifying}) {
    final code = error.code;
    _error = error.fieldErrors['code']?.join(' ') ?? error.message;
    if (code == ErrorCode.otpExpired) {
      _expired = true;
      if (!verifying) _challengeDead = true;
    } else if (code == ErrorCode.rateLimited) {
      final wait = error.retryAfter;
      if (wait != null) _rateLimitedUntil = _now().add(wait);
    } else if (verifying && code == ErrorCode.validationError) {
      final left = attemptsLeftFrom(error) ?? math.max(0, _attemptsLeft - 1);
      _attemptsLeft = left;
      if (left <= 0) _expired = true;
      _code.clear();
    }
  }

  Future<void> _resend() async {
    final challenge = ref.read(sessionProvider).challenge;
    if (challenge == null || _resending || _resendWait(challenge) > Duration.zero) return;
    setState(() {
      _resending = true;
      _error = null;
    });
    try {
      final next = await ref.read(authRepositoryProvider).resendOtp(challenge.challengeId);
      ref.read(sessionProvider.notifier).setChallenge(next);
      if (!mounted) return;
      setState(() {
        _challengeId = null;
        _rateLimitedUntil = null;
        _syncChallenge(next);
      });
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text('Kode baru dikirim ke ${next.emailMasked ?? 'email Anda'}.')));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _applyError(error, verifying: false));
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  void _back() {
    final draft = ref.read(registrationDraftProvider);
    if (draft != null) {
      context.go(AppRoutes.register);
    } else {
      ref.read(sessionProvider.notifier).clearFlow();
      context.go(AppRoutes.login);
    }
  }

  void _restart() {
    ref.read(sessionProvider.notifier).clearFlow();
    context.go(ref.read(registrationDraftProvider) != null ? AppRoutes.register : AppRoutes.login);
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final challenge = session.challenge;
    if (challenge != null && challenge.challengeId != _challengeId) _syncChallenge(challenge);
    final draft = ref.watch(registrationDraftProvider);

    if (challenge == null) {
      return BrandSheetScaffold(
        body: EmptyState(
          icon: Icons.mark_email_unread_outlined,
          title: 'Kode verifikasi belum tersedia',
          message: 'Masuk kembali dengan email dan password Anda untuk menerima kode verifikasi baru.',
          actionLabel: 'Ke halaman masuk',
          onAction: () =>
              session.hasSession ? ref.read(sessionProvider.notifier).logout() : context.go(AppRoutes.login),
        ),
      );
    }

    final wait = _resendWait(challenge);
    final expired = _codeExpired(challenge);
    final canVerify = !expired && !_verifying && _code.text.length == 6;
    final email = challenge.emailMasked ?? 'email Anda';

    return BrandSheetScaffold(
      bottomBar: KapdhButton(
        key: const ValueKey('otp-submit'),
        label: 'Verifikasi',
        busyLabel: 'Memeriksa...',
        busy: _verifying,
        onPressed: canVerify ? _verify : null,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                IconButton(tooltip: 'Kembali', icon: const Icon(Icons.chevron_left, size: 28), onPressed: _back),
                const SizedBox(width: KapdhSpace.s1),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: const Text(
                      'Daftar Alumni',
                      style: TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: KapdhSpace.s4),
            const RegisterStepper(current: 1),
            const SizedBox(height: KapdhSpace.s6),
            Semantics(
              header: true,
              child: const Text(
                'Masukkan kode verifikasi',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.25),
              ),
            ),
            const SizedBox(height: KapdhSpace.s2),
            Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: 'Kode 6 digit sudah dikirim ke '),
                  TextSpan(
                    text: email,
                    style: const TextStyle(fontWeight: FontWeight.w600, color: KapdhColors.text),
                  ),
                  const TextSpan(text: '. Kode berlaku 10 menit.'),
                ],
              ),
              style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
            ),
            const SizedBox(height: KapdhSpace.s5),
            const ExcludeSemantics(
              child: Text(
                'Kode OTP',
                style: TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500),
              ),
            ),
            const SizedBox(height: 10),
            OtpBoxes(
              controller: _code,
              autofocus: true,
              enabled: !expired && !_verifying,
              errorText: _error,
              onChanged: (_) => setState(() {
                if (_error != null && !expired) _error = null;
              }),
              onCompleted: (_) => _verify(),
            ),
            const SizedBox(height: 10),
            Text(
              expired
                  ? 'Kode tidak berlaku lagi. Minta kode baru.'
                  : 'Sisa percobaan: $_attemptsLeft dari $otpMaxAttempts',
              style: TextStyle(
                fontSize: KapdhFontSize.caption,
                color: expired ? KapdhColors.danger : KapdhColors.textMuted,
              ),
            ),
            const SizedBox(height: KapdhSpace.s5),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: KapdhSpace.s1),
              decoration: BoxDecoration(
                color: KapdhColors.green50,
                borderRadius: BorderRadius.circular(KapdhRadius.md),
              ),
              child: Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: KapdhSpace.s2),
                    child: Text('Tidak menerima kode?', style: TextStyle(fontSize: 13)),
                  ),
                  TextButton(
                    key: const ValueKey('otp-resend'),
                    onPressed: wait > Duration.zero || _resending || _challengeDead ? null : _resend,
                    style: TextButton.styleFrom(
                      textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                      disabledForegroundColor: KapdhColors.textMuted,
                    ),
                    child: Text(
                      _resending
                          ? 'Mengirim...'
                          : (wait > Duration.zero ? 'Kirim ulang dalam ${formatCountdown(wait)}' : 'Kirim ulang'),
                    ),
                  ),
                ],
              ),
            ),
            if (_challengeDead) ...[
              const SizedBox(height: KapdhSpace.s3),
              KapdhButton.outlined(
                label: draft != null ? 'Mulai ulang pendaftaran' : 'Masuk kembali',
                onPressed: _restart,
              ),
            ],
            if (draft?.submitted ?? false) ...[
              const SizedBox(height: KapdhSpace.s2),
              Align(
                alignment: Alignment.centerLeft,
                child: KapdhLinkButton(label: 'Salah email? Ubah alamat email', onPressed: _restart),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
