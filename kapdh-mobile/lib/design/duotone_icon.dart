import 'package:flutter/widgets.dart';

/// Ikon dua lapis Phosphor duotone: [secondary] (bidang) digambar di bawah dengan opasitas rendah, [primary] (garis)
/// di atasnya. Keduanya glyph font `PhosphorDuotone` (ADR-027).
@immutable
final class DuotoneIconData {
  const DuotoneIconData(this.primary, this.secondary);

  final IconData primary;
  final IconData secondary;
}

/// Menggambar [DuotoneIconData] dengan satu warna: lapisan kedua [secondaryOpacity] dari [color] (bawaan 20 %, sama
/// dengan Phosphor).
class DuotoneIcon extends StatelessWidget {
  const DuotoneIcon(this.icon, {super.key, this.size, this.color, this.secondaryOpacity = 0.2, this.semanticLabel});

  final DuotoneIconData icon;
  final double? size;
  final Color? color;
  final double secondaryOpacity;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final resolved = color ?? IconTheme.of(context).color;
    return Semantics(
      label: semanticLabel,
      excludeSemantics: true,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Icon(
            icon.secondary,
            size: size,
            color: resolved?.withValues(alpha: (resolved.a * secondaryOpacity)),
          ),
          Icon(icon.primary, size: size, color: resolved),
        ],
      ),
    );
  }
}
