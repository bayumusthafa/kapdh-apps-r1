import 'package:flutter/material.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import 'kapdh_icons.dart';

enum InfoBoxTone { info, warning, danger }

/// Kotak informasi (prototipe layar 7 aturan offline 7 hari; layar 1 baris "Tidak menerima kode?" memakai latar
/// yang sama). Nada [InfoBoxTone.info] hijau muda, peringatan kuning, bahaya merah muda; ikon selalu menyertai teks.
class InfoBox extends StatelessWidget {
  const InfoBox({
    super.key,
    required this.message,
    this.title,
    this.tone = InfoBoxTone.info,
    this.icon,
    this.trailing,
    this.centerTrailing = false,
  });

  final String message;
  final String? title;
  final InfoBoxTone tone;
  final IconData? icon;
  final Widget? trailing;

  /// [v2] Tombol [trailing] ditengahkan vertikal terhadap kotak (mockup `.home-list .info-box--warning >
  /// .info-box__trailing { align-self: center }`), sementara ikon dan teks tetap rata atas. Bawaan `false` mengikuti
  /// `components.css` `.info-box__trailing { align-self: flex-start }`. Tidak berlaku saat mode bertumpuk (teks > 1,3).
  final bool centerTrailing;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    final (Color bg, Color fg, IconData defaultIcon) = switch (tone) {
      InfoBoxTone.info => (p.tint, p.primary, KapdhIcons.infoOutline),
      InfoBoxTone.warning => (p.warningBg, p.warning, KapdhIcons.warningAmberRounded),
      InfoBoxTone.danger => (p.dangerBg, p.danger, KapdhIcons.errorOutline),
    };
    // Teks diperbesar (N-11): tombol aksi pindah ke bawah pesan, rata kanan, agar pesan tidak terhimpit.
    final stacked = trailing != null && MediaQuery.textScalerOf(context).scale(13) > 13 * 1.3;
    final leading = <Widget>[
      Padding(
        padding: const EdgeInsets.only(top: 1),
        child: Icon(icon ?? defaultIcon, size: KapdhIconSize.button, color: fg),
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
              style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: p.text),
            ),
          ],
        ),
      ),
    ];
    final Widget top = trailing != null && !stacked && centerTrailing
        // Ikon dan teks rata atas di dalam Expanded; hanya tombol yang ditengahkan terhadap tinggi kotak.
        ? Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: leading),
              ),
              const SizedBox(width: KapdhSpace.s2),
              trailing!,
            ],
          )
        : Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ...leading,
              if (trailing != null && !stacked) ...[const SizedBox(width: KapdhSpace.s2), trailing!],
            ],
          );
    return Container(
      width: double.infinity,
      // [v2] Garis 1 px bernada 20 % (ukuran luar tetap: padding dikurangi 1).
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(KapdhRadius.md),
        border: Border.all(color: fg.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          top,
          if (stacked) ...[
            const SizedBox(height: KapdhSpace.s2),
            Align(alignment: Alignment.centerRight, child: trailing!),
          ],
        ],
      ),
    );
  }
}
