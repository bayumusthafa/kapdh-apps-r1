import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../status/deletion_portal.dart';
import 'auth_flow.dart';

/// Login alumni (F-02, AC F02-1; guideline hal. 5: pita hijau bermotif dengan logo, "Selamat" putih dan
/// "Datang kembali !!!" emas, tombol tampil/sembunyikan password, tautan Lupa Password). Setelah token terbit, router
/// mengarahkan sesuai effective_status (atau ke tujuan tertunda `?from=`); akun pending_otp diarahkan ke OTP dengan
/// challenge aktivasi dari server. Akun yang sedang dihapus atau dinonaktifkan tidak mendapat sesi (kontrak C1,
/// PRD 2.2): statusnya ditampilkan portal status penghapusan tanpa sesi (/deletion-status) beserta kontak pengurus.
/// Cooldown kegagalan login tidak menutup Lupa Password (PRD 2.5).
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  late final TextEditingController _email = TextEditingController(text: ref.read(authEmailHintProvider));
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  /// Pemberitahuan sekali tampil setelah alur pemulihan (mis. password baru tersimpan).
  LoginNotice? _notice;

  @override
  void initState() {
    super.initState();
    _notice = ref.read(loginNoticeProvider);
    if (_notice != null) {
      // Dikonsumsi sekali; provider tidak boleh diubah selama pohon widget sedang dibangun.
      Future.microtask(() {
        if (mounted) ref.read(loginNoticeProvider.notifier).clear();
      });
    }
  }

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

  bool get _canSubmit =>
      _email.text.trim().isNotEmpty && _password.text.isNotEmpty && !_busy && _blockedFor == Duration.zero;

  void _startCountdown(Duration wait) {
    _blockedUntil = _now().add(wait);
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      setState(() {});
      if (_blockedFor == Duration.zero) timer.cancel();
    });
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
      _fieldErrors = const {};
    });
    final email = _email.text;
    final password = _password.text;
    try {
      final result = await ref.read(sessionProvider.notifier).login(email: email, password: password);
      if (!mounted) return;
      switch (result.outcome) {
        case LoginOutcome.verifyOtp:
          // Hanya di memori, untuk pemulihan hasil verifikasi OTP yang tidak diketahui (kontrak C1 verifyOtp).
          ref.read(activationCredentialsProvider.notifier).remember(email: email, password: password);
          ref.read(authEmailHintProvider.notifier).set(email);
          context.go(AppRoutes.registerOtp);
        case LoginOutcome.deletionPending || LoginOutcome.accountDisabled:
          // Tanpa sesi (kontrak C1): status ditampilkan portal status penghapusan yang bekerja tanpa sesi
          // (PRD 2.2, F-14); sandi tidak disimpan.
          ref.read(deletionPortalProvider.notifier).showLoginResult(result, email: email);
          _password.clear();
          context.go(AppRoutes.deletionStatus);
        case LoginOutcome.signedIn:
          break;
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _fieldErrors = error.fieldErrors;
        _error = error.fieldErrors.isEmpty ? error.message : error.fieldErrors['_']?.join(' ');
        final wait = error.retryAfter;
        if (error.ui.action == ErrorUiAction.showCountdown && wait != null) _startCountdown(wait);
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String? _fieldError(String key) => _fieldErrors[key]?.join(' ');

  @override
  Widget build(BuildContext context) {
    final blocked = _blockedFor;
    return BrandSheetScaffold(
      overlap: KapdhSpace.s4,
      // Logo dan sapaan ikut bergulir: dengan keyboard terbuka pada teks 200 % kepala saja sudah melebihi ruang
      // yang tersisa (N-11).
      scrollable: true,
      header: BrandHeader(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s6, KapdhSpace.s4, KapdhSpace.s4, KapdhSpace.s8 + KapdhSpace.s4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.topRight,
              child: Image.asset('assets/logo-kapdh.png', width: 84, height: 84, semanticLabel: 'Logo KAPDH'),
            ),
            const SizedBox(height: KapdhSpace.s4),
            Semantics(
              header: true,
              child: const Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: 'Selamat\n',
                      style: TextStyle(color: KapdhColors.textOnDark),
                    ),
                    TextSpan(
                      text: 'Datang kembali !!!',
                      style: TextStyle(color: KapdhColors.accent),
                    ),
                  ],
                ),
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.3),
              ),
            ),
            const SizedBox(height: KapdhSpace.s3),
            const Text(
              'Masuk untuk melanjutkan silaturahmi bersama alumni',
              style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textOnDark),
            ),
          ],
        ),
      ),
      body: AutofillGroup(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s8, KapdhSpace.s5, KapdhSpace.s6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              KapdhTextField(
                key: const ValueKey('login-email'),
                label: 'Email',
                controller: _email,
                hint: 'Masukkan Email',
                prefixIcon: Icons.mail_outline,
                keyboardType: TextInputType.emailAddress,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.email],
                errorText: _fieldError('email'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: KapdhSpace.s4),
              KapdhTextField(
                key: const ValueKey('login-password'),
                label: 'Password',
                controller: _password,
                hint: 'Masukkan Password',
                obscurable: true,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.password],
                errorText: _fieldError('password'),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _submit(),
              ),
              Align(
                alignment: Alignment.centerRight,
                child: _ForgotPasswordLink(
                  onPressed: () {
                    ref.read(authEmailHintProvider.notifier).set(_email.text);
                    context.go(AppRoutes.forgot);
                  },
                ),
              ),
              if (_notice case final notice?) ...[
                const SizedBox(height: KapdhSpace.s2),
                Semantics(
                  liveRegion: true,
                  child: InfoBox(
                    key: const ValueKey('login-notice'),
                    tone: notice.success ? InfoBoxTone.info : InfoBoxTone.warning,
                    icon: notice.success ? Icons.check_circle_outline : null,
                    title: notice.title,
                    message: notice.message,
                  ),
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: KapdhSpace.s2),
                Semantics(
                  liveRegion: true,
                  child: InfoBox(tone: InfoBoxTone.danger, message: _error!),
                ),
              ],
              if (blocked > Duration.zero) ...[
                const SizedBox(height: KapdhSpace.s2),
                // PRD 2.5: cooldown kegagalan login tidak menutup jalur pemulihan.
                const Text(
                  'Sambil menunggu, Anda tetap dapat memulihkan akun lewat Lupa Password.',
                  style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                ),
              ],
              const SizedBox(height: KapdhSpace.s5),
              KapdhButton(
                key: const ValueKey('login-submit'),
                label: blocked > Duration.zero ? 'Coba lagi dalam ${formatCountdown(blocked)}' : 'Masuk',
                busyLabel: 'Memeriksa...',
                busy: _busy,
                onPressed: _canSubmit ? _submit : null,
              ),
              const SizedBox(height: KapdhSpace.s6),
              Wrap(
                alignment: WrapAlignment.center,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  const Text('Belum ada akun?', style: TextStyle(fontSize: 13, color: KapdhColors.primary)),
                  KapdhLinkButton(label: 'Daftar', onPressed: () => context.go(AppRoutes.register)),
                ],
              ),
              const SizedBox(height: KapdhSpace.s2),
              Wrap(
                alignment: WrapAlignment.center,
                children: [
                  KapdhLinkButton(
                    label: 'Kebijakan Privasi',
                    onPressed: () => context.push(AppRoutes.legal(AppRoutes.privacySlug)),
                  ),
                  KapdhLinkButton(label: 'Bantuan', onPressed: () => context.push(AppRoutes.legal(AppRoutes.helpSlug))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Tautan "Lupa Password" bergaris bawah di kanan bawah field password (guideline hal. 5), target sentuh 48 px.
class _ForgotPasswordLink extends StatelessWidget {
  const _ForgotPasswordLink({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      key: const ValueKey('login-forgot'),
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: KapdhColors.primary,
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s1),
        minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
        textStyle: const TextStyle(
          fontSize: KapdhFontSize.caption,
          fontWeight: FontWeight.w600,
          decoration: TextDecoration.underline,
          decorationColor: KapdhColors.primary,
        ),
      ),
      child: const Text('Lupa Password'),
    );
  }
}
