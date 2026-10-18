import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'auth_flow.dart';
import 'auth_flow_repository.dart';
import 'auth_widgets.dart';

/// Pesan non-enumerasi lupa password (PRD 2.5): sama untuk email terdaftar, tidak terdaftar atau tidak memenuhi
/// syarat, karena server selalu menjawab 202 dengan challenge berbentuk sama.
const String forgotPasswordNeutralCopy =
    'Masukkan email akun alumni Anda. Bila email tersebut terdaftar dan aktif, kami mengirim kode 6 digit untuk '
    'membuat password baru.';

/// Lupa Password langkah 1 (F-02, PRD 2.5): email → POST /auth/password/forgot → layar kode pemulihan.
///
/// Respons tidak mengungkap apakah email terdaftar; batas kirim per email/IP tampil sebagai hitung mundur
/// (429 RATE_LIMITED). Cooldown kegagalan login tidak menutup alur ini (PRD 2.5).
class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _email = TextEditingController(text: ref.read(authEmailHintProvider));
  bool _busy = false;
  String? _error;
  Map<String, List<String>> _fieldErrors = const {};
  DateTime? _blockedUntil;
  Timer? _ticker;

  @override
  void dispose() {
    _ticker?.cancel();
    _email.dispose();
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

  Future<void> _submit() async {
    if (_busy || _blockedFor > Duration.zero) return;
    setState(() => _fieldErrors = const {});
    if (!(_form.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();
    final email = _email.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final challenge = await ref.read(authFlowRepositoryProvider).forgotPassword(email);
      if (!mounted) return;
      if (challenge.purpose != OtpPurpose.passwordReset) {
        setState(() => _error = 'Jawaban server tidak sesuai. Coba lagi.');
        return;
      }
      ref.read(authEmailHintProvider.notifier).set(email);
      // Alur pemulihan baru menggantikan challenge/token pemulihan sebelumnya di memori.
      ref.read(sessionProvider.notifier)
        ..clearFlow()
        ..setChallenge(challenge);
      context.go(AppRoutes.forgotOtp);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _fieldErrors = error.fieldErrors;
        final general = error.fieldErrors['_']?.join(' ');
        _error = error.fieldErrors.isEmpty ? error.message : general;
        final wait = error.retryAfter;
        if (error.code == ErrorCode.rateLimited && wait != null) _block(wait);
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _back() {
    ref.read(authEmailHintProvider.notifier).set(_email.text);
    context.go(AppRoutes.login);
  }

  @override
  Widget build(BuildContext context) {
    final blocked = _blockedFor;
    final pending = ref.watch(sessionProvider.select((s) => s.challenge));
    final hasPendingCode = pending?.purpose == OtpPurpose.passwordReset;
    return BrandSheetScaffold(
      body: Form(
        key: _form,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AuthSheetTitle(title: 'Lupa Password', onBack: _back),
              const SizedBox(height: KapdhSpace.s4),
              const RecoveryStepper(current: 0),
              const SizedBox(height: KapdhSpace.s6),
              Semantics(
                header: true,
                child: const Text(
                  'Atur ulang password',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.25),
                ),
              ),
              const SizedBox(height: KapdhSpace.s2),
              Text(
                forgotPasswordNeutralCopy,
                style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: context.kc.textMuted),
              ),
              const SizedBox(height: KapdhSpace.s5),
              AutofillGroup(
                child: KapdhTextField(
                  key: const ValueKey('forgot-email'),
                  label: 'Email',
                  controller: _email,
                  hint: 'Masukkan Email',
                  prefixIcon: KapdhIcons.mailOutline,
                  keyboardType: TextInputType.emailAddress,
                  textInputAction: TextInputAction.done,
                  autofillHints: const [AutofillHints.email],
                  errorText: _fieldErrors['email']?.join(' '),
                  validator: (v) => looksLikeEmail(v ?? '') ? null : 'Masukkan email yang valid',
                  onSubmitted: (_) => _submit(),
                ),
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
                key: const ValueKey('forgot-submit'),
                label: blocked > Duration.zero ? 'Coba lagi dalam ${formatCountdown(blocked)}' : 'Kirim kode',
                busyLabel: 'Mengirim...',
                busy: _busy,
                onPressed: blocked > Duration.zero ? null : _submit,
              ),
              if (hasPendingCode) ...[
                const SizedBox(height: KapdhSpace.s2),
                Center(
                  child: KapdhLinkButton(
                    key: const ValueKey('forgot-continue'),
                    label: 'Sudah menerima kode? Lanjutkan verifikasi',
                    onPressed: () => context.go(AppRoutes.forgotOtp),
                  ),
                ),
              ],
              const SizedBox(height: KapdhSpace.s4),
              const InfoBox(
                icon: KapdhIcons.shieldOutlined,
                message:
                    'Demi keamanan, kami tidak memberi tahu apakah sebuah email terdaftar. Periksa juga folder spam '
                    'bila kode belum masuk.',
              ),
              const SizedBox(height: KapdhSpace.s4),
              Wrap(
                alignment: WrapAlignment.center,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('Ingat password?', style: TextStyle(fontSize: 13, color: context.kc.primary)),
                  KapdhLinkButton(label: 'Masuk', onPressed: _back),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
