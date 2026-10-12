import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/auth_api.dart';
import '../../core/auth/session.dart';
import '../../core/validation/password.dart';
import '../membership/academic.dart';
import 'widgets/register_stepper.dart';

/// Langkah 1 pendaftaran: Data Diri (F-01, guidelines KAPDH). Tanpa Nomor KTP (v3.3).
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  static const policyVersion = '2026-10'; // diambil dari halaman legal berversi saat irisan konten

  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  String? _gender;
  int? _cohort;
  int? _classIn;
  int? _classOut;
  bool _agree = false;
  bool _obscure = true;
  bool _busy = false;
  String? _serverError;
  Map<String, List<String>> _fieldErrors = const {};

  /// Disimpan sampai hasil diketahui agar ulang kirim setelah jaringan putus tidak membuat akun ganda (AC F01-4).
  final String _idempotencyKey = _uuidV4();

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate() || !_agree) {
      setState(() => _serverError = _agree ? null : 'Setujui kebijakan privasi dan ketentuan untuk melanjutkan.');
      return;
    }
    setState(() {
      _busy = true;
      _serverError = null;
      _fieldErrors = const {};
    });
    try {
      final challenge = await ref.read(authApiProvider).register(
            RegisterInput(
              fullName: _name.text,
              gender: _gender!,
              email: _email.text,
              password: _password.text,
              cohort: _cohort!,
              classIn: _classIn!,
              classOut: _classOut!,
              policyVersion: policyVersion,
            ),
            idempotencyKey: _idempotencyKey,
          );
      await ref.read(sessionProvider.notifier).startRegistration(challenge);
      if (mounted) context.go('/register/otp');
    } on ApiException catch (e) {
      setState(() {
        _serverError = e.message;
        _fieldErrors = e.fieldErrors;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String? _fieldError(String key) => _fieldErrors[key]?.join(' ');

  @override
  Widget build(BuildContext context) {
    final pw = checkPassword(_password.text);
    final maxCohort = latestCohort(DateTime.now());
    final years = (_cohort != null && _classIn != null && _classOut != null && classesValid(_classIn!, _classOut!))
        ? academicYears(_cohort!, _classIn!, _classOut!)
        : null;

    return BrandSheet(
      child: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s5, KapdhSpace.s8),
          children: [
            Row(children: [
              IconButton(tooltip: 'Kembali', icon: const Icon(Icons.chevron_left), onPressed: () => context.go('/login')),
              Text('Daftar Alumni', style: Theme.of(context).textTheme.titleLarge),
            ]),
            const SizedBox(height: KapdhSpace.s3),
            const RegisterStepper(current: 0),
            const SizedBox(height: KapdhSpace.s6),
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: InputDecoration(labelText: 'Nama lengkap', errorText: _fieldError('full_name')),
              validator: (v) => (v ?? '').trim().length < 2 ? 'Isi nama lengkap' : null,
            ),
            const SizedBox(height: KapdhSpace.s4),
            DropdownButtonFormField<String>(
              initialValue: _gender,
              decoration: const InputDecoration(labelText: 'Jenis kelamin'),
              items: const [
                DropdownMenuItem(value: 'male', child: Text('Laki-laki')),
                DropdownMenuItem(value: 'female', child: Text('Perempuan')),
              ],
              onChanged: (v) => setState(() => _gender = v),
              validator: (v) => v == null ? 'Pilih jenis kelamin' : null,
            ),
            const SizedBox(height: KapdhSpace.s4),
            TextFormField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              decoration: InputDecoration(labelText: 'Email', errorText: _fieldError('email')),
              validator: (v) => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch((v ?? '').trim()) ? null : 'Masukkan email yang valid',
            ),
            const SizedBox(height: KapdhSpace.s4),
            TextFormField(
              controller: _password,
              obscureText: _obscure,
              autofillHints: const [AutofillHints.newPassword],
              decoration: InputDecoration(
                labelText: 'Password',
                errorText: _fieldError('password'),
                counterText: '${pw.bytes}/$passwordMaxBytes byte',
                suffixIcon: IconButton(
                  tooltip: _obscure ? 'Tampilkan password' : 'Sembunyikan password',
                  icon: Icon(_obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ),
              onChanged: (_) => setState(() {}),
              validator: (v) => checkPassword(v ?? '').valid ? null : 'Belum memenuhi aturan password',
            ),
            _PasswordRules(check: pw),
            const SizedBox(height: KapdhSpace.s4),
            DropdownButtonFormField<int>(
              initialValue: _cohort,
              decoration: const InputDecoration(labelText: 'Angkatan'),
              items: [for (var a = maxCohort; a >= 1; a--) DropdownMenuItem(value: a, child: Text('Angkatan $a (lulus ${cohortBaseYear + a})'))],
              onChanged: (v) => setState(() => _cohort = v),
              validator: (v) => v == null ? 'Pilih angkatan' : null,
            ),
            const SizedBox(height: KapdhSpace.s4),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: DropdownButtonFormField<int>(
                    initialValue: _classIn,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Kelas masuk'),
                    items: [for (var k = 1; k <= 6; k++) DropdownMenuItem(value: k, child: Text(classLabel(k)))],
                    onChanged: (v) => setState(() => _classIn = v),
                    validator: (v) => v == null ? 'Pilih kelas' : null,
                  ),
                ),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: DropdownButtonFormField<int>(
                    initialValue: _classOut,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Kelas keluar'),
                    items: [for (var k = 1; k <= 6; k++) DropdownMenuItem(value: k, child: Text(classLabel(k)))],
                    onChanged: (v) => setState(() => _classOut = v),
                    validator: (v) {
                      if (v == null) return 'Pilih kelas';
                      if (_classIn != null && v < _classIn!) return 'Tidak boleh sebelum kelas masuk';
                      return null;
                    },
                  ),
                ),
              ],
            ),
            if (years != null) ...[
              const SizedBox(height: KapdhSpace.s4),
              _AcademicYearsCard(years: years),
            ],
            const SizedBox(height: KapdhSpace.s4),
            CheckboxListTile(
              value: _agree,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              onChanged: (v) => setState(() => _agree = v ?? false),
              title: const Text('Saya menyetujui Kebijakan Privasi dan Ketentuan KAPDH'),
            ),
            if (_serverError != null)
              Padding(
                padding: const EdgeInsets.only(bottom: KapdhSpace.s3),
                child: Text(_serverError!, style: const TextStyle(color: KapdhColors.danger)),
              ),
            FilledButton(onPressed: _busy ? null : _submit, child: Text(_busy ? 'Mengirim...' : 'Lanjut verifikasi email')),
          ],
        ),
      ),
    );
  }
}

class _PasswordRules extends StatelessWidget {
  const _PasswordRules({required this.check});
  final PasswordCheck check;

  @override
  Widget build(BuildContext context) {
    Widget rule(bool ok, String label) => Row(children: [
          Icon(ok ? Icons.check_circle : Icons.radio_button_unchecked, size: 16, color: ok ? KapdhColors.success : KapdhColors.textMuted),
          const SizedBox(width: KapdhSpace.s2),
          Text(label, style: const TextStyle(fontSize: 12)),
        ]);
    return Padding(
      padding: const EdgeInsets.only(top: KapdhSpace.s2),
      child: Wrap(spacing: KapdhSpace.s4, runSpacing: KapdhSpace.s1, children: [
        rule(check.lengthOk, '8 sampai 72 byte'),
        rule(check.hasUpper, 'Huruf besar'),
        rule(check.hasLower, 'Huruf kecil'),
        rule(check.hasDigit, 'Angka'),
        rule(check.hasSymbol, 'Simbol'),
      ]),
    );
  }
}

class _AcademicYearsCard extends StatelessWidget {
  const _AcademicYearsCard({required this.years});
  final AcademicYears years;

  @override
  Widget build(BuildContext context) {
    Widget cell(int year, String label) => Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s3),
            decoration: BoxDecoration(color: KapdhColors.surface, borderRadius: BorderRadius.circular(KapdhRadius.md)),
            child: Column(children: [
              Text('$year', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: KapdhColors.primary)),
              Text(label, style: const TextStyle(fontSize: 11)),
            ]),
          ),
        );
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s3),
      decoration: BoxDecoration(gradient: KapdhGradients.buttonPrimary, borderRadius: BorderRadius.circular(KapdhRadius.lg)),
      child: Row(children: [
        cell(years.entryYear, 'Tahun Masuk'),
        const SizedBox(width: KapdhSpace.s2),
        cell(years.exitYear, 'Tahun Keluar'),
        const SizedBox(width: KapdhSpace.s2),
        cell(years.graduationYear, 'Tahun Lulus'),
      ]),
    );
  }
}

String _uuidV4() {
  final rnd = Random.secure();
  final b = List<int>.generate(16, (_) => rnd.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
