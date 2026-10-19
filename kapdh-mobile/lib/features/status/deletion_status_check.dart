import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import '../auth/otp_screen.dart' show attemptsLeftFrom, otpMaxAttempts;
import 'deletion_portal.dart';
import 'status_repository.dart';

/// Pemeriksaan ulang status penghapusan tanpa sesi (PRD 2.2 "pemeriksaan status penghapusan dengan challenge
/// terbatas", F-14): kode OTP `deletion` dikirim ke email akun (POST /public/deletion/challenge), lalu
/// POST /public/deletion/verify mengembalikan status permintaan terbuka. Respons challenge sama untuk email apa pun
/// (non-enumerasi, PRD 2.5), sehingga layar tidak pernah menyatakan email terdaftar atau tidak. Kode dan token hanya
/// di memori.
class DeletionStatusCheck extends ConsumerStatefulWidget {
  const DeletionStatusCheck({super.key, this.initialEmail});

  final String? initialEmail;

  @override
  ConsumerState<DeletionStatusCheck> createState() => _DeletionStatusCheckState();
}

class _DeletionStatusCheckState extends ConsumerState<DeletionStatusCheck> {
  late final TextEditingController _email = TextEditingController(text: widget.initialEmail ?? '');
  final _code = TextEditingController();
  OtpChallenge? _challenge;

  /// Sisa percobaan challenge aktif (PRD 2.5: 5 percobaan): awal dari challenge, lalu dari jawaban server setelah
  /// kode salah (`field_errors.code` "Sisa percobaan N"). Nol berarti kode tidak berlaku lagi dan perlu kode baru.
  int _attemptsLeft = otpMaxAttempts;
  bool _busy = false;
  String? _emailError;
  String? _codeError;
  String? _expiredNote;
  Timer? _ticker;

  StatusRepository get _repo => ref.read(statusRepositoryProvider);

  @override
  void dispose() {
    _ticker?.cancel();
    _email.dispose();
    _code.dispose();
    super.dispose();
  }

  static final RegExp _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');

  Duration get _resendWait {
    final challenge = _challenge;
    if (challenge == null) return Duration.zero;
    final left = challenge.resendAvailableAt.difference(ref.read(serverClockProvider).now());
    return left.isNegative ? Duration.zero : left;
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      setState(() {});
      if (_resendWait == Duration.zero) timer.cancel();
    });
  }

  Future<void> _send() async {
    final email = _email.text.trim();
    if (!_emailPattern.hasMatch(email)) {
      setState(() => _emailError = 'Masukkan email akun yang valid.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _emailError = null;
      _expiredNote = null;
    });
    try {
      final challenge = await _repo.startDeletionCheck(email);
      if (!mounted) return;
      setState(() {
        _challenge = challenge;
        _attemptsLeft = challenge.attemptsLeft;
        _code.clear();
        _codeError = null;
      });
      _startTicker();
    } on ApiException catch (error) {
      if (!mounted) return;
      final emailErrors = error.fieldErrors['email'];
      if (emailErrors != null) {
        setState(() => _emailError = emailErrors.join(' '));
      } else {
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_send())));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    final challenge = _challenge;
    if (challenge == null || _busy || _resendWait > Duration.zero) return;
    setState(() => _busy = true);
    try {
      final next = await _repo.resendCode(challenge.challengeId);
      if (!mounted) return;
      setState(() {
        _challenge = next;
        _attemptsLeft = next.attemptsLeft;
        _code.clear();
        _codeError = null;
        _expiredNote = null;
      });
      _startTicker();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.otpExpired) {
        setState(() {
          _challenge = null;
          _expiredNote = 'Kode sebelumnya tidak berlaku lagi. Kirim kode baru.';
        });
      } else {
        unawaited(ref.read(errorPresenterProvider).present(error));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final challenge = _challenge;
    final code = _code.text;
    if (challenge == null || code.length != 6 || _busy || _attemptsLeft <= 0) return;
    setState(() {
      _busy = true;
      _codeError = null;
    });
    try {
      final result = await _repo.verifyDeletionCheck(challengeId: challenge.challengeId, code: code);
      if (!mounted) return;
      ref.read(deletionPortalProvider.notifier).showVerification(result, email: _email.text);
      _ticker?.cancel();
      setState(() {
        _challenge = null;
        _code.clear();
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      switch (error.code) {
        case ErrorCode.validationError:
          // Kode salah: sisa percobaan dari server (kontrak verifyWebDeletion), atau berkurang satu bila pesan
          // server tidak memuatnya. Kotak dikosongkan agar kode berikutnya diketik dari awal.
          final left = attemptsLeftFrom(error) ?? math.max(0, _attemptsLeft - 1);
          setState(() {
            _attemptsLeft = left;
            _code.clear();
            _codeError = error.fieldErrors['code']?.join(' ') ?? error.message;
          });
        case ErrorCode.otpExpired:
          setState(() {
            _attemptsLeft = 0;
            _code.clear();
            _codeError = 'Kode tidak berlaku lagi.';
            _expiredNote =
                'Minta kode baru. Bila permintaan penghapusan sudah selesai, akun tidak lagi terdaftar dan Anda sudah '
                'menerima email pemberitahuan penyelesaian.';
          });
        default:
          unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_verify())));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final challenge = _challenge;
    final exhausted = _attemptsLeft <= 0;
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: context.kc.surface,
        border: Border.all(color: context.kc.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: const Text(
              'Periksa status terbaru',
              style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: KapdhSpace.s1),
          Text(
            'Kami kirim kode verifikasi ke email akun. Kode hanya membuka status penghapusan, bukan akses akun.',
            style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: context.kc.textMuted),
          ),
          const SizedBox(height: KapdhSpace.s3),
          if (challenge == null) ...[
            KapdhTextField(
              key: const ValueKey('deletion-check-email'),
              label: 'Email akun',
              controller: _email,
              hint: 'nama@email.com',
              prefixIcon: KapdhIcons.mailOutline,
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              errorText: _emailError,
              onSubmitted: (_) => _send(),
            ),
            if (_expiredNote case final note?) ...[
              const SizedBox(height: KapdhSpace.s2),
              InfoBox(tone: InfoBoxTone.warning, message: note),
            ],
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton.solid(
              key: const ValueKey('deletion-check-send'),
              label: 'Kirim kode verifikasi',
              busyLabel: 'Mengirim...',
              busy: _busy,
              onPressed: _send,
            ),
          ] else ...[
            Text(
              'Bila email ${challenge.emailMasked} terdaftar, kode 6 digit sudah dikirim. Kode berlaku sampai '
              '${formatTime(challenge.expiresAt)}.',
              style: const TextStyle(fontSize: 13, height: 1.5),
            ),
            const SizedBox(height: KapdhSpace.s3),
            OtpBoxes(
              controller: _code,
              enabled: !_busy && !exhausted,
              autofocus: true,
              errorText: _codeError,
              onChanged: (_) => setState(() => _codeError = null),
              onCompleted: (_) => _verify(),
            ),
            const SizedBox(height: KapdhSpace.s2),
            // Diumumkan pembaca layar saat berubah (sisa percobaan setelah kode salah, percobaan habis; N-11).
            Semantics(
              liveRegion: true,
              container: true,
              child: Text(
                exhausted
                    ? 'Kode tidak berlaku lagi. Kirim ulang kode untuk mendapatkan kode baru.'
                    : 'Sisa percobaan $_attemptsLeft dari ${challenge.maxAttempts ?? otpMaxAttempts}',
                style: TextStyle(
                  fontSize: KapdhFontSize.caption,
                  color: exhausted ? context.kc.danger : context.kc.textMuted,
                ),
              ),
            ),
            if (_expiredNote case final note?) ...[
              const SizedBox(height: KapdhSpace.s2),
              InfoBox(tone: InfoBoxTone.warning, message: note),
            ],
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton.solid(
              key: const ValueKey('deletion-check-verify'),
              label: 'Periksa status',
              busyLabel: 'Memeriksa...',
              busy: _busy,
              onPressed: _code.text.length == 6 && !exhausted ? _verify : null,
            ),
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              children: [
                KapdhLinkButton(
                  key: const ValueKey('deletion-check-resend'),
                  label: _resendWait > Duration.zero
                      ? 'Kirim ulang dalam ${formatCountdown(_resendWait)}'
                      : 'Kirim ulang kode',
                  onPressed: _resendWait > Duration.zero || _busy ? null : _resend,
                ),
                KapdhLinkButton(
                  label: 'Ganti email',
                  onPressed: _busy
                      ? null
                      : () {
                          _ticker?.cancel();
                          setState(() {
                            _challenge = null;
                            _codeError = null;
                            _expiredNote = null;
                          });
                        },
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
