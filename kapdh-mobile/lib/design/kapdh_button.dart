import 'package:flutter/material.dart';

import '../app/theme/kapdh_focus.dart';
import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_theme.dart';
import '../app/theme/kapdh_tokens.dart';
import 'design_constants.dart';

enum KapdhButtonVariant {
  /// Aksi utama: gradasi hijau, tinggi 52 px (prototipe layar 1 sampai 5 "Verifikasi", "Lanjut ke pembayaran").
  primary,

  /// Hijau polos 48 px (prototipe layar 4 "Ke Beranda", layar 6 "Bayar").
  solid,

  /// Garis hijau 48 px (prototipe layar 4 "Ganti bukti", layar 7 "Sinkronkan").
  outlined,

  /// Emas 52 px untuk aksi utama di atas permukaan hijau gelap (layar Welcome "Daftar KAPDH Apps").
  accent,

  /// Garis putih 48 px di atas permukaan hijau gelap (layar Welcome "Sudah Punya Akun? Masuk").
  outlinedOnDark,
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

  const KapdhButton.accent({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.busyLabel,
    this.expand = true,
    this.semanticsHint,
  }) : variant = KapdhButtonVariant.accent;

  const KapdhButton.outlinedOnDark({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.busyLabel,
    this.expand = true,
    this.semanticsHint,
  }) : variant = KapdhButtonVariant.outlinedOnDark;

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
    final tall = variant == KapdhButtonVariant.primary || variant == KapdhButtonVariant.accent;
    final minHeight = tall ? KapdhComponentSize.primaryButtonHeight : KapdhSize.buttonHeight;
    final radius = BorderRadius.circular(KapdhRadius.md);
    final enabled = _enabled;
    final p = context.kc;

    final Color foreground;
    final BoxDecoration decoration;
    switch (variant) {
      case KapdhButtonVariant.primary:
        foreground = enabled ? p.onPrimary : p.disabledText;
        // [v2] Bayangan hijau --shadow-primary-btn; hilang saat nonaktif/sibuk.
        decoration = BoxDecoration(
          gradient: enabled ? (p.isDark ? kapdhDarkPrimaryGradient : KapdhGradients.buttonPrimary) : null,
          color: enabled ? null : p.disabledBg,
          borderRadius: radius,
          boxShadow: enabled ? p.shadowPrimaryButton : null,
        );
      case KapdhButtonVariant.solid:
        foreground = enabled ? p.onPrimary : p.disabledText;
        decoration = BoxDecoration(color: enabled ? p.primary : p.disabledBg, borderRadius: radius);
      case KapdhButtonVariant.outlined:
        foreground = enabled ? p.primary : p.disabledText;
        decoration = BoxDecoration(
          color: p.surface,
          border: Border.all(color: enabled ? p.primary : p.divider),
          borderRadius: radius,
        );
      case KapdhButtonVariant.accent:
        foreground = enabled ? KapdhColors.onAccent : context.kc.disabledText;
        decoration = BoxDecoration(
          color: enabled ? KapdhColors.accent : context.kc.disabledBg,
          borderRadius: radius,
          boxShadow: enabled ? const [BoxShadow(offset: Offset(0, 4), blurRadius: 12, color: Color(0x38000000))] : null,
        );
      case KapdhButtonVariant.outlinedOnDark:
        foreground = enabled ? KapdhColors.textOnDark : KapdhExtraColors.mutedOnDark;
        decoration = BoxDecoration(
          color: KapdhColors.textOnDark.withValues(alpha: 0.06),
          border: Border.all(
            color: enabled ? KapdhColors.textOnDark.withValues(alpha: 0.7) : KapdhExtraColors.mutedOnDark,
          ),
          borderRadius: radius,
        );
    }

    final text = busy ? (busyLabel ?? label) : label;
    final labelText = Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(color: foreground, fontWeight: FontWeight.w600, fontSize: tall ? 15 : KapdhFontSize.label),
    );
    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (busy) ...[
          SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: foreground)),
          const SizedBox(width: KapdhSpace.s2),
        ] else if (icon != null) ...[
          Icon(icon, size: KapdhIconSize.md, color: foreground),
          const SizedBox(width: KapdhSpace.s2),
        ],
        // Label boleh membungkus saat teks diperbesar (N-11).
        Flexible(child: labelText),
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
        child: KapdhFocusRing(
          // Varian permukaan gelap selalu bercincin emas; lainnya mengikuti tema (hijau, atau emas di DarkSurfaceFocus).
          ring: variant == KapdhButtonVariant.accent || variant == KapdhButtonVariant.outlinedOnDark
              ? KapdhColors.focusRingOnDark
              : KapdhFocusTheme.ringOf(context),
          radius: radius,
          builder: (onFocusChange) => DecoratedBox(
            decoration: decoration,
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                onTap: enabled ? onPressed : null,
                onFocusChange: onFocusChange,
                borderRadius: radius,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s3),
                  // Lebar intrinsik: IntrinsicWidth memberi Row lebar isinya yang dibatasi lebar induk, jadi
                  // Flexible tetap sah saat induk tak terbatas (mis. di dalam Row) dan label membungkus saat induk
                  // lebih sempit (teks 200 % di 320 dp). Bukan LayoutBuilder: AlertDialog mengukur lebar intrinsik.
                  child: Center(
                    widthFactor: expand ? null : 1,
                    child: expand ? content : IntrinsicWidth(child: content),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Gradasi tombol utama di mode gelap: primary terang (#9EDD92 -> #8BD47E) dengan teks hijau gelap.
const kapdhDarkPrimaryGradient = LinearGradient(
  begin: Alignment.topCenter,
  end: Alignment.bottomCenter,
  colors: [Color(0xFF9EDD92), Color(0xFF8BD47E)],
);

/// Tautan teks hijau dengan target sentuh 48 px (prototipe "Salah email? Ubah alamat email", "Hubungi pengurus").
class KapdhLinkButton extends StatelessWidget {
  const KapdhLinkButton({super.key, required this.label, required this.onPressed, this.icon});

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final style = TextButton.styleFrom(
      foregroundColor: context.kc.primary,
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s1),
      minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
      textStyle: KapdhTheme.font(fontSize: 13, fontWeight: FontWeight.w600),
    );
    if (icon != null) {
      return TextButton.icon(
        style: style,
        onPressed: onPressed,
        icon: Icon(icon, size: KapdhIconSize.button),
        label: Text(label),
      );
    }
    return TextButton(style: style, onPressed: onPressed, child: Text(label));
  }
}
