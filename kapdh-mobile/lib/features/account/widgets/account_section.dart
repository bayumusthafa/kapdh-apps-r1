import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_palette.dart';
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
              style: TextStyle(
                fontSize: KapdhFontSize.caption,
                fontWeight: FontWeight.w600,
                color: context.kc.textMuted,
                letterSpacing: 0.3,
              ),
            ),
          ),
        ),
        // [v2] Garis rambut cardBorder + --shadow-sm.
        DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(KapdhRadius.lg),
            boxShadow: context.kc.shadowSm,
          ),
          child: Material(
            color: context.kc.surface,
            shape: RoundedRectangleBorder(
              side: BorderSide(color: context.kc.cardBorder),
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
        ),
        if (footnote != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s1, KapdhSpace.s2, KapdhSpace.s1, 0),
            child: Text(
              footnote!,
              style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: context.kc.textMuted),
            ),
          ),
      ],
    );
  }
}

/// Kartu form berkepala (Ubah Profil v2: Profesi & Keahlian, Riwayat Pendidikan, Media Sosial): kartu permukaan
/// radius 16 bergaris rambut dan berbayangan, kepala ikon 24 primary + judul 17 w700 (+ deskripsi 12 abu), garis
/// pemisah, lalu isi padding 16.
class AccountFormCard extends StatelessWidget {
  const AccountFormCard({super.key, required this.icon, required this.title, required this.child, this.description});

  final IconData icon;
  final String title;
  final String? description;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    // Material (bukan Container berwarna) agar tinta InkWell/Ink di dalam kartu (cip, pemilih) tergambar DI ATAS
    // warna permukaan kartu: state layer tekan/hover dan sorotan fokus tetap terlihat (pola sama dengan AccountSection).
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(KapdhRadius.lg), boxShadow: p.shadowSm),
      child: Material(
        color: p.surface,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: p.cardBorder),
          borderRadius: BorderRadius.circular(KapdhRadius.lg),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(KapdhSpace.s4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(icon, size: KapdhIconSize.lg, color: p.primary),
                  const SizedBox(width: KapdhSpace.s3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Semantics(
                          header: true,
                          child: Text(
                            title,
                            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, height: 1.4),
                          ),
                        ),
                        if (description != null) ...[
                          const SizedBox(height: 2),
                          Text(
                            description!,
                            style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.45, color: p.textMuted),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: p.divider),
            Padding(padding: const EdgeInsets.all(KapdhSpace.s4), child: child),
          ],
        ),
      ),
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
    final color = danger ? context.kc.danger : context.kc.primary;
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
                Icon(icon, size: 22, color: muted ? context.kc.textMuted : color),
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
                          color: danger ? context.kc.danger : context.kc.text,
                        ),
                      ),
                      if (subtitle != null)
                        Text(
                          subtitle,
                          style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
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
                  color: context.kc.textMuted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
