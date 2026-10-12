import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/auth_api.dart';
import '../../core/auth/session.dart';
import 'widgets/register_stepper.dart';

/// Langkah 2: verifikasi OTP email (AC F01-2, F01-3). 6 digit, 10 menit, maks 5 percobaan, kirim ulang 60 detik.
class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key});

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  final _code = TextEditingController();
  Timer? _ticker;
  OtpChallenge? _challenge;
  bool _busy = false;
  String? _error;
  bool _expired = false;

  @override
  void initState() {
    super.initState();
    _challenge = ref.read(sessionProvider).challenge;
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _code.dispose();
    super.dispose();
  }

  Duration get _resendIn {
    final c = _challenge;
    if (c == null) return Duration.zero;
    final left = c.resendAvailableAt.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  Future<void> _verify() async {
    final c = _challenge;
    if (c == null || _code.text.length != 6) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final tokens = await ref.read(authApiProvider).verifySignupOtp(c.challengeId, _code.text);
      await ref.read(sessionProvider.notifier).completeSignup(tokens);
    } on ApiException catch (e) {
      setState(() {
        _error = e.message;
        _expired = e.code == 'OTP_EXPIRED';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    final c = _challenge;
    if (c == null) return;
    try {
      final next = await ref.read(authApiProvider).resendOtp(c.challengeId);
      await ref.read(sessionProvider.notifier).startRegistration(next);
      setState(() {
        _challenge = next;
        _code.clear();
        _error = null;
        _expired = false;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _challenge;
    final wait = _resendIn;
    final waitText = '${wait.inMinutes}:${(wait.inSeconds % 60).toString().padLeft(2, '0')}';
    return BrandSheet(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s5, KapdhSpace.s8),
        children: [
          Row(children: [
            IconButton(tooltip: 'Kembali', icon: const Icon(Icons.chevron_left), onPressed: () => context.go('/register')),
            Text('Daftar Alumni', style: Theme.of(context).textTheme.titleLarge),
          ]),
          const SizedBox(height: KapdhSpace.s3),
          const RegisterStepper(current: 1),
          const SizedBox(height: KapdhSpace.s6),
          Text('Masukkan kode verifikasi', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: KapdhSpace.s2),
          Text('Kode 6 digit sudah dikirim ke ${c?.emailMasked ?? 'email Anda'}. Kode berlaku 10 menit.'),
          const SizedBox(height: KapdhSpace.s5),
          TextField(
            controller: _code,
            autofocus: true,
            keyboardType: TextInputType.number,
            autofillHints: const [AutofillHints.oneTimeCode],
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 28, letterSpacing: 12, fontWeight: FontWeight.w600),
            decoration: InputDecoration(labelText: 'Kode OTP', errorText: _error, counterText: c == null ? null : 'Sisa percobaan: ${c.attemptsLeft} dari 5'),
            onChanged: (v) {
              setState(() {});
              if (v.length == 6) _verify();
            },
          ),
          const SizedBox(height: KapdhSpace.s4),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s1),
            decoration: BoxDecoration(color: KapdhColors.green50, borderRadius: BorderRadius.circular(KapdhRadius.md)),
            child: Row(children: [
              const Expanded(child: Text('Tidak menerima kode?')),
              TextButton(
                onPressed: wait == Duration.zero || _expired ? _resend : null,
                child: Text(wait == Duration.zero || _expired ? 'Kirim ulang' : 'Kirim ulang dalam $waitText'),
              ),
            ]),
          ),
          const SizedBox(height: KapdhSpace.s6),
          FilledButton(onPressed: !_busy && _code.text.length == 6 ? _verify : null, child: Text(_busy ? 'Memeriksa...' : 'Verifikasi')),
        ],
      ),
    );
  }
}
