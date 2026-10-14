import 'package:flutter/material.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/format/formatters.dart';

/// Avatar alumni bulat (guideline hal. 7): foto dari URL bertanda tangan (maksimal 10 menit, PRD 5.4) atau inisial
/// nama di atas hijau muda. Foto yang gagal dimuat (URL kedaluwarsa, offline) jatuh ke inisial tanpa galat.
class AlumniAvatar extends StatelessWidget {
  const AlumniAvatar({super.key, required this.name, this.url, this.size = 48, this.icon});

  final String name;
  final String? url;
  final double size;

  /// Ikon pengganti inisial (mis. grup tanpa avatar).
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final fallback = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: const BoxDecoration(shape: BoxShape.circle, color: KapdhColors.green100),
      child: icon != null
          ? Icon(icon, size: size * 0.5, color: KapdhColors.primary)
          : Text(
              initialsOf(name),
              maxLines: 1,
              style: TextStyle(fontSize: size * 0.36, fontWeight: FontWeight.w600, color: KapdhColors.primary),
            ),
    );
    final source = url;
    return ExcludeSemantics(
      child: source == null || source.isEmpty
          ? fallback
          : ClipOval(
              child: Image.network(
                source,
                width: size,
                height: size,
                fit: BoxFit.cover,
                gaplessPlayback: true,
                errorBuilder: (_, _, _) => fallback,
                frameBuilder: (_, child, frame, wasSynchronouslyLoaded) =>
                    frame == null && !wasSynchronouslyLoaded ? fallback : child,
              ),
            ),
    );
  }
}
