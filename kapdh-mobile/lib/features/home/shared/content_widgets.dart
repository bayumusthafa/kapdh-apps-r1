import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_tokens.dart';

/// Chip kategori hijau muda (guideline hal. 8 "Reuni", "Workshop").
class CategoryChip extends StatelessWidget {
  const CategoryChip(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Kategori $label',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: 2),
        decoration: BoxDecoration(color: KapdhColors.green100, borderRadius: BorderRadius.circular(KapdhRadius.sm)),
        child: Text(
          label,
          style: const TextStyle(
            fontSize: KapdhFontSize.overline,
            fontWeight: FontWeight.w600,
            color: KapdhColors.primary,
          ),
        ),
      ),
    );
  }
}

/// Baris ikon kecil + teks (tanggal, lokasi, kuota) pada kartu dan detail.
class IconLine extends StatelessWidget {
  const IconLine({
    super.key,
    required this.icon,
    required this.text,
    this.color = KapdhColors.textMuted,
    this.size = 12,
  });

  final IconData icon;
  final String text;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: ExcludeSemantics(
            child: Icon(icon, size: size + 2, color: color),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            style: TextStyle(fontSize: size, color: color, height: 1.35),
          ),
        ),
      ],
    );
  }
}

/// Kartu putih bergaris tipis yang dapat diketuk (daftar event, berita, tiket).
class TappableCard extends StatelessWidget {
  const TappableCard({super.key, required this.child, this.onTap, this.semanticsLabel, this.padding});

  final Widget child;
  final VoidCallback? onTap;

  /// Label tunggal untuk pembaca layar (isi kartu digabung menjadi satu tombol, N-11).
  final String? semanticsLabel;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(KapdhRadius.lg);
    final card = Material(
      color: KapdhColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: radius,
        side: const BorderSide(color: KapdhColors.divider),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: padding ?? const EdgeInsets.all(KapdhSpace.s3), child: child),
      ),
    );
    if (semanticsLabel == null) return card;
    return Semantics(button: onTap != null, label: semanticsLabel, excludeSemantics: true, onTap: onTap, child: card);
  }
}

/// Judul bagian dengan tautan "Lihat semua" (Beranda).
class HomeSectionTitle extends StatelessWidget {
  const HomeSectionTitle({super.key, required this.title, this.actionLabel = 'Lihat semua', this.onAction});

  final String title;
  final String actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: const TextStyle(fontSize: KapdhFontSize.bodyLg, fontWeight: FontWeight.w600),
            ),
          ),
        ),
        if (onAction != null)
          TextButton(
            onPressed: onAction,
            style: TextButton.styleFrom(minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin)),
            child: Text(actionLabel),
          ),
      ],
    );
  }
}
