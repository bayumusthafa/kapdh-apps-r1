import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_focus.dart';
import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';

/// Chip kategori hijau muda (guideline hal. 8 "Reuni", "Workshop").
class CategoryChip extends StatelessWidget {
  const CategoryChip(this.label, {super.key, this.onImage = false});

  final String label;

  /// Di atas gambar berscrim (kartu berita hero v2): latar primary 92 % dengan teks putih.
  final bool onImage;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Kategori $label',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: 2),
        decoration: BoxDecoration(
          color: onImage ? const Color(0xEB1A4B17) : context.kc.tintStrong,
          borderRadius: BorderRadius.circular(KapdhRadius.sm),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: KapdhFontSize.overline,
            fontWeight: FontWeight.w600,
            color: onImage ? KapdhColors.textOnDark : context.kc.primary,
          ),
        ),
      ),
    );
  }
}

/// Baris ikon kecil + teks (tanggal, lokasi, kuota) pada kartu dan detail.
class IconLine extends StatelessWidget {
  const IconLine({super.key, required this.icon, required this.text, this.color, this.iconColor, this.size = 12});

  final IconData icon;
  final String text;

  /// Warna teks dan ikon; bawaan teks redup palet.
  final Color? color;

  /// Warna ikon bila berbeda dari teks (mis. ikon meta hijau kartu event v2).
  final Color? iconColor;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: ExcludeSemantics(
            child: Icon(icon, size: size + 2, color: iconColor ?? color ?? context.kc.textMuted),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            style: TextStyle(fontSize: size, color: color ?? context.kc.textMuted, height: 1.35),
          ),
        ),
      ],
    );
  }
}

/// Kartu putih yang dapat diketuk (daftar event, berita, tiket): [v2] garis rambut cardBorder + --shadow-sm; cincin
/// fokus 3 px saat difokuskan keyboard/akses saklar (WCAG 1.4.11).
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
    final p = context.kc;
    // [v2] Cincin fokus di luar klip Material (lapisan depan pembungkus), menimpa garis rambut saat terfokus.
    final card = KapdhFocusRing(
      radius: radius,
      builder: (onFocusChange) => DecoratedBox(
        decoration: BoxDecoration(borderRadius: radius, boxShadow: p.shadowSm),
        child: Material(
          color: p.surface,
          shape: RoundedRectangleBorder(
            borderRadius: radius,
            side: BorderSide(color: p.cardBorder),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            onFocusChange: onFocusChange,
            child: Padding(padding: padding ?? const EdgeInsets.all(KapdhSpace.s3), child: child),
          ),
        ),
      ),
    );
    if (semanticsLabel == null) return card;
    return Semantics(button: onTap != null, label: semanticsLabel, excludeSemantics: true, onTap: onTap, child: card);
  }
}

/// Judul bagian dengan tautan "Lihat semua" (Beranda). [v2] Judul 17 w700; "Lihat semua" pil tonal + chevron (area
/// sentuh tetap 48).
class HomeSectionTitle extends StatelessWidget {
  const HomeSectionTitle({super.key, required this.title, this.actionLabel = 'Lihat semua', this.onAction});

  final String title;
  final String actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    // Wrap: pada teks besar pil "Lihat semua" turun ke baris berikut, judul tidak terpotong per huruf (N-11).
    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: KapdhSpace.s2,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
          child: Align(
            alignment: Alignment.centerLeft,
            widthFactor: 1,
            child: Semantics(
              header: true,
              child: Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            ),
          ),
        ),
        if (onAction != null)
          TextButton.icon(
            onPressed: onAction,
            iconAlignment: IconAlignment.end,
            icon: const Icon(KapdhIcons.chevronRight, size: KapdhIconSize.sm),
            label: Text(actionLabel),
            style: TextButton.styleFrom(
              backgroundColor: context.kc.tint,
              foregroundColor: context.kc.primary,
              minimumSize: const Size(KapdhSize.touchTargetMin, 32),
              tapTargetSize: MaterialTapTargetSize.padded,
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s3, 0, 6, 0),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
              textStyle: Theme.of(context).textTheme.labelLarge?.copyWith(fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
      ],
    );
  }
}

/// Muat ulang gagal sementara data terakhir tetap tampil (PRD 4.5, N-03): penyebab (offline atau pesan server) dan
/// coba lagi, sehingga anggota tahu status di bawahnya mungkin belum terbaru. Dipasang di posisi tetap (kosong bila
/// [error] null) agar indeks anak daftar tidak bergeser dan state anak lain (mis. hitung mundur hold) tetap.
class RefreshFailedNotice extends StatelessWidget {
  const RefreshFailedNotice({super.key, required this.error, required this.onRetry});

  final ApiException? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final failure = error;
    if (failure == null) return const SizedBox.shrink();
    final offline = failure.isNetwork;
    final cause = offline ? 'Periksa koneksi internet Anda.' : failure.message;
    return Padding(
      padding: const EdgeInsets.only(bottom: KapdhSpace.s3),
      child: Semantics(
        liveRegion: true,
        child: InfoBox(
          key: const ValueKey('refresh-failed'),
          tone: InfoBoxTone.warning,
          icon: offline ? KapdhIcons.cloudOff : KapdhIcons.syncProblem,
          title: 'Belum dapat diperbarui',
          message: '$cause Data di bawah adalah keadaan terakhir yang dimuat.',
          trailing: TextButton(onPressed: onRetry, child: const Text('Coba lagi')),
        ),
      ),
    );
  }
}
