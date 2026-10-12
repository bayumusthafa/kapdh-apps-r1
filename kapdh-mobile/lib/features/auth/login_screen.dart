import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session.dart';
import 'widgets/register_stepper.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _canSubmit => _email.text.trim().isNotEmpty && _password.text.isNotEmpty && !_busy;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final challenge = await ref.read(sessionProvider.notifier).login(_email.text, _password.text);
      if (challenge != null && mounted) context.go('/register/otp');
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return BrandSheet(
      header: Padding(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s6, KapdhSpace.s6, KapdhSpace.s6, KapdhSpace.s8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Selamat', style: text.headlineSmall?.copyWith(color: KapdhColors.textOnDark)),
                  Text('Datang kembali', style: text.headlineSmall?.copyWith(color: KapdhColors.accent)),
                  const SizedBox(height: KapdhSpace.s3),
                  Text('Masuk untuk melanjutkan silaturahmi bersama alumni', style: text.bodyMedium?.copyWith(color: KapdhColors.textOnDark)),
                ],
              ),
            ),
            Image.asset('assets/logo-kapdh.png', width: 84, semanticLabel: 'Logo KAPDH'),
          ],
        ),
      ),
      child: ListView(
        padding: const EdgeInsets.all(KapdhSpace.s6),
        children: [
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            decoration: const InputDecoration(labelText: 'Email', hintText: 'Masukkan email', prefixIcon: Icon(Icons.mail_outline)),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: KapdhSpace.s4),
          TextField(
            controller: _password,
            obscureText: _obscure,
            autofillHints: const [AutofillHints.password],
            decoration: InputDecoration(
              labelText: 'Password',
              hintText: 'Masukkan password',
              errorText: _error,
              suffixIcon: IconButton(
                tooltip: _obscure ? 'Tampilkan password' : 'Sembunyikan password',
                icon: Icon(_obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
            ),
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _canSubmit ? _submit() : null,
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(onPressed: () => context.go('/forgot'), child: const Text('Lupa Password')),
          ),
          const SizedBox(height: KapdhSpace.s4),
          FilledButton(onPressed: _canSubmit ? _submit : null, child: Text(_busy ? 'Memeriksa...' : 'Masuk')),
          const SizedBox(height: KapdhSpace.s6),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('Belum ada akun?'),
              TextButton(onPressed: () => context.go('/register'), child: const Text('Daftar')),
            ],
          ),
        ],
      ),
    );
  }
}
