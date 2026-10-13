import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/validation/password.dart';
import '../../design/design.dart';
import 'widgets/scroll_column.dart';
import 'account_repository.dart';

/// Ganti password (F-02, AC F02-4: ganti sandi normal mensyaratkan sandi lama). Password baru mengikuti PRD 2.5
/// (8 sampai 72 byte UTF-8, huruf besar, kecil, angka dan simbol; ditolak, bukan dipotong). Setelah berhasil server
/// mencabut sesi perangkat lain dan mengirim notifikasi keamanan; perangkat ini tetap masuk. Sandi tidak pernah
/// disimpan atau dicatat (ARCHITECTURE §2 butir 3).
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  bool _submitted = false;
  Map<String, List<String>> _fieldErrors = const {};
  String? _error;
  DateTime? _blockedUntil;
  Timer? _ticker;

  @override
  void dispose() {
    _ticker?.cancel();
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Duration get _blockedFor {
    final until = _blockedUntil;
    if (until == null) return Duration.zero;
    final left = until.difference(ref.read(clockProvider)());
    return left.isNegative ? Duration.zero : left;
  }

  String? get _confirmProblem {
    if (_confirm.text.isEmpty) return _submitted ? 'Ulangi password baru' : null;
    return _confirm.text == _next.text ? null : 'Password baru tidak sama';
  }

  String? get _sameProblem => _next.text.isNotEmpty && _next.text == _current.text
      ? 'Password baru harus berbeda dari password saat ini'
      : null;

  bool get _canSubmit =>
      !_busy &&
      _current.text.isNotEmpty &&
      checkPassword(_next.text).valid &&
      _confirm.text == _next.text &&
      _sameProblem == null &&
      _blockedFor == Duration.zero;

  Future<void> _submit() async {
    setState(() => _submitted = true);
    if (!_canSubmit) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
      _fieldErrors = const {};
    });
    try {
      await ref.read(accountRepositoryProvider).changePassword(currentPassword: _current.text, newPassword: _next.text);
      if (!mounted) return;
      _current.clear();
      _next.clear();
      _confirm.clear();
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('Password diganti. Perangkat lain sudah dikeluarkan dari akun Anda.')),
      );
      final router = GoRouter.of(context);
      if (router.canPop()) {
        router.pop();
      } else {
        router.go(AppRoutes.account);
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      final fieldErrors = error.fieldErrors;
      setState(() {
        _fieldErrors = fieldErrors;
        final wait = error.retryAfter;
        if (error.ui.action == ErrorUiAction.showCountdown && wait != null) _startCountdown(wait);
        _error = fieldErrors['_']?.join(' ');
      });
      if (fieldErrors.isEmpty) {
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_submit())));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _startCountdown(Duration wait) {
    _blockedUntil = ref.read(clockProvider)().add(wait);
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      setState(() {});
      if (_blockedFor == Duration.zero) timer.cancel();
    });
  }

  String? _fieldError(String key) => _fieldErrors[key]?.join(' ');

  @override
  Widget build(BuildContext context) {
    final check = checkPassword(_next.text);
    final counter = passwordCounter(check);
    final blocked = _blockedFor;
    return AppScaffold(
      title: 'Ganti Password',
      fallbackLocation: AppRoutes.account,
      body: AutofillGroup(
        child: ScrollColumn(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s8),
          children: [
            const InfoBox(
              icon: Icons.lock_outline,
              message:
                  'Masukkan password saat ini untuk mengonfirmasi bahwa ini Anda. Setelah diganti, perangkat lain '
                  'yang masuk ke akun Anda akan dikeluarkan.',
            ),
            const SizedBox(height: KapdhSpace.s5),
            KapdhTextField(
              key: const ValueKey('password-current'),
              label: 'Password saat ini',
              controller: _current,
              hint: 'Masukkan password saat ini',
              obscurable: true,
              requiredMark: true,
              autofillHints: const [AutofillHints.password],
              textInputAction: TextInputAction.next,
              errorText:
                  _fieldError('current_password') ??
                  (_submitted && _current.text.isEmpty ? 'Password saat ini wajib diisi' : null),
              onChanged: (_) => setState(() => _fieldErrors = const {}),
            ),
            const SizedBox(height: KapdhSpace.s4),
            KapdhTextField(
              key: const ValueKey('password-new'),
              label: 'Password baru',
              controller: _next,
              hint: 'Masukkan password baru',
              obscurable: true,
              requiredMark: true,
              autofillHints: const [AutofillHints.newPassword],
              textInputAction: TextInputAction.next,
              trailingText: counter.text,
              trailingTextColor: counter.problem ? KapdhColors.danger : KapdhColors.textMuted,
              errorText:
                  _fieldError('new_password') ??
                  _sameProblem ??
                  (_submitted && !check.valid ? 'Belum memenuhi aturan password' : null),
              onChanged: (_) => setState(() {}),
            ),
            _PasswordRules(check: check),
            const SizedBox(height: KapdhSpace.s4),
            KapdhTextField(
              key: const ValueKey('password-confirm'),
              label: 'Ulangi password baru',
              controller: _confirm,
              hint: 'Ketik ulang password baru',
              obscurable: true,
              requiredMark: true,
              autofillHints: const [AutofillHints.newPassword],
              textInputAction: TextInputAction.done,
              errorText: _confirmProblem,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _submit(),
            ),
            if (_error case final message?) ...[
              const SizedBox(height: KapdhSpace.s4),
              Semantics(
                liveRegion: true,
                child: InfoBox(tone: InfoBoxTone.danger, message: message),
              ),
            ],
            const SizedBox(height: KapdhSpace.s6),
            KapdhButton(
              key: const ValueKey('password-submit'),
              label: blocked > Duration.zero ? 'Coba lagi dalam ${formatCountdown(blocked)}' : 'Simpan password',
              busyLabel: 'Menyimpan...',
              busy: _busy,
              // Tetap dapat diketuk agar isian yang belum memenuhi aturan ditandai (PRD 4.5); kirim hanya bila valid.
              onPressed: _busy || blocked > Duration.zero ? null : _submit,
            ),
            const SizedBox(height: KapdhSpace.s3),
            Center(
              child: KapdhLinkButton(
                label: 'Lupa password saat ini?',
                onPressed: () => ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                  const SnackBar(
                    content: Text('Keluar lalu pilih "Lupa Password" di halaman masuk untuk memulihkan password.'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Daftar aturan password PRD 2.5 dengan status terpenuhi (teks, bukan warna saja; N-11).
class _PasswordRules extends StatelessWidget {
  const _PasswordRules({required this.check});

  final PasswordCheck check;

  @override
  Widget build(BuildContext context) {
    Widget rule(bool ok, String label) => Semantics(
      label: '$label, ${ok ? 'terpenuhi' : 'belum terpenuhi'}',
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(
          children: [
            WidgetSpan(
              alignment: PlaceholderAlignment.middle,
              child: Padding(
                padding: const EdgeInsets.only(right: KapdhSpace.s1),
                child: Icon(
                  ok ? Icons.check_circle : Icons.radio_button_unchecked,
                  size: 16,
                  color: ok ? KapdhColors.success : KapdhColors.textMuted,
                ),
              ),
            ),
            TextSpan(text: label),
          ],
        ),
        style: const TextStyle(fontSize: KapdhFontSize.caption),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(top: KapdhSpace.s2),
      child: Wrap(
        spacing: KapdhSpace.s4,
        runSpacing: KapdhSpace.s1,
        children: [
          rule(check.lengthOk, '8 sampai 72 byte'),
          rule(check.hasUpper, 'Huruf besar'),
          rule(check.hasLower, 'Huruf kecil'),
          rule(check.hasDigit, 'Angka'),
          rule(check.hasSymbol, 'Simbol'),
        ],
      ),
    );
  }
}
