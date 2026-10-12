import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';

enum KapdhButtonVariant {
  /// Aksi utama: gradasi hijau, tinggi 52 px (prototipe layar 1 sampai 5 "Verifikasi", "Lanjut ke pembayaran").
  primary,

  /// Hijau polos 48 px (prototipe layar 4 "Ke Beranda", layar 6 "Bayar").
  solid,

  /// Garis hijau 48 px (prototipe layar 4 "Ganti bukti", layar 7 "Sinkronkan").
  outlined,
}

/// Tombol KAPDH. Tinggi minimum mengikuti prototipe dan bertambah saat teks diperbesar sampai 200 % (N-11);
/// target sentuh tidak pernah di bawah 48 px.
class KapdhButton extends StatelessWidget {
  const KapdhButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = KapdhButtonVariant.primary,
    this.icon,
    this.busy = false,
    this.busyLabel,
    this.expand = true,
    this.semanticsHint,
  });

  const KapdhButton.solid({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.busyLabel,
    this.expand = true,
    this.semanticsHint,
  }) : variant = KapdhButtonVariant.solid;

  const KapdhButton.outlined({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.busyLabel,
    this.expand = true,
    this.semanticsHint,
  }) : variant = KapdhButtonVariant.outlined;

  final String label;

  /// Null = nonaktif.
  final VoidCallback? onPressed;
  final KapdhButtonVariant variant;
  final IconData? icon;

  /// Sedang memproses: tombol nonaktif dan menampilkan indikator serta [busyLabel].
  final bool busy;
  final String? busyLabel;
  final bool expand;
  final String? semanticsHint;

  bool get _enabled => onPressed != null && !busy;

  @override
  Widget build(BuildContext context) {
    final minHeight = variant == KapdhButtonVariant.primary
        ? KapdhComponentSize.primaryButtonHeight
        : KapdhSize.buttonHeight;
    final radius = BorderRadius.circular(KapdhRadius.md);
    final enabled = _enabled;

    final Color foreground;
    final BoxDecoration decoration;
    switch (variant) {
      case KapdhButtonVariant.primary:
        foreground = enabled ? KapdhColors.onPrimary : KapdhColors.disabledText;
        decoration = BoxDecoration(
          gradient: enabled ? KapdhGradients.buttonPrimary : null,
          color: enabled ? null : KapdhColors.disabledBg,
          borderRadius: radius,
        );
      case KapdhButtonVariant.solid:
        foreground = enabled ? KapdhColors.onPrimary : KapdhColors.disabledText;
        decoration = BoxDecoration(color: enabled ? KapdhColors.primary : KapdhColors.disabledBg, borderRadius: radius);
      case KapdhButtonVariant.outlined:
        foreground = enabled ? KapdhColors.primary : KapdhColors.disabledText;
        decoration = BoxDecoration(
          color: KapdhColors.surface,
          border: Border.all(color: enabled ? KapdhColors.primary : KapdhColors.divider),
          borderRadius: radius,
        );
    }

    final text = busy ? (busyLabel ?? label) : label;
    final labelText = Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(
        color: foreground,
        fontWeight: FontWeight.w600,
        fontSize: variant == KapdhButtonVariant.primary ? 15 : KapdhFontSize.label,
      ),
    );
    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (busy) ...[
          SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: foreground)),
          const SizedBox(width: KapdhSpace.s2),
        ] else if (icon != null) ...[
          Icon(icon, size: 20, color: foreground),
          const SizedBox(width: KapdhSpace.s2),
        ],
        // Lebar penuh: label boleh membungkus saat teks diperbesar. Lebar intrinsik: tanpa Flexible karena
        // lebar induk bisa tak terbatas (mis. di dalam Row).
        if (expand) Flexible(child: labelText) else labelText,
      ],
    );

    return Semantics(
      container: true,
      button: true,
      enabled: enabled,
      hint: semanticsHint,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          minHeight: minHeight,
          minWidth: expand ? double.infinity : KapdhSize.touchTargetMin,
        ),
        child: DecoratedBox(
          decoration: decoration,
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: enabled ? onPressed : null,
              borderRadius: radius,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
                child: Center(widthFactor: expand ? null : 1, child: content),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Tautan teks hijau dengan target sentuh 48 px (prototipe "Salah email? Ubah alamat email", "Hubungi pengurus").
class KapdhLinkButton extends StatelessWidget {
  const KapdhLinkButton({super.key, required this.label, required this.onPressed, this.icon});

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final style = TextButton.styleFrom(
      foregroundColor: KapdhColors.primary,
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s1),
      minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
      textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
    );
    if (icon != null) {
      return TextButton.icon(style: style, onPressed: onPressed, icon: Icon(icon, size: 18), label: Text(label));
    }
    return TextButton(style: style, onPressed: onPressed, child: Text(label));
  }
}
