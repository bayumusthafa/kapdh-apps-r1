import 'package:flutter/material.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';
import 'status_badge.dart';

/// Kepala status di tengah layar (prototipe layar 4 "Menunggu Verifikasi", layar 5 "Perlu Perbaikan"): lingkaran
/// ikon 72 px, badge, judul dan keterangan. Warna mengikuti [status]; label badge selalu tampil (PRD 4.5).
class StatusHero extends StatelessWidget {
  const StatusHero({
    super.key,
    required this.status,
    required this.title,
    this.message,
    this.icon,
    this.showBadge = true,
  });

  final StatusBadgeStyle status;
  final String title;
  final String? message;

  /// Ikon lingkaran; bawaan ikon status.
  final IconData? icon;
  final bool showBadge;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: KapdhSpace.s1),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExcludeSemantics(
            child: Container(
              width: KapdhComponentSize.heroIcon,
              height: KapdhComponentSize.heroIcon,
              decoration: BoxDecoration(color: context.kc.resolve(status.background), shape: BoxShape.circle),
              child: Icon(icon ?? status.icon, size: 34, color: context.kc.resolve(status.foreground)),
            ),
          ),
          if (showBadge) ...[const SizedBox(height: KapdhSpace.s3), StatusBadge(status)],
          const SizedBox(height: KapdhSpace.s3),
          Semantics(
            header: true,
            child: Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w700, height: 1.3),
            ),
          ),
          if (message != null) ...[
            const SizedBox(height: KapdhSpace.s3),
            Text(
              message!,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 1.55, color: context.kc.textMuted),
            ),
          ],
        ],
      ),
    );
  }
}
