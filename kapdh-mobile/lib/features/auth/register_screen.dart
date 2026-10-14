import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/repositories.dart';
import '../../core/session/session_controller.dart';
import '../../core/validation/password.dart';
import '../../design/design.dart';
import '../membership/academic.dart';
import 'auth_flow.dart';
import 'auth_widgets.dart';
import 'registration_draft.dart';

/// Versi persetujuan pendaftaran (F-01, kontrak C4 `LegalConsentVersions`): `consent` dari GET /public/pages.
/// `policy_version` adalah gabungan kanonis `privacy:<v>;terms:<v>` yang disusun server dan dikirim apa adanya
/// sebagai `accept_policy_version`; klien tidak pernah menyusunnya sendiri (kontrak C1 register). Null berarti
/// Kebijakan Privasi atau Ketentuan belum pernah terbit sehingga pendaftaran belum dibuka (PRD 8.2).
final consentVersionsProvider = FutureProvider.autoDispose<LegalConsentVersions>(
  (ref) => ref.watch(publicRepositoryProvider).getConsentVersions(),
  retry: (retryCount, error) => null,
);

/// Pesan bila dokumen legal belum terbit (`policy_version` null).
const String registrationClosedMessage =
    'Pendaftaran belum dibuka karena Kebijakan Privasi atau Ketentuan belum diterbitkan pengurus. Coba lagi nanti.';

/// Pesan bila versi dokumen legal berubah setelah pengguna menyetujuinya (F-01).
const String policyChangedMessage =
    'Kebijakan Privasi atau Ketentuan baru saja diperbarui. Baca ulang lalu setujui kembali.';

/// Langkah 1 pendaftaran: Data Diri (F-01, AC F01-1, F01-4; guideline hal. 5). Tanpa Nomor KTP (v3.3).
///
/// Tahun masuk/keluar/lulus hanya pratinjau rumus server (PRD 3.5); nomor anggota dihitung server saat OTP
/// terverifikasi. Idempotency-Key disimpan (secure storage) sampai hasil diketahui sehingga kirim ulang setelah
/// jaringan putus atau aplikasi dimulai ulang memakai key yang sama dan tidak membuat akun ganda; payload berubah
/// membuat key baru (PRD 4.3, AC F01-4).
///
/// Persetujuan terikat versi yang ditampilkan: centang berlaku untuk `policy_version` saat dicentang. Bila versi
/// terbit di /public/config (`legal`) berubah, versi persetujuan dimuat ulang dan centang dilepas sehingga pengguna
/// menyetujui teks terbaru sebelum mengirim (F-01, N-15).
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _email;
  final _password = TextEditingController();
  Gender? _gender;
  int? _cohort;
  int? _classIn;
  int? _classOut;

  /// `policy_version` yang disetujui pengguna (centang); null bila belum menyetujui.
  String? _agreedTo;
  bool _busy = false;
  String? _error;
  String? _consentError;
  Map<String, List<String>> _fieldErrors = const {};
  DateTime? _blockedUntil;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    final draft = ref.read(registrationDraftProvider);
    _name = TextEditingController(text: draft?.fullName ?? '');
    _email = TextEditingController(text: draft?.email ?? '');
    _gender = draft?.gender;
    _cohort = draft?.cohort;
    _classIn = draft?.classIn;
    _classOut = draft?.classOut;
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _name.dispose();
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

  void _saveDraft() {
    ref
        .read(registrationDraftProvider.notifier)
        .save(
          RegistrationDraft(
            fullName: _name.text,
            gender: _gender,
            email: _email.text,
            cohort: _cohort,
            classIn: _classIn,
            classOut: _classOut,
          ),
        );
  }

  /// Versi persetujuan terkini yang sudah dimuat; null bila belum dimuat atau pendaftaran belum dibuka.
  String? get _currentPolicy => ref.read(consentVersionsProvider).value?.policyVersion;

  bool get _agreed => _agreedTo != null && _agreedTo == _currentPolicy;

  Future<void> _submit() async {
    final formValid = _form.currentState?.validate() ?? false;
    final consent = ref.read(consentVersionsProvider);
    if (consent.hasValue && consent.value!.policyVersion == null) {
      setState(() => _error = registrationClosedMessage);
      return;
    }
    setState(() => _consentError = _agreed ? null : 'Setujui Kebijakan Privasi dan Ketentuan untuk melanjutkan.');
    if (!consent.hasValue) {
      setState(() => _error = 'Kebijakan privasi belum dimuat. Periksa koneksi lalu coba lagi.');
      return;
    }
    if (!formValid || !_agreed || _busy || _blockedFor > Duration.zero) return;
    final policy = _agreedTo!;
    _saveDraft();
    final body = RegisterRequest(
      fullName: _name.text.trim(),
      gender: _gender!,
      email: _email.text.trim(),
      password: _password.text,
      cohort: _cohort!,
      classIn: _classIn!,
      classOut: _classOut!,
      acceptPolicyVersion: policy,
    );
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
      _fieldErrors = const {};
    });
    try {
      final challenge = await ref
          .read(idempotencyStoreProvider)
          .run(
            'auth.register',
            body.toJson(),
            (key) => ref.read(authRepositoryProvider).register(body, idempotencyKey: key),
          );
      ref.read(registrationDraftProvider.notifier).markSubmitted();
      ref.read(sessionProvider.notifier).setChallenge(challenge);
      // Hanya di memori: pemulihan bila jawaban verifikasi OTP hilang (kontrak C1 verifyOtp, AC F01-4).
      ref.read(activationCredentialsProvider.notifier).remember(email: body.email, password: body.password);
      ref.read(authEmailHintProvider.notifier).set(body.email);
      if (mounted) context.go(AppRoutes.registerOtp);
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.versionConflict) {
        // 409 VERSION_CONFLICT (kontrak C1 register): Kebijakan Privasi atau Ketentuan baru diterbitkan setelah
        // layar dibuka. Muat ulang versinya dan minta persetujuan ulang atas teks terbaru (F-01).
        ref.invalidate(consentVersionsProvider);
        setState(() {
          _agreedTo = null;
          _fieldErrors = const {};
          _error = policyChangedMessage;
        });
        return;
      }
      setState(() {
        _fieldErrors = error.fieldErrors;
        final general = error.fieldErrors['_']?.join(' ');
        _error = error.fieldErrors.isEmpty ? error.message : general;
        final wait = error.retryAfter;
        if (error.ui.action == ErrorUiAction.showCountdown && wait != null) {
          _blockedUntil = _now().add(wait);
          _ticker?.cancel();
          _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
            if (!mounted) return;
            setState(() {});
            if (_blockedFor == Duration.zero) timer.cancel();
          });
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String? _fieldError(String key) => _fieldErrors[key]?.join(' ');

  /// Versi persetujuan dimuat ulang (409, atau versi terbit di /public/config berubah): persetujuan atas versi lama
  /// tidak berlaku lagi (F-01).
  void _onConsentChanged(LegalConsentVersions? next) {
    final agreed = _agreedTo;
    if (next == null || agreed == null || agreed == next.policyVersion) return;
    setState(() {
      _agreedTo = null;
      _error = policyChangedMessage;
    });
  }

  /// Versi terbit di /public/config (`legal`, dibaca ulang gerbang aplikasi saat aplikasi kembali aktif) berbeda
  /// dengan versi persetujuan yang tampil: muat ulang `consent` dari GET /public/pages.
  void _onPublishedLegalChanged(LegalVersions? published) {
    final shown = ref.read(consentVersionsProvider).value;
    if (published == null || shown == null) return;
    if (published.privacyVersion != shown.privacyVersion || published.termsVersion != shown.termsVersion) {
      ref.invalidate(consentVersionsProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref
      ..listen(consentVersionsProvider, (_, next) => _onConsentChanged(next.value))
      ..listen(appGateProvider.select((gate) => gate.config?.legal), (_, next) => _onPublishedLegalChanged(next));
    final check = checkPassword(_password.text);
    final counter = passwordCounter(check);
    final consent = ref.watch(consentVersionsProvider);
    final maxCohort = latestCohort(_now().toUtc());
    final years = (_cohort != null && _classIn != null && _classOut != null && classesValid(_classIn!, _classOut!))
        ? academicYears(_cohort!, _classIn!, _classOut!)
        : null;
    final blocked = _blockedFor;
    final classItems = [for (var k = 1; k <= 6; k++) DropdownMenuItem(value: k, child: Text(classLabel(k)))];

    return BrandSheetScaffold(
      body: Form(
        key: _form,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AuthSheetTitle(title: 'Daftar Alumni', onBack: () => context.go(AppRoutes.login)),
              const SizedBox(height: KapdhSpace.s4),
              const RegisterStepper(current: 0),
              const SizedBox(height: KapdhSpace.s6),
              KapdhTextField(
                key: const ValueKey('register-name'),
                label: 'Nama Lengkap',
                controller: _name,
                hint: 'Masukkan nama lengkap',
                prefixIcon: Icons.person_outline,
                textCapitalization: TextCapitalization.words,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.name],
                errorText: _fieldError('full_name'),
                validator: (v) => (v ?? '').trim().length < 2 ? 'Isi nama lengkap' : null,
              ),
              const SizedBox(height: KapdhSpace.s4),
              KapdhDropdownField<Gender>(
                key: const ValueKey('register-gender'),
                label: 'Jenis Kelamin',
                hint: 'Pilih Jenis Kelamin',
                value: _gender,
                errorText: _fieldError('gender'),
                items: const [
                  DropdownMenuItem(value: Gender.male, child: Text('Laki-laki')),
                  DropdownMenuItem(value: Gender.female, child: Text('Perempuan')),
                ],
                onChanged: (v) => setState(() => _gender = v),
                validator: (v) => v == null ? 'Pilih jenis kelamin' : null,
              ),
              const SizedBox(height: KapdhSpace.s4),
              KapdhTextField(
                key: const ValueKey('register-email'),
                label: 'Email',
                controller: _email,
                hint: 'Masukkan email',
                prefixIcon: Icons.mail_outline,
                keyboardType: TextInputType.emailAddress,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.email],
                errorText: _fieldError('email'),
                validator: (v) => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch((v ?? '').trim())
                    ? null
                    : 'Masukkan email yang valid',
              ),
              const SizedBox(height: KapdhSpace.s4),
              KapdhTextField(
                key: const ValueKey('register-password'),
                label: 'Password',
                controller: _password,
                hint: 'Masukkan password',
                obscurable: true,
                autofillHints: const [AutofillHints.newPassword],
                // Kemajuan menuju minimum 8 byte, merah selama belum terpenuhi (guideline hal. 5 "0/8").
                trailingText: counter.text,
                trailingTextColor: counter.problem ? KapdhColors.danger : KapdhColors.textMuted,
                errorText: _fieldError('password'),
                onChanged: (_) => setState(() {}),
                validator: (v) => checkPassword(v ?? '').valid ? null : 'Belum memenuhi aturan password',
              ),
              PasswordRules(check: check),
              const SizedBox(height: KapdhSpace.s4),
              KapdhDropdownField<int>(
                key: const ValueKey('register-cohort'),
                label: 'Angkatan',
                hint: 'Pilih angkatan',
                value: _cohort,
                errorText: _fieldError('cohort'),
                items: [
                  for (var a = maxCohort; a >= 1; a--)
                    DropdownMenuItem(value: a, child: Text('Angkatan $a (lulus ${cohortBaseYear + a})')),
                ],
                onChanged: (v) => setState(() => _cohort = v),
                validator: (v) => v == null ? 'Pilih angkatan' : null,
              ),
              const SizedBox(height: KapdhSpace.s4),
              _ClassFields(
                classIn: KapdhDropdownField<int>(
                  key: const ValueKey('register-class-in'),
                  label: 'Kelas Masuk',
                  hint: 'Pilih kelas',
                  value: _classIn,
                  errorText: _fieldError('class_in'),
                  items: classItems,
                  onChanged: (v) => setState(() => _classIn = v),
                  validator: (v) => v == null ? 'Pilih kelas' : null,
                ),
                classOut: KapdhDropdownField<int>(
                  key: const ValueKey('register-class-out'),
                  label: 'Kelas Keluar',
                  hint: 'Pilih kelas',
                  value: _classOut,
                  errorText: _fieldError('class_out'),
                  items: classItems,
                  onChanged: (v) => setState(() => _classOut = v),
                  validator: (v) {
                    if (v == null) return 'Pilih kelas';
                    if (_classIn != null && v < _classIn!) return 'Tidak boleh sebelum kelas masuk';
                    return null;
                  },
                ),
              ),
              if (years != null) ...[const SizedBox(height: KapdhSpace.s4), _AcademicYearsCard(years: years)],
              const SizedBox(height: KapdhSpace.s4),
              _ConsentField(
                value: _agreed,
                errorText: _consentError ?? _fieldError('accept_policy_version'),
                consent: consent,
                onChanged: (v) => setState(() {
                  _agreedTo = v ? _currentPolicy : null;
                  if (v) {
                    _consentError = null;
                    if (_error == policyChangedMessage) _error = null;
                  }
                }),
                onRetryPolicy: () => ref.invalidate(consentVersionsProvider),
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
                key: const ValueKey('register-submit'),
                label: blocked > Duration.zero
                    ? 'Coba lagi dalam ${formatCountdown(blocked)}'
                    : 'Lanjut verifikasi email',
                busyLabel: 'Mengirim...',
                busy: _busy,
                onPressed: blocked > Duration.zero ? null : _submit,
              ),
              const SizedBox(height: KapdhSpace.s3),
              Wrap(
                alignment: WrapAlignment.center,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  const Text('Sudah punya akun?', style: TextStyle(fontSize: 13, color: KapdhColors.primary)),
                  KapdhLinkButton(label: 'Masuk', onPressed: () => context.go(AppRoutes.login)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Kelas masuk dan keluar berdampingan; bertumpuk saat teks diperbesar (N-11).
class _ClassFields extends StatelessWidget {
  const _ClassFields({required this.classIn, required this.classOut});

  final Widget classIn;
  final Widget classOut;

  @override
  Widget build(BuildContext context) {
    final large = MediaQuery.textScalerOf(context).scale(KapdhFontSize.body) > KapdhFontSize.body * 1.3;
    if (large) {
      return Column(
        children: [
          classIn,
          const SizedBox(height: KapdhSpace.s4),
          classOut,
        ],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: classIn),
        const SizedBox(width: KapdhSpace.s3),
        Expanded(child: classOut),
      ],
    );
  }
}

/// "Perhitungan Tahun Akademik" (guideline hal. 5): pratinjau rumus server (PRD 3.5).
class _AcademicYearsCard extends StatelessWidget {
  const _AcademicYearsCard({required this.years});

  final AcademicYears years;

  @override
  Widget build(BuildContext context) {
    Widget cell(int year, String label) => Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s3, horizontal: KapdhSpace.s1),
        decoration: BoxDecoration(color: KapdhColors.surface, borderRadius: BorderRadius.circular(KapdhRadius.md)),
        child: Column(
          children: [
            Text(
              '$year',
              style: const TextStyle(
                fontSize: KapdhFontSize.h3,
                fontWeight: FontWeight.w600,
                color: KapdhColors.primary,
              ),
            ),
            Text(
              label,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: KapdhFontSize.overline),
            ),
          ],
        ),
      ),
    );
    return Semantics(
      label:
          'Perhitungan tahun akademik: tahun masuk ${years.entryYear}, tahun keluar ${years.exitYear}, '
          'tahun lulus ${years.graduationYear}',
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Perhitungan Tahun Akademik',
            style: TextStyle(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: KapdhSpace.s2),
          Container(
            padding: const EdgeInsets.all(KapdhSpace.s3),
            decoration: BoxDecoration(
              gradient: KapdhGradients.buttonPrimary,
              borderRadius: BorderRadius.circular(KapdhRadius.lg),
            ),
            child: Row(
              children: [
                cell(years.entryYear, 'Tahun Masuk'),
                const SizedBox(width: KapdhSpace.s2),
                cell(years.exitYear, 'Tahun Keluar'),
                const SizedBox(width: KapdhSpace.s2),
                cell(years.graduationYear, 'Tahun Lulus'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Persetujuan Kebijakan Privasi dan Ketentuan beserta tautan bacaannya dan versi yang disetujui (F-01, N-15:
/// penggunaan dan retensi data dijelaskan sebelum pengguna setuju). Centang hanya aktif setelah versi persetujuan
/// dimuat, sehingga persetujuan selalu terikat versi yang sedang terbit.
class _ConsentField extends StatelessWidget {
  const _ConsentField({
    required this.value,
    required this.onChanged,
    required this.consent,
    required this.onRetryPolicy,
    this.errorText,
  });

  final bool value;
  final ValueChanged<bool> onChanged;

  /// `consent` GET /public/pages; `policy_version` null berarti pendaftaran belum dibuka.
  final AsyncValue<LegalConsentVersions> consent;
  final VoidCallback onRetryPolicy;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final versions = consent.isLoading ? null : consent.value;
    final open = versions?.policyVersion != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        CheckboxListTile(
          key: const ValueKey('register-consent'),
          value: value,
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          onChanged: open ? (v) => onChanged(v ?? false) : null,
          title: const Text(
            'Saya telah membaca dan menyetujui Kebijakan Privasi serta Ketentuan KAPDH',
            style: TextStyle(fontSize: 13),
          ),
        ),
        Wrap(
          spacing: KapdhSpace.s2,
          children: [
            KapdhLinkButton(
              key: const ValueKey('register-read-privacy'),
              label: 'Baca Kebijakan Privasi',
              onPressed: () => context.push(AppRoutes.legal(AppRoutes.privacySlug)),
            ),
            KapdhLinkButton(
              key: const ValueKey('register-read-terms'),
              label: 'Baca Ketentuan',
              onPressed: () => context.push(AppRoutes.legal(AppRoutes.termsSlug)),
            ),
          ],
        ),
        // Sebelum dicentang hanya versi yang berlaku; "disetujui" baru setelah pengguna menyetujuinya (F-01).
        if (open)
          Padding(
            padding: const EdgeInsets.only(bottom: KapdhSpace.s1),
            child: Text(
              '${value ? 'Versi yang disetujui' : 'Versi berlaku'}: Kebijakan Privasi versi '
              '${versions!.privacyVersion} · Ketentuan versi ${versions.termsVersion}',
              style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
            ),
          ),
        if (consent.hasError && !consent.isLoading)
          InfoBox(
            tone: InfoBoxTone.warning,
            message: 'Versi kebijakan belum dapat dimuat. Periksa koneksi Anda.',
            trailing: TextButton(onPressed: onRetryPolicy, child: const Text('Coba lagi')),
          )
        else if (versions != null && !open)
          InfoBox(
            tone: InfoBoxTone.warning,
            message: registrationClosedMessage,
            trailing: TextButton(onPressed: onRetryPolicy, child: const Text('Coba lagi')),
          ),
        if (errorText != null)
          Padding(
            padding: const EdgeInsets.only(top: KapdhSpace.s1),
            child: Text(
              errorText!,
              style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.danger),
            ),
          ),
      ],
    );
  }
}
