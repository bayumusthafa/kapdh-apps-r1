import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';

enum InfoBoxTone { info, warning, danger }

/// Kotak informasi (prototipe layar 7 aturan offline 7 hari; layar 1 baris "Tidak menerima kode?" memakai latar
/// yang sama). Nada [InfoBoxTone.info] hijau muda, peringatan kuning, bahaya merah muda; ikon selalu menyertai teks.
class InfoBox extends StatelessWidget {
  const InfoBox({super.key, required this.message, this.title, this.tone = InfoBoxTone.info, this.icon, this.trailing});

  final String message;
  final String? title;
  final InfoBoxTone tone;
  final IconData? icon;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg, IconData defaultIcon) = switch (tone) {
      InfoBoxTone.info => (KapdhColors.green50, KapdhColors.primary, Icons.info_outline),
      InfoBoxTone.warning => (KapdhColors.warningBg, KapdhColors.warning, Icons.warning_amber_rounded),
      InfoBoxTone.danger => (KapdhColors.dangerBg, KapdhColors.danger, Icons.error_outline),
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: KapdhSpace.s3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon ?? defaultIcon, size: 18, color: fg),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (title != null)
                  Text(
                    title!,
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: fg),
                  ),
                Text(
                  message,
                  style: const TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: KapdhColors.text),
                ),
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: KapdhSpace.s2), trailing!],
        ],
      ),
    );
  }
}
