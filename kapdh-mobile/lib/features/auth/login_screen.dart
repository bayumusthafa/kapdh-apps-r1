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
import '../../core/ui/support_section.dart';
import '../../design/design.dart';

/// Login alumni (F-02, AC F02-1; guideline hal. 5). Setelah token terbit, router mengarahkan sesuai effective_status
/// (atau ke tujuan tertunda `?from=`); akun pending_otp diarahkan ke OTP dengan challenge baru. Akun yang sedang
/// dihapus atau dinonaktifkan tidak mendapat sesi (kontrak C1, PRD 2.2): statusnya ditampilkan di layar ini
/// beserta kontak pengurus.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  /// Akun tanpa sesi (deletion_pending/disabled) dari login terakhir; null bila tidak ada.
  LoginResult? _restricted;
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
      _restricted = null;
      _fieldErrors = const {};
    });
    try {
      final result = await ref.read(sessionProvider.notifier).login(email: _email.text, password: _password.text);
      if (!mounted) return;
      switch (result.outcome) {
        case LoginOutcome.verifyOtp:
          context.go(AppRoutes.registerOtp);
        case LoginOutcome.deletionPending || LoginOutcome.accountDisabled:
          setState(() {
            _restricted = result;
            _password.clear();
          });
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
                child: KapdhLinkButton(label: 'Lupa Password', onPressed: () => context.go(AppRoutes.forgot)),
              ),
              if (_error != null) ...[
                const SizedBox(height: KapdhSpace.s2),
                Semantics(
                  liveRegion: true,
                  child: InfoBox(tone: InfoBoxTone.danger, message: _error!),
                ),
              ],
              if (_restricted case final restricted?) ...[
                const SizedBox(height: KapdhSpace.s2),
                Semantics(liveRegion: true, child: _RestrictedAccountNotice(result: restricted)),
                const SizedBox(height: KapdhSpace.s3),
                const SupportSection(subject: 'Status Akun KAPDH', title: 'Hubungi pengurus'),
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

/// Status akun tanpa sesi setelah sandi benar (kontrak C1 `LoginNext`, PRD 2.2): permintaan penghapusan yang sedang
/// diproses (nomor permintaan dan batas penyelesaian, AC F14-1) atau akun yang dinonaktifkan pengurus.
class _RestrictedAccountNotice extends StatelessWidget {
  const _RestrictedAccountNotice({required this.result});

  final LoginResult result;

  @override
  Widget build(BuildContext context) {
    if (result.outcome == LoginOutcome.accountDisabled) {
      return const InfoBox(
        tone: InfoBoxTone.warning,
        title: 'Akun tidak aktif',
        message:
            'Akun ini sedang dinonaktifkan sehingga tidak dapat dipakai masuk. Pemulihan hanya dapat dilakukan '
            'pengurus setelah verifikasi identitas.',
      );
    }
    final deletion = result.deletion;
    final detail = deletion == null
        ? 'Anda akan menerima email setelah penghapusan selesai.'
        : 'Nomor permintaan ${deletion.requestNumber} (${StatusStyles.deletion(deletion.status).label}). '
              'Selesai paling lambat ${formatDateTime(deletion.estimatedCompletionAt)}.';
    return InfoBox(
      tone: InfoBoxTone.warning,
      title: 'Penghapusan akun sedang diproses',
      message: 'Akun ini tidak dapat dipakai masuk selama penghapusan berjalan. $detail',
    );
  }
}
