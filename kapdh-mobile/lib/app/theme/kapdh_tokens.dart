// DIBANGKITKAN dari tokens.json oleh build.mjs. Jangan edit manual.
// ignore_for_file: constant_identifier_names
import 'package:flutter/animation.dart';
import 'package:flutter/painting.dart';

/// Warna KAPDH dari Guidelines KAPDH Platform v1.0.
abstract final class KapdhColors {
  static const green950 = Color(0xFF0E280C);
  static const green900 = Color(0xFF143A12);
  static const green800 = Color(0xFF1A4B17);
  static const green700 = Color(0xFF215E1E);
  static const green600 = Color(0xFF2D7A28);
  static const green500 = Color(0xFF3F9A38);
  static const green100 = Color(0xFFE3F0E1);
  static const green50 = Color(0xFFF1F8F0);
  static const gold500 = Color(0xFFE6D312);
  static const gold400 = Color(0xFFF0DD19);
  static const gold100 = Color(0xFFFBF6C9);
  static const cream = Color(0xFFFCF8F5);
  static const neutral0 = Color(0xFFFFFFFF);
  static const neutral50 = Color(0xFFF5F7F3);
  static const neutral100 = Color(0xFFF4F4F6);
  static const neutral200 = Color(0xFFE3E3E6);
  static const neutral300 = Color(0xFFC9C9C9);
  static const neutral500 = Color(0xFF8A8F87);
  static const neutral600 = Color(0xFF6B6B6B);
  static const neutral700 = Color(0xFF3F4A3E);
  static const neutral900 = Color(0xFF1C1B1F);

  static const primary = Color(0xFF1A4B17);
  static const onPrimary = Color(0xFFFFFFFF);
  static const primaryHover = Color(0xFF215E1E);
  static const accent = Color(0xFFE6D312);
  static const onAccent = Color(0xFF0E280C);
  static const background = Color(0xFFF5F7F3);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceBrand = Color(0xFFFCF8F5);
  static const surfaceDark = Color(0xFF0E280C);
  static const text = Color(0xFF1C1B1F);
  static const textMuted = Color(0xFF5E665C);
  static const textOnDark = Color(0xFFFFFFFF);
  static const textHighlightOnDark = Color(0xFFE6D312);
  static const border = Color(0xFF8A8F87);
  static const divider = Color(0xFFE1E6DE);
  static const disabledBg = Color(0xFFE1E5DE);
  static const disabledText = Color(0xFF5E665C);
  static const focusRing = Color(0xFF2D7A28);
  static const focusRingOnDark = Color(0xFFE6D312);
  static const cardBorder = Color(0xFFE6EBE3);
  static const tint = Color(0xFFF1F8F0);
  static const tintStrong = Color(0xFFE3F0E1);
  static const surfaceRaised = Color(0xFFFFFFFF);
  static const iconAccent = Color(0xFF2D7A28);
  static const skeleton = Color(0xFFE4E9E1);
  static const skeletonShine = Color(0xFFF0F3EE);
  static const onDanger = Color(0xFFFFFFFF);

  static const success = Color(0xFF1E7A46);
  static const successBg = Color(0xFFE8F7F0);
  static const warning = Color(0xFF8A5A00);
  static const warningBg = Color(0xFFFFF4D6);
  static const danger = Color(0xFFB3261E);
  static const dangerBg = Color(0xFFFDECEA);
  static const info = Color(0xFF1F5FA8);
  static const infoBg = Color(0xFFE7F0FB);
  static const neutral = Color(0xFF3F4A3E);
  static const neutralBg = Color(0xFFEEEFEE);
}

/// Gaya badge status keanggotaan; label wajib ditampilkan bersama warna.
class KapdhStatusStyle {
  const KapdhStatusStyle(this.fg, this.bg, this.label, this.icon);
  final Color fg;
  final Color bg;
  final String label;
  final String icon;
}

abstract final class KapdhMembershipStatus {
  static const verified = KapdhStatusStyle(Color(0xFF1E7A46), Color(0xFFE8F7F0), 'KTA Aktif', 'check_circle');
  static const expiring = KapdhStatusStyle(Color(0xFF8A5A00), Color(0xFFFFF4D6), 'Segera Berakhir', 'schedule');
  static const expired = KapdhStatusStyle(Color(0xFFB3261E), Color(0xFFFDECEA), 'KTA Kedaluwarsa', 'cancel');
  static const unverified = KapdhStatusStyle(Color(0xFFB3261E), Color(0xFFFDECEA), 'KTA Tidak Aktif', 'cancel');
  static const pendingReview = KapdhStatusStyle(Color(0xFF1F5FA8), Color(0xFFE7F0FB), 'Menunggu Verifikasi', 'hourglass_top');
  static const suspended = KapdhStatusStyle(Color(0xFF3F4A3E), Color(0xFFEEEFEE), 'Dibatasi', 'block');
}

/// Palet mode gelap v2 (tokens.json dark). Dipakai KapdhPalette.dark di lib/app/theme.
abstract final class KapdhDarkColors {
  static const background = Color(0xFF0F1A0E);
  static const surface = Color(0xFF172416);
  static const surfaceRaised = Color(0xFF1D2C1B);
  static const neutral100 = Color(0xFF222D21);
  static const neutral200 = Color(0xFF2B3929);
  static const neutral300 = Color(0xFF4A5648);
  static const tint = Color(0xFF1B2D19);
  static const tintStrong = Color(0xFF23401F);
  static const text = Color(0xFFE7ECE5);
  static const textMuted = Color(0xFFA5B0A2);
  static const border = Color(0xFF74806F);
  static const divider = Color(0xFF2B3929);
  static const cardBorder = Color(0xFF263424);
  static const iconAccent = Color(0xFF8BD47E);
  static const primary = Color(0xFF8BD47E);
  static const onPrimary = Color(0xFF0E280C);
  static const primaryHover = Color(0xFF9EDD92);
  static const disabledBg = Color(0xFF263124);
  static const disabledText = Color(0xFF9AA597);
  static const focusRing = Color(0xFFE6D312);
  static const skeleton = Color(0xFF243022);
  static const skeletonShine = Color(0xFF2E3B2C);
  static const success = Color(0xFF6FD49B);
  static const successBg = Color(0xFF10301E);
  static const warning = Color(0xFFF2C14E);
  static const warningBg = Color(0xFF33270A);
  static const danger = Color(0xFFFF8A80);
  static const dangerBg = Color(0xFF3A1512);
  static const onDanger = Color(0xFF3A1512);
  static const info = Color(0xFF8DB8F2);
  static const infoBg = Color(0xFF13243A);
  static const neutral = Color(0xFFB8C2B5);
  static const neutralBg = Color(0xFF2A332A);
  static const rejectionBorder = Color(0xFF5A2A26);
}

abstract final class KapdhGradients {
  static const ktaCard = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
      colors: [Color(0xFF020702), Color(0xFF0E280C), Color(0xFF215E1E)], stops: [0, 0.45, 1]);
  static const buttonPrimary = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
      colors: [Color(0xFF215E1E), Color(0xFF1A4B17)]);
  /// Dasar mesh zamrud (gradient.brand-mesh): diagonal green950 -> green800 -> green700. Cahaya emas dan hijau
  /// ditumpuk oleh BrandMesh (lib/design/brand_mesh.dart).
  static const brandMeshBase = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
      colors: [Color(0xFF0E280C), Color(0xFF1A4B17), Color(0xFF215E1E)], stops: [0, 0.55, 1]);
  static const brandMeshGold = RadialGradient(center: Alignment(0.84, -1), radius: 0.92,
      colors: [Color(0x33E6D312), Color(0x00E6D312)]);
  static const brandMeshGreen = RadialGradient(center: Alignment(-0.88, 1), radius: 1.1,
      colors: [Color(0x573F9A38), Color(0x003F9A38)]);
  /// Latar Splash mode terang (gradient.splash).
  static const splash = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
      colors: [Color(0xFFFAFAFA), Color(0xFFEEEFED), Color(0xFFE2E4E1)], stops: [0, 0.55, 1]);
}

/// Bayangan v2 (elevation.light).
abstract final class KapdhShadows {
  static const xs = <BoxShadow>[BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x0F0E280C))];
  static const sm = <BoxShadow>[BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x0A0E280C)), BoxShadow(offset: Offset(0, 2), blurRadius: 8, color: Color(0x0F0E280C))];
  static const md = <BoxShadow>[BoxShadow(offset: Offset(0, 2), blurRadius: 4, color: Color(0x0D0E280C)), BoxShadow(offset: Offset(0, 8), blurRadius: 20, color: Color(0x140E280C))];
  static const lg = <BoxShadow>[BoxShadow(offset: Offset(0, 4), blurRadius: 8, color: Color(0x140E280C)), BoxShadow(offset: Offset(0, 16), blurRadius: 40, color: Color(0x2E0E280C))];
  static const kta = <BoxShadow>[BoxShadow(offset: Offset(0, 4), blurRadius: 8, color: Color(0x24020702)), BoxShadow(offset: Offset(0, 14), blurRadius: 32, color: Color(0x470E280C))];
  static const primaryButton = <BoxShadow>[BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x290E280C)), BoxShadow(offset: Offset(0, 4), blurRadius: 12, color: Color(0x3D1A4B17))];
  static const barTop = <BoxShadow>[BoxShadow(offset: Offset(0, -6), blurRadius: 20, color: Color(0x0F0E280C))];
  static const brandBand = <BoxShadow>[BoxShadow(offset: Offset(0, 12), blurRadius: 28, spreadRadius: -10, color: Color(0x8C0E280C))];
  static const ringFocusField = <BoxShadow>[BoxShadow(offset: Offset(0, 0), blurRadius: 0, spreadRadius: 4, color: Color(0x292D7A28))];
}

/// Bayangan v2 (elevation.dark).
abstract final class KapdhShadowsDark {
  static const xs = <BoxShadow>[BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x59000000))];
  static const sm = <BoxShadow>[BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x4D000000)), BoxShadow(offset: Offset(0, 2), blurRadius: 8, color: Color(0x47000000))];
  static const md = <BoxShadow>[BoxShadow(offset: Offset(0, 2), blurRadius: 4, color: Color(0x52000000)), BoxShadow(offset: Offset(0, 8), blurRadius: 20, color: Color(0x5C000000))];
  static const lg = <BoxShadow>[BoxShadow(offset: Offset(0, 4), blurRadius: 8, color: Color(0x5C000000)), BoxShadow(offset: Offset(0, 16), blurRadius: 40, color: Color(0x80000000))];
  static const kta = <BoxShadow>[BoxShadow(offset: Offset(0, 4), blurRadius: 8, color: Color(0x59000000)), BoxShadow(offset: Offset(0, 14), blurRadius: 32, color: Color(0x80000000))];
  static const primaryButton = <BoxShadow>[BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x4D000000)), BoxShadow(offset: Offset(0, 4), blurRadius: 12, color: Color(0x2E8BD47E))];
  static const barTop = <BoxShadow>[BoxShadow(offset: Offset(0, -6), blurRadius: 20, color: Color(0x4D000000))];
  static const brandBand = <BoxShadow>[BoxShadow(offset: Offset(0, 12), blurRadius: 28, spreadRadius: -10, color: Color(0x99000000))];
  static const ringFocusField = <BoxShadow>[BoxShadow(offset: Offset(0, 0), blurRadius: 0, spreadRadius: 4, color: Color(0x388BD47E))];
}

/// Durasi (motion, ms) dan kurva (easing) animasi v2.
abstract final class KapdhMotion {
  static const press = Duration(milliseconds: 100);
  static const fast = Duration(milliseconds: 150);
  static const base = Duration(milliseconds: 250);
  static const slow = Duration(milliseconds: 350);
  static const Curve easeStandard = Cubic(0.2, 0, 0, 1);
  static const Curve easeOut = Cubic(0.215, 0.61, 0.355, 1);
}

abstract final class KapdhIconSize {
  static const double xs = 14;
  static const double sm = 16;
  static const double button = 18;
  static const double md = 20;
  static const double lg = 24;
  static const double xl = 28;
}

abstract final class KapdhSpace {
  static const double s0 = 0;
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s8 = 32;
  static const double s10 = 40;
  static const double s12 = 48;
  static const double s16 = 64;
}

abstract final class KapdhRadius {
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double pill = 999;
}

abstract final class KapdhFontSize {
  static const double display = 32;
  static const double h1 = 24;
  static const double h2 = 20;
  static const double h3 = 18;
  static const double bodyLg = 16;
  static const double body = 14;
  static const double label = 14;
  static const double caption = 12;
  static const double overline = 11;
}

abstract final class KapdhSize {
  static const double touchTargetMin = 48;
  static const double inputHeight = 52;
  static const double buttonHeight = 48;
  static const double appBarHeight = 56;
}
