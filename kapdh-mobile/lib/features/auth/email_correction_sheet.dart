import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import 'auth_flow_repository.dart';
import 'auth_widgets.dart';

/// Hasil lembar koreksi email.
sealed class EmailCorrectionResult {
  const EmailCorrectionResult();
}

/// Email dikoreksi; challenge `email_change` baru sudah dikirim ke [newEmail]. [password] sudah dibuktikan benar oleh
/// server dan hanya dipakai untuk pemulihan hasil verifikasi yang tidak diketahui (memori, kontrak C1).
final class EmailCorrected extends EmailCorrectionResult {
  const EmailCorrected({required this.challenge, required this.newEmail, required this.password});

  final OtpChallenge challenge;
  final String newEmail;
  final String password;
}

/// Challenge tidak dikenal/sudah dipakai atau akun tidak lagi pending_otp (410 OTP_EXPIRED): alur dimulai ulang.
final class EmailCorrectionChallengeGone extends EmailCorrectionResult {
  const EmailCorrectionChallengeGone(this.message);

  final String message;
}

/// Membuka lembar "Ubah alamat email" untuk challenge aktivasi [challengeId] (prototipe layar 1, PRD 2.2).
Future<EmailCorrectionResult?> showEmailCorrectionSheet(
  BuildContext context, {
  required String challengeId,
  String? currentEmail,
}) => showModalBottomSheet<EmailCorrectionResult>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (_) => EmailCorrectionSheet(challengeId: challengeId, currentEmail: currentEmail),
);

/// Koreksi email akun pending_otp melalui alur terverifikasi (PRD 2.2 "koreksi email melalui alur terverifikasi",
/// kontrak C1 correctPendingEmail). Kepemilikan dibuktikan challenge aktivasi milik layar OTP dan password akun;
/// kode baru dikirim ke email baru dan email lama tidak dapat lagi mengaktifkan akun. Akun baru aktif setelah kode
/// dari email baru diverifikasi (AC F01-2).
class EmailCorrectionSheet extends ConsumerStatefulWidget {
  const EmailCorrectionSheet({super.key, required this.challengeId, this.currentEmail});

  final String challengeId;

  /// Email yang diketik pengguna sebelumnya (bila diketahui) untuk menolak koreksi ke email yang sama.
  final String? currentEmail;

  @override
  ConsumerState<EmailCorrectionSheet> createState() => _EmailCorrectionSheetState();
}

class _EmailCorrectionSheetState extends ConsumerState<EmailCorrectionSheet> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;
  Map<String, List<String>> _fieldErrors = const {};
  DateTime? _blockedUntil;
  Timer? _ticker;

  @override
  void dispose() {
    _ticker?.cancel();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  DateTime _now() => ref.read(clockProvider)();

  Duration get _blockedFor {
    final until = _blockedUntil;
    if (until == null) return Duration.zero;
    final left = until.difference(_now());
    return left.isNegative ? Duration.zero : left;
  }

  void _block(Duration wait) {
    _blockedUntil = _now().add(wait);
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      setState(() {});
      if (_blockedFor == Duration.zero) timer.cancel();
    });
  }

  String? _validateEmail(String? value) {
    final email = (value ?? '').trim();
    if (!looksLikeEmail(email)) return 'Masukkan email yang valid';
    final current = widget.currentEmail?.trim().toLowerCase();
    if (current != null && current.isNotEmpty && email.toLowerCase() == current) {
      return 'Email baru sama dengan email sebelumnya';
    }
    return null;
  }

  Future<void> _submit() async {
    if (_busy || _blockedFor > Duration.zero) return;
    setState(() => _fieldErrors = const {});
    if (!(_form.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    final newEmail = _email.text.trim();
    final password = _password.text;
    try {
      final challenge = await ref
          .read(authFlowRepositoryProvider)
          .correctEmail(challengeId: widget.challengeId, password: password, newEmail: newEmail);
      if (!mounted) return;
      Navigator.of(context).pop(EmailCorrected(challenge: challenge, newEmail: newEmail, password: password));
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.otpExpired) {
        Navigator.of(context).pop(EmailCorrectionChallengeGone(error.message));
        return;
      }
      setState(() {
        _fieldErrors = error.fieldErrors;
        final general = error.fieldErrors['_']?.join(' ');
        _error = error.fieldErrors.isEmpty ? error.message : general;
        final wait = error.retryAfter;
        if (error.code == ErrorCode.rateLimited && wait != null) _block(wait);
        if (error.fieldErrors.containsKey('password')) _password.clear();
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String? _fieldError(String key) => _fieldErrors[key]?.join(' ');

  @override
  Widget build(BuildContext context) {
    final blocked = _blockedFor;
    final inset = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: inset),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s6),
        child: Form(
          key: _form,
          child: AutofillGroup(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  header: true,
                  child: const Text(
                    'Ubah alamat email',
                    style: TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600),
                  ),
                ),
                const SizedBox(height: KapdhSpace.s2),
                const Text(
                  'Akun Anda belum terverifikasi. Masukkan email yang benar dan password akun Anda. Kode verifikasi '
                  'baru dikirim ke email baru, dan email lama tidak dapat lagi dipakai untuk aktivasi.',
                  style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
                ),
                const SizedBox(height: KapdhSpace.s5),
                KapdhTextField(
                  key: const ValueKey('correction-email'),
                  label: 'Email baru',
                  controller: _email,
                  hint: 'Masukkan email yang benar',
                  prefixIcon: Icons.mail_outline,
                  keyboardType: TextInputType.emailAddress,
                  textInputAction: TextInputAction.next,
                  autofillHints: const [AutofillHints.email],
                  errorText: _fieldError('new_email'),
                  validator: _validateEmail,
                ),
                const SizedBox(height: KapdhSpace.s4),
                KapdhTextField(
                  key: const ValueKey('correction-password'),
                  label: 'Password',
                  controller: _password,
                  hint: 'Password akun Anda',
                  helperText: 'Password yang Anda buat saat mendaftar',
                  obscurable: true,
                  textInputAction: TextInputAction.done,
                  autofillHints: const [AutofillHints.password],
                  errorText: _fieldError('password'),
                  validator: (v) => (v ?? '').isEmpty ? 'Masukkan password akun' : null,
                  onSubmitted: (_) => _submit(),
                ),
                if (_error != null) ...[
                  const SizedBox(height: KapdhSpace.s3),
                  Semantics(
                    liveRegion: true,
                    child: InfoBox(tone: InfoBoxTone.danger, message: _error!),
                  ),
                ],
                const SizedBox(height: KapdhSpace.s5),
                KapdhButton(
                  key: const ValueKey('correction-submit'),
                  label: blocked > Duration.zero
                      ? 'Coba lagi dalam ${formatCountdown(blocked)}'
                      : 'Kirim kode ke email baru',
                  busyLabel: 'Mengirim...',
                  busy: _busy,
                  onPressed: blocked > Duration.zero ? null : _submit,
                ),
                const SizedBox(height: KapdhSpace.s2),
                KapdhButton.outlined(
                  key: const ValueKey('correction-cancel'),
                  label: 'Batal',
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
