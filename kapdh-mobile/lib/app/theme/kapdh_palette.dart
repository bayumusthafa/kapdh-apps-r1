import 'package:flutter/material.dart';

import 'kapdh_tokens.dart';

/// Palet semantik KAPDH (redesain v2, mockup `css/tokens.css`) sebagai [ThemeExtension] agar warna mengikuti tema
/// terang atau gelap. Widget membaca warna lewat `context.kc` (lihat [KapdhPaletteContext]), bukan konstanta
/// [KapdhColors] langsung, kecuali warna merek tetap (pita hijau, kartu KTA, emas) yang memang sama di kedua mode.
@immutable
class KapdhPalette extends ThemeExtension<KapdhPalette> {
  const KapdhPalette({
    required this.brightness,
    required this.background,
    required this.surface,
    required this.surfaceRaised,
    required this.text,
    required this.textMuted,
    required this.border,
    required this.divider,
    required this.cardBorder,
    required this.tint,
    required this.tintStrong,
    required this.iconAccent,
    required this.primary,
    required this.onPrimary,
    required this.primaryHover,
    required this.disabledBg,
    required this.disabledText,
    required this.focusRing,
    required this.neutral100,
    required this.neutral200,
    required this.neutral300,
    required this.skeleton,
    required this.skeletonShine,
    required this.success,
    required this.successBg,
    required this.warning,
    required this.warningBg,
    required this.danger,
    required this.dangerBg,
    required this.onDanger,
    required this.info,
    required this.infoBg,
    required this.neutral,
    required this.neutralBg,
    required this.rejectionBorder,
    required this.qaCircle,
    required this.qaCircleBorder,
    required this.qaIcon,
    required this.shadowXs,
    required this.shadowSm,
    required this.shadowMd,
    required this.shadowLg,
    required this.shadowKta,
    required this.shadowPrimaryButton,
    required this.shadowBarTop,
    required this.shadowBrandBand,
    required this.shadowRingFocusField,
  });

  final Brightness brightness;
  final Color background;
  final Color surface;

  /// Dialog, lembar bawah, menu.
  final Color surfaceRaised;
  final Color text;
  final Color textMuted;
  final Color border;
  final Color divider;

  /// Garis rambut kartu (kedalaman utama dari [shadowSm]).
  final Color cardBorder;

  /// Latar bernada hijau: ubin, chip, kotak info (terang = green50).
  final Color tint;

  /// Latar hijau lebih tegas: avatar, ikon, indikator (terang = green100).
  final Color tintStrong;

  /// Ikon meta kartu (terang = green600).
  final Color iconAccent;

  /// Primary sebagai teks/isi; di mode gelap hijau terang dengan teks gelap di atasnya.
  final Color primary;
  final Color onPrimary;
  final Color primaryHover;
  final Color disabledBg;
  final Color disabledText;
  final Color focusRing;
  final Color neutral100;
  final Color neutral200;
  final Color neutral300;
  final Color skeleton;
  final Color skeletonShine;
  final Color success;
  final Color successBg;
  final Color warning;
  final Color warningBg;
  final Color danger;
  final Color dangerBg;
  final Color onDanger;
  final Color info;
  final Color infoBg;
  final Color neutral;
  final Color neutralBg;
  final Color rejectionBorder;

  /// Lingkaran ikon akses cepat (sorot kiri atas) dan isi ikonnya.
  final Gradient qaCircle;
  final Color qaCircleBorder;
  final Gradient qaIcon;

  final List<BoxShadow> shadowXs;
  final List<BoxShadow> shadowSm;
  final List<BoxShadow> shadowMd;
  final List<BoxShadow> shadowLg;
  final List<BoxShadow> shadowKta;
  final List<BoxShadow> shadowPrimaryButton;
  final List<BoxShadow> shadowBarTop;
  final List<BoxShadow> shadowBrandBand;

  /// Halo 4 px field/kotak OTP yang terfokus (--ring-focus-field).
  final List<BoxShadow> shadowRingFocusField;

  bool get isDark => brightness == Brightness.dark;

  static const light = KapdhPalette(
    brightness: Brightness.light,
    background: KapdhColors.background,
    surface: KapdhColors.surface,
    surfaceRaised: KapdhColors.surfaceRaised,
    text: KapdhColors.text,
    textMuted: KapdhColors.textMuted,
    border: KapdhColors.border,
    divider: KapdhColors.divider,
    cardBorder: KapdhColors.cardBorder,
    tint: KapdhColors.tint,
    tintStrong: KapdhColors.tintStrong,
    iconAccent: KapdhColors.iconAccent,
    primary: KapdhColors.primary,
    onPrimary: KapdhColors.onPrimary,
    primaryHover: KapdhColors.primaryHover,
    disabledBg: KapdhColors.disabledBg,
    disabledText: KapdhColors.disabledText,
    focusRing: KapdhColors.focusRing,
    neutral100: KapdhColors.neutral100,
    neutral200: KapdhColors.neutral200,
    neutral300: KapdhColors.neutral300,
    skeleton: KapdhColors.skeleton,
    skeletonShine: KapdhColors.skeletonShine,
    success: KapdhColors.success,
    successBg: KapdhColors.successBg,
    warning: KapdhColors.warning,
    warningBg: KapdhColors.warningBg,
    danger: KapdhColors.danger,
    dangerBg: KapdhColors.dangerBg,
    onDanger: KapdhColors.onDanger,
    info: KapdhColors.info,
    infoBg: KapdhColors.infoBg,
    neutral: KapdhColors.neutral,
    neutralBg: KapdhColors.neutralBg,
    rejectionBorder: Color(0xFFF3C3BF),
    qaCircle: RadialGradient(
      center: Alignment(-0.36, -0.52),
      radius: 0.9,
      colors: [Color(0xFFFFFFFF), Color(0xFFF2F6F0), Color(0xFFE1E9DE)],
      stops: [0, 0.42, 1],
    ),
    qaCircleBorder: Color(0x1F1A4B17),
    qaIcon: LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFF4A9441), KapdhColors.green800, KapdhColors.green950],
      stops: [0, 0.62, 1],
    ),
    shadowXs: KapdhShadows.xs,
    shadowSm: KapdhShadows.sm,
    shadowMd: KapdhShadows.md,
    shadowLg: KapdhShadows.lg,
    shadowKta: KapdhShadows.kta,
    shadowPrimaryButton: KapdhShadows.primaryButton,
    shadowBarTop: KapdhShadows.barTop,
    shadowBrandBand: KapdhShadows.brandBand,
    shadowRingFocusField: KapdhShadows.ringFocusField,
  );

  static const dark = KapdhPalette(
    brightness: Brightness.dark,
    background: KapdhDarkColors.background,
    surface: KapdhDarkColors.surface,
    surfaceRaised: KapdhDarkColors.surfaceRaised,
    text: KapdhDarkColors.text,
    textMuted: KapdhDarkColors.textMuted,
    border: KapdhDarkColors.border,
    divider: KapdhDarkColors.divider,
    cardBorder: KapdhDarkColors.cardBorder,
    tint: KapdhDarkColors.tint,
    tintStrong: KapdhDarkColors.tintStrong,
    iconAccent: KapdhDarkColors.iconAccent,
    primary: KapdhDarkColors.primary,
    onPrimary: KapdhDarkColors.onPrimary,
    primaryHover: KapdhDarkColors.primaryHover,
    disabledBg: KapdhDarkColors.disabledBg,
    disabledText: KapdhDarkColors.disabledText,
    focusRing: KapdhDarkColors.focusRing,
    neutral100: KapdhDarkColors.neutral100,
    neutral200: KapdhDarkColors.neutral200,
    neutral300: KapdhDarkColors.neutral300,
    skeleton: KapdhDarkColors.skeleton,
    skeletonShine: KapdhDarkColors.skeletonShine,
    success: KapdhDarkColors.success,
    successBg: KapdhDarkColors.successBg,
    warning: KapdhDarkColors.warning,
    warningBg: KapdhDarkColors.warningBg,
    danger: KapdhDarkColors.danger,
    dangerBg: KapdhDarkColors.dangerBg,
    onDanger: KapdhDarkColors.onDanger,
    info: KapdhDarkColors.info,
    infoBg: KapdhDarkColors.infoBg,
    neutral: KapdhDarkColors.neutral,
    neutralBg: KapdhDarkColors.neutralBg,
    rejectionBorder: KapdhDarkColors.rejectionBorder,
    qaCircle: RadialGradient(
      center: Alignment(-0.36, -0.52),
      radius: 0.9,
      colors: [Color(0xFF34452F), Color(0xFF243322), Color(0xFF1B281A)],
      stops: [0, 0.5, 1],
    ),
    qaCircleBorder: Color(0x338BD47E),
    qaIcon: LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFFD4F2CB), Color(0xFF9EDD92), Color(0xFF7CC66F)],
      stops: [0, 0.55, 1],
    ),
    shadowXs: KapdhShadowsDark.xs,
    shadowSm: KapdhShadowsDark.sm,
    shadowMd: KapdhShadowsDark.md,
    shadowLg: KapdhShadowsDark.lg,
    shadowKta: KapdhShadowsDark.kta,
    shadowPrimaryButton: KapdhShadowsDark.primaryButton,
    shadowBarTop: KapdhShadowsDark.barTop,
    shadowBrandBand: KapdhShadowsDark.brandBand,
    shadowRingFocusField: KapdhShadowsDark.ringFocusField,
  );

  /// Warna terang [KapdhColors] yang tersimpan di data gaya tanpa konteks (mis. [StatusBadgeStyle] dari fungsi
  /// format status) dipetakan ke padanan palet aktif. Warna lain (merek tetap, emas) dikembalikan apa adanya.
  Color resolve(Color color) {
    if (!isDark) return color;
    return _darkOf[color.toARGB32()] ?? color;
  }

  static final Map<int, Color> _darkOf = {
    KapdhColors.background.toARGB32(): KapdhDarkColors.background,
    KapdhColors.surface.toARGB32(): KapdhDarkColors.surface,
    KapdhColors.text.toARGB32(): KapdhDarkColors.text,
    KapdhColors.textMuted.toARGB32(): KapdhDarkColors.textMuted,
    KapdhColors.border.toARGB32(): KapdhDarkColors.border,
    KapdhColors.divider.toARGB32(): KapdhDarkColors.divider,
    KapdhColors.primary.toARGB32(): KapdhDarkColors.primary,
    KapdhColors.tint.toARGB32(): KapdhDarkColors.tint,
    KapdhColors.tintStrong.toARGB32(): KapdhDarkColors.tintStrong,
    KapdhColors.success.toARGB32(): KapdhDarkColors.success,
    KapdhColors.successBg.toARGB32(): KapdhDarkColors.successBg,
    KapdhColors.warning.toARGB32(): KapdhDarkColors.warning,
    KapdhColors.warningBg.toARGB32(): KapdhDarkColors.warningBg,
    KapdhColors.danger.toARGB32(): KapdhDarkColors.danger,
    KapdhColors.dangerBg.toARGB32(): KapdhDarkColors.dangerBg,
    KapdhColors.info.toARGB32(): KapdhDarkColors.info,
    KapdhColors.infoBg.toARGB32(): KapdhDarkColors.infoBg,
    KapdhColors.neutral.toARGB32(): KapdhDarkColors.neutral,
    KapdhColors.neutralBg.toARGB32(): KapdhDarkColors.neutralBg,
  };

  /// Palet di [context]; bawaan terang bila tema tidak memasang ekstensi.
  static KapdhPalette of(BuildContext context) => Theme.of(context).extension<KapdhPalette>() ?? light;

  @override
  KapdhPalette copyWith() => this;

  /// Tema berganti tanpa animasi warna antarpalet (palet terang/gelap tidak di-interpolasi per kanal).
  @override
  KapdhPalette lerp(KapdhPalette? other, double t) => other == null || t < 0.5 ? this : other;
}

/// `context.kc.textMuted` dan seterusnya.
extension KapdhPaletteContext on BuildContext {
  KapdhPalette get kc => KapdhPalette.of(this);
}
