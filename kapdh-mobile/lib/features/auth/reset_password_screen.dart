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
import '../../core/validation/password.dart';
import '../../design/design.dart';
import 'auth_flow.dart';
import 'auth_flow_repository.dart';
import 'auth_widgets.dart';
import 'otp_challenge.dart';

/// Lupa Password langkah 3 (F-02, AC F02-4): sandi baru disimpan dengan `reset_token` sekali pakai (POST
/// /auth/password/reset); server mencabut seluruh sesi akun dan mengirim pemberitahuan keamanan.
///
/// - Aturan PRD 2.5 dihitung dalam byte UTF-8 (8 sampai 72 byte, huruf besar, kecil, angka, simbol); lebih dari 72
///   byte ditolak, tidak dipotong.
/// - `reset_token` berlaku 10 menit (PasswordResetGrant.expires_at, dinilai dengan jam server).
/// - Respons hilang lalu pengulangan 410: sandi baru mungkin sudah tersimpan, sehingga pengguna diarahkan masuk
///   dengan sandi baru sebelum disarankan mengulang lupa sandi (kontrak C1, PRD 4.5).
/// - Meninggalkan layar (tombol kembali judul atau sistem) selama izin masih berlaku meminta konfirmasi dulu, karena
///   kode yang sudah dipakai tidak dapat dipakai lagi (PRD 4.5, 2.5).
class ResetPasswordScreen extends ConsumerStatefulWidget {
  const ResetPasswordScreen({super.key});

  @override
  ConsumerState<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

/// Keadaan akhir layar Password Baru.
enum _ResetOutcome {
  /// Formulir masih dapat dikirim.
  editing,

  /// Sandi baru tersimpan (204).
  saved,

  /// reset_token tidak berlaku (410) tanpa percobaan yang hasilnya tidak diketahui.
  tokenGone,

  /// 410 setelah percobaan yang hasilnya tidak diketahui: sandi baru mungkin sudah tersimpan.
  maybeSaved,
}

class _ResetPasswordScreenState extends ConsumerState<ResetPasswordScreen> {
  final _form = GlobalKey<FormState>();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  Timer? _ticker;
  bool _busy = false;
  String? _error;
  Map<String, List<String>> _fieldErrors = const {};
  bool _outcomeUnknown = false;
  _ResetOutcome _outcome = _ResetOutcome.editing;

  /// Saat layar dibuka menurut jam perangkat: token terbit paling lambat saat itu, sehingga pasti kedaluwarsa
  /// [otpValidity] sesudahnya walau jam server belum diketahui.
  late final DateTime _openedAt = ref.read(serverClockProvider).deviceNow();

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _outcome == _ResetOutcome.editing) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  /// Sisa waktu token menurut jam server; null bila jam server belum diketahui (keputusan diserahkan ke server).
  Duration? _remaining() {
    final clock = ref.read(serverClockProvider);
    if (clock.deviceNow().difference(_openedAt) >= otpValidity) return Duration.zero;
    final expiresAt = ref.read(resetGrantExpiryProvider);
    if (expiresAt == null || !clock.isSynced) return null;
    final left = expiresAt.difference(clock.now());
    return left.isNegative ? Duration.zero : left;
  }

  Future<void> _submit() async {
    final token = ref.read(sessionProvider).resetToken;
    if (token == null || _busy || _outcome != _ResetOutcome.editing || _remaining() == Duration.zero) return;
    setState(() => _fieldErrors = const {});
    if (!(_form.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authFlowRepositoryProvider).resetPassword(resetToken: token, newPassword: _password.text);
      if (!mounted) return;
      setState(() {
        _outcome = _ResetOutcome.saved;
        _password.clear();
        _confirm.clear();
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        if (isUnknownOutcome(error)) {
          _outcomeUnknown = true;
          _error = error.isNetwork
              ? 'Koneksi terputus sebelum hasil diterima. Periksa koneksi lalu ketuk Simpan lagi.'
              : 'Hasil penyimpanan belum diketahui. Ketuk Simpan lagi untuk memeriksa.';
        } else if (error.code == ErrorCode.otpExpired) {
          _outcome = _outcomeUnknown ? _ResetOutcome.maybeSaved : _ResetOutcome.tokenGone;
          _password.clear();
          _confirm.clear();
        } else {
          _outcomeUnknown = false;
          _fieldErrors = error.fieldErrors;
          final general = error.fieldErrors['_']?.join(' ');
          _error = error.fieldErrors.isEmpty ? error.message : general;
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _signIn(LoginNotice notice) {
    ref.read(loginNoticeProvider.notifier).show(notice);
    context.go(AppRoutes.login);
    ref.read(sessionProvider.notifier).clearFlow();
  }

  void _restart() {
    context.go(AppRoutes.forgot);
    ref.read(sessionProvider.notifier).clearFlow();
  }

  /// Izin membuat password baru masih dapat dipakai: kodenya sudah dikonsumsi, sehingga meninggalkan layar berarti
  /// meminta kode baru (dihitung ke batas 5 kirim per jam, PRD 2.5).
  bool get _grantUsable =>
      _outcome == _ResetOutcome.editing &&
      ref.read(sessionProvider).resetToken != null &&
      _remaining() != Duration.zero;

  /// Tombol kembali di judul dan tombol kembali sistem (PopScope) berperilaku sama.
  void _onBack() {
    if (_busy) return;
    if (_outcome == _ResetOutcome.saved) {
      _signIn(_savedNotice);
    } else if (_grantUsable) {
      unawaited(_confirmLeave());
    } else {
      _restart();
    }
  }

  /// Konfirmasi sebelum membuang izin sekali pakai (PRD 4.5: konfirmasi untuk tindakan yang tidak dapat dibatalkan).
  Future<void> _confirmLeave() async {
    final leave = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Batalkan password baru?'),
        content: const Text(
          'Kode pemulihan sudah dipakai dan tidak dapat dipakai lagi. Bila keluar sekarang, Anda perlu meminta kode '
          'baru untuk membuat password baru.',
        ),
        actions: [
          TextButton(
            key: const ValueKey('reset-leave-stay'),
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Lanjutkan mengisi'),
          ),
          TextButton(
            key: const ValueKey('reset-leave-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Ya, batalkan'),
          ),
        ],
      ),
    );
    if (leave == true && mounted) _restart();
  }

  // Rute /forgot/reset bersarang di /forgot: tombol kembali sistem tidak boleh diam-diam kembali ke langkah email dan
  // meninggalkan reset_token, jadi seluruh pop ditangani [_onBack].
  Widget _scaffold(Widget body) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) _onBack();
    },
    child: BrandSheetScaffold(
      body: Form(
        key: _form,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AuthSheetTitle(title: 'Lupa Password', onBack: _onBack),
              const SizedBox(height: KapdhSpace.s4),
              const RecoveryStepper(current: 2),
              const SizedBox(height: KapdhSpace.s6),
              body,
            ],
          ),
        ),
      ),
    ),
  );

  static const _savedNotice = LoginNotice(
    success: true,
    title: 'Password berhasil diganti',
    message: 'Masuk dengan password baru Anda. Perangkat lain yang masuk ke akun ini sudah dikeluarkan.',
  );

  @override
  Widget build(BuildContext context) {
    switch (_outcome) {
      case _ResetOutcome.saved:
        return _scaffold(
          AuthResultPanel(
            icon: KapdhIcons.checkCircle,
            iconColor: KapdhColors.success,
            title: 'Password berhasil diganti',
            message:
                'Password baru sudah tersimpan dan semua perangkat yang masuk ke akun ini telah dikeluarkan. Masuk '
                'kembali dengan password baru Anda.',
            actions: [
              KapdhButton(key: const ValueKey('reset-signin'), label: 'Masuk', onPressed: () => _signIn(_savedNotice)),
            ],
          ),
        );
      case _ResetOutcome.maybeSaved:
        return _scaffold(
          AuthResultPanel(
            icon: KapdhIcons.helpOutline,
            iconColor: KapdhColors.warning,
            title: 'Password baru mungkin sudah tersimpan',
            message:
                'Koneksi sempat terputus saat menyimpan, dan tautan pemulihan ini sudah tidak berlaku lagi. Coba '
                'masuk dengan password baru Anda terlebih dahulu. Bila gagal, ulangi lupa password.',
            actions: [
              KapdhButton(
                key: const ValueKey('reset-try-login'),
                label: 'Masuk dengan password baru',
                onPressed: () => _signIn(
                  const LoginNotice(
                    message:
                        'Coba masuk dengan password baru Anda. Bila ditolak, gunakan Lupa Password untuk menerima '
                        'kode baru.',
                  ),
                ),
              ),
              KapdhButton.outlined(
                key: const ValueKey('reset-restart'),
                label: 'Ulangi lupa password',
                onPressed: _restart,
              ),
            ],
          ),
        );
      case _ResetOutcome.tokenGone:
        return _scaffold(
          AuthResultPanel(
            icon: KapdhIcons.timerOffOutlined,
            iconColor: KapdhColors.danger,
            title: 'Sesi pemulihan berakhir',
            message:
                'Izin membuat password baru sudah tidak berlaku (kedaluwarsa atau sudah dipakai). Ulangi lupa password '
                'untuk menerima kode baru.',
            actions: [
              KapdhButton(key: const ValueKey('reset-restart'), label: 'Ulangi lupa password', onPressed: _restart),
            ],
          ),
        );
      case _ResetOutcome.editing:
        return _scaffold(_editing());
    }
  }

  Widget _editing() {
    final check = checkPassword(_password.text);
    final counter = passwordCounter(check);
    final remaining = _remaining();
    final timedOut = remaining == Duration.zero;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: const Text(
            'Buat password baru',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.25),
          ),
        ),
        const SizedBox(height: KapdhSpace.s2),
        const Text(
          'Setelah disimpan, semua perangkat yang masuk ke akun ini akan dikeluarkan dan Anda masuk kembali dengan '
          'password baru.',
          style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
        ),
        if (remaining != null && !timedOut) ...[
          const SizedBox(height: KapdhSpace.s2),
          Text(
            'Selesaikan dalam ${formatCountdown(remaining)}',
            style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
          ),
        ],
        const SizedBox(height: KapdhSpace.s5),
        AutofillGroup(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              KapdhTextField(
                key: const ValueKey('reset-password'),
                label: 'Password Baru',
                controller: _password,
                hint: 'Masukkan password baru',
                obscurable: true,
                enabled: !timedOut,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.newPassword],
                // Kemajuan menuju minimum 8 byte, merah selama belum terpenuhi (guideline hal. 5 "0/8").
                trailingText: counter.text,
                trailingTextColor: counter.problem ? KapdhColors.danger : KapdhColors.textMuted,
                errorText: _fieldErrors['new_password']?.join(' '),
                onChanged: (_) => setState(() {}),
                validator: (v) => checkPassword(v ?? '').valid ? null : 'Belum memenuhi aturan password',
              ),
              PasswordRules(check: check),
              const SizedBox(height: KapdhSpace.s4),
              KapdhTextField(
                key: const ValueKey('reset-confirm'),
                label: 'Ulangi Password Baru',
                controller: _confirm,
                hint: 'Ketik ulang password baru',
                obscurable: true,
                enabled: !timedOut,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.newPassword],
                validator: (v) => v == _password.text ? null : 'Password tidak sama',
                onSubmitted: (_) => _submit(),
              ),
            ],
          ),
        ),
        if (timedOut) ...[
          const SizedBox(height: KapdhSpace.s4),
          InfoBox(
            tone: InfoBoxTone.warning,
            message:
                'Waktu membuat password baru sudah habis (10 menit). Ulangi lupa password untuk menerima kode baru.',
            trailing: TextButton(
              key: const ValueKey('reset-expired-restart'),
              onPressed: _restart,
              child: const Text('Ulangi'),
            ),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: KapdhSpace.s3),
          Semantics(
            liveRegion: true,
            child: InfoBox(tone: InfoBoxTone.danger, message: _error!),
          ),
        ],
        const SizedBox(height: KapdhSpace.s5),
        KapdhButton(
          key: const ValueKey('reset-submit'),
          label: 'Simpan password baru',
          busyLabel: 'Menyimpan...',
          busy: _busy,
          onPressed: timedOut ? null : _submit,
        ),
      ],
    );
  }
}
