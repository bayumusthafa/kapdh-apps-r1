import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/kapdh_icons.dart';

/// Kelompok menu/pengaturan Akun: judul bagian lalu kartu putih bergaris (gaya kartu prototipe layar 2, 4) dengan
/// pemisah antarbaris.
class AccountSection extends StatelessWidget {
  const AccountSection({super.key, required this.title, required this.children, this.footnote});

  final String title;
  final List<Widget> children;
  final String? footnote;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: KapdhSpace.s1, bottom: KapdhSpace.s2),
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: const TextStyle(
                fontSize: KapdhFontSize.caption,
                fontWeight: FontWeight.w600,
                color: KapdhColors.textMuted,
                letterSpacing: 0.3,
              ),
            ),
          ),
        ),
        Material(
          color: KapdhColors.surface,
          shape: RoundedRectangleBorder(
            side: const BorderSide(color: KapdhColors.divider),
            borderRadius: BorderRadius.circular(KapdhRadius.lg),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < children.length; i++) ...[
                if (i > 0) const Divider(height: 1, indent: KapdhSpace.s4, endIndent: KapdhSpace.s4),
                children[i],
              ],
            ],
          ),
        ),
        if (footnote != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s1, KapdhSpace.s2, KapdhSpace.s1, 0),
            child: Text(
              footnote!,
              style: const TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: KapdhColors.textMuted),
            ),
          ),
      ],
    );
  }
}

/// Satu baris menu Akun: ikon, label, keterangan opsional, lencana opsional dan panah. Target sentuh >= 48 px (N-11).
class AccountMenuTile extends StatelessWidget {
  const AccountMenuTile({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.subtitle,
    this.badge,
    this.danger = false,
    this.locked = false,
    this.paused = false,
  });

  final IconData icon;
  final String label;
  final String? subtitle;

  /// Mis. jumlah notifikasi belum dibaca.
  final String? badge;
  final bool danger;

  /// Belum tersedia untuk status akun saat ini; tetap terlihat dengan gembok dan penjelasan saat diketuk.
  final bool locked;

  /// Ditahan mode baca maintenance (PRD 4.5), bukan karena status akun: keterangan dan ikon pemeliharaan
  /// menggantikan gembok.
  final bool paused;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = danger ? KapdhColors.danger : KapdhColors.primary;
    final subtitle = paused ? 'Ditunda selama pemeliharaan' : this.subtitle;
    final muted = locked || paused;
    final semantics = [
      label,
      ?subtitle,
      if (badge != null) '$badge belum dibaca',
      if (locked && !paused) 'terkunci',
    ].join(', ');
    return Semantics(
      button: true,
      label: semantics,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
            child: Row(
              children: [
                Icon(icon, size: 22, color: muted ? KapdhColors.textMuted : color),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        label,
                        style: TextStyle(
                          fontSize: KapdhFontSize.body,
                          fontWeight: FontWeight.w500,
                          color: danger ? KapdhColors.danger : KapdhColors.text,
                        ),
                      ),
                      if (subtitle != null)
                        Text(
                          subtitle,
                          style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                        ),
                    ],
                  ),
                ),
                if (badge != null)
                  Container(
                    margin: const EdgeInsets.only(left: KapdhSpace.s2),
                    padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: 2),
                    decoration: BoxDecoration(
                      color: KapdhColors.accent,
                      borderRadius: BorderRadius.circular(KapdhRadius.pill),
                    ),
                    child: Text(
                      badge!,
                      style: const TextStyle(
                        fontSize: KapdhFontSize.caption,
                        fontWeight: FontWeight.w600,
                        color: KapdhColors.onAccent,
                      ),
                    ),
                  ),
                const SizedBox(width: KapdhSpace.s2),
                Icon(
                  paused
                      ? KapdhIcons.buildOutlined
                      : locked
                      ? KapdhIcons.lockOutline
                      : KapdhIcons.chevronRight,
                  size: 20,
                  color: KapdhColors.textMuted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
