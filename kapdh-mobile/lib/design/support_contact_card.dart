import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';

/// Kanal dukungan pengurus (PRD 4.5 maintenance/wajib update, 2.2 portal pembatasan; PRD 8.3). Bila kontak belum
/// dimuat (offline), alamat email bawaan ditampilkan.
class SupportContactCard extends StatelessWidget {
  const SupportContactCard({
    super.key,
    this.email,
    this.whatsapp,
    required this.onEmail,
    this.onWhatsApp,
    this.title = 'Butuh bantuan?',
  });

  /// Email bantuan bawaan bila konfigurasi publik belum tersedia (seed `support.email`).
  static const fallbackEmail = 'bantuan@kapdh.or.id';

  final String? email;
  final String? whatsapp;
  final ValueChanged<String> onEmail;
  final ValueChanged<String>? onWhatsApp;
  final String title;

  @override
  Widget build(BuildContext context) {
    final mail = (email == null || email!.isEmpty) ? fallbackEmail : email!;
    final wa = whatsapp;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              title,
              style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: KapdhSpace.s1),
          _ContactRow(icon: Icons.mail_outline, label: 'Email pengurus', value: mail, onTap: () => onEmail(mail)),
          if (wa != null && wa.isNotEmpty && onWhatsApp != null)
            _ContactRow(icon: Icons.chat_outlined, label: 'WhatsApp pengurus', value: wa, onTap: () => onWhatsApp!(wa)),
        ],
      ),
    );
  }
}

class _ContactRow extends StatelessWidget {
  const _ContactRow({required this.icon, required this.label, required this.value, required this.onTap});

  final IconData icon;
  final String label;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: '$label, $value',
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
          child: Row(
            children: [
              Icon(icon, size: 20, color: KapdhColors.primary),
              const SizedBox(width: KapdhSpace.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                    ),
                    Text(
                      value,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: KapdhColors.primary),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.open_in_new, size: 18, color: KapdhColors.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}
