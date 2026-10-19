import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import 'auth_widgets.dart';

/// Tanggapan atas satu pengiriman koreksi email yang ditampilkan lembar: galat per field (400/409), batas kirim
/// (429) atau pesan umum (mis. jawaban hilang). Null dari [EmailCorrectionSubmit] berarti alur koreksi selesai
/// (berhasil, dipulihkan, atau challenge tidak berlaku) dan lembar ditutup.
@immutable
class EmailCorrectionFeedback {
  const EmailCorrectionFeedback({this.message, this.fieldErrors = const {}, this.retryAfter});

  /// Galat pasti dari server untuk request koreksi ini.
  factory EmailCorrectionFeedback.fromError(ApiException error) {
    final general = error.fieldErrors['_']?.join(' ');
    return EmailCorrectionFeedback(
      message: error.fieldErrors.isEmpty ? error.message : general,
      fieldErrors: error.fieldErrors,
      retryAfter: error.code == ErrorCode.rateLimited ? error.retryAfter : null,
    );
  }

  /// Pesan umum di bawah formulir.
  final String? message;
  final Map<String, List<String>> fieldErrors;

  /// RATE_LIMITED: tombol kirim terkunci selama ini (retry_after_seconds).
  final Duration? retryAfter;
}

/// Mengirim koreksi email untuk challenge milik layar OTP dan menerapkan hasilnya di layar itu.
typedef EmailCorrectionSubmit =
    Future<EmailCorrectionFeedback?> Function({required String newEmail, required String password});

/// Membuka lembar "Ubah alamat email" (prototipe layar 1, PRD 2.2). Request dijalankan [onSubmit] milik layar OTP,
/// bukan lembar, sehingga hasilnya tetap diterapkan walau lembar sempat tertutup (diseret) selama request berjalan;
/// selama mengirim, tombol kembali dan ketukan di luar lembar diabaikan (PRD 4.5).
Future<void> showEmailCorrectionSheet(
  BuildContext context, {
  required EmailCorrectionSubmit onSubmit,
  String? currentEmail,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (_) => EmailCorrectionSheet(onSubmit: onSubmit, currentEmail: currentEmail),
);

/// Formulir koreksi email akun pending_otp melalui alur terverifikasi (PRD 2.2 "koreksi email melalui alur
/// terverifikasi", kontrak C1 correctPendingEmail). Kepemilikan dibuktikan challenge aktivasi milik layar OTP dan
/// password akun; kode baru dikirim ke email baru dan email lama tidak dapat lagi mengaktifkan akun. Akun baru aktif
/// setelah kode dari email baru diverifikasi (AC F01-2).
class EmailCorrectionSheet extends ConsumerStatefulWidget {
  const EmailCorrectionSheet({super.key, required this.onSubmit, this.currentEmail});

  final EmailCorrectionSubmit onSubmit;

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
    try {
      final feedback = await widget.onSubmit(newEmail: _email.text.trim(), password: _password.text);
      if (!mounted) return;
      if (feedback == null) {
        Navigator.of(context).pop();
        return;
      }
      setState(() {
        _fieldErrors = feedback.fieldErrors;
        _error = feedback.message;
        final wait = feedback.retryAfter;
        if (wait != null) _block(wait);
        if (feedback.fieldErrors.containsKey('password')) _password.clear();
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
    // Selama koreksi dikirim, kembali/ketukan di luar lembar tidak menutupnya: pengguna melihat hasilnya di sini.
    return PopScope(
      canPop: !_busy,
      child: Padding(
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
                  Text(
                    'Akun Anda belum terverifikasi. Masukkan email yang benar dan password akun Anda. Kode '
                    'verifikasi baru dikirim ke email baru, dan email lama tidak dapat lagi dipakai untuk aktivasi.',
                    style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: context.kc.textMuted),
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  KapdhTextField(
                    key: const ValueKey('correction-email'),
                    label: 'Email baru',
                    controller: _email,
                    hint: 'Masukkan email yang benar',
                    prefixIcon: KapdhIcons.mailOutline,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    autofillHints: const [AutofillHints.email],
                    enabled: !_busy,
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
                    enabled: !_busy,
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
      ),
    );
  }
}
