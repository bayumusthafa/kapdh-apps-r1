import 'package:flutter/material.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/validation/password.dart';
import '../../design/design.dart';

/// Baris judul di dalam lembar: tombol kembali + judul (prototipe layar 1 sampai 3).
class AuthSheetTitle extends StatelessWidget {
  const AuthSheetTitle({super.key, required this.title, required this.onBack});

  final String title;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        IconButton(tooltip: 'Kembali', icon: const Icon(Icons.chevron_left, size: 28), onPressed: onBack),
        const SizedBox(width: KapdhSpace.s1),
        Expanded(
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ],
    );
  }
}

/// Stepper pemulihan password (F-02): Email, Kode OTP, Password Baru; gaya sama dengan stepper pendaftaran
/// (prototipe layar 1).
class RecoveryStepper extends StatelessWidget {
  const RecoveryStepper({super.key, required this.current});

  static const steps = [
    KapdhStep('Email', Icons.mail_outline),
    KapdhStep('Kode OTP', Icons.shield_outlined),
    KapdhStep('Password Baru', Icons.lock_outline),
  ];

  /// 0 Email, 1 Kode OTP, 2 Password Baru.
  final int current;

  @override
  Widget build(BuildContext context) => KapdhStepper(steps: steps, current: current);
}

/// Daftar aturan sandi PRD 2.5 dengan status terpenuhi per aturan; panjang dihitung dalam byte UTF-8, bukan
/// karakter, dan ditolak (bukan dipotong) bila lebih dari 72 byte.
class PasswordRules extends StatelessWidget {
  const PasswordRules({super.key, required this.check});

  final PasswordCheck check;

  @override
  Widget build(BuildContext context) {
    // Ikon sebagai WidgetSpan agar label membungkus saat teks diperbesar 200 % (N-11).
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

/// Validasi email lokal sebelum dikirim; server tetap menormalkan dan memvalidasi (PRD 3.1).
bool looksLikeEmail(String value) => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(value.trim());

/// Hasil atau keadaan akhir alur auth: ikon berlabel, judul, pesan dan tindakan (status tidak dibedakan warna saja,
/// PRD 4.5). Dipakai layar Password Baru dan layar tautan pemulihan.
class AuthResultPanel extends StatelessWidget {
  const AuthResultPanel({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.message,
    required this.actions,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String message;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(icon, size: 64, color: iconColor),
          const SizedBox(height: KapdhSpace.s4),
          Semantics(
            header: true,
            child: Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: KapdhSpace.s2),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
          ),
          const SizedBox(height: KapdhSpace.s6),
          for (final (index, action) in actions.indexed) ...[
            if (index > 0) const SizedBox(height: KapdhSpace.s2),
            action,
          ],
        ],
      ),
    );
  }
}
