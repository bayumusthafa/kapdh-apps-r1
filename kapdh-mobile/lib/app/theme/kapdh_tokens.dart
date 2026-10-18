// DIBANGKITKAN dari tokens.json oleh build.mjs. Jangan edit manual.
// ignore_for_file: constant_identifier_names
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
  static const neutral50 = Color(0xFFFBFAFF);
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
  static const background = Color(0xFFFBFAFF);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceBrand = Color(0xFFFCF8F5);
  static const surfaceDark = Color(0xFF0E280C);
  static const text = Color(0xFF1C1B1F);
  static const textMuted = Color(0xFF6B6B6B);
  static const textOnDark = Color(0xFFFFFFFF);
  static const textHighlightOnDark = Color(0xFFE6D312);
  static const border = Color(0xFF8A8F87);
  static const divider = Color(0xFFE3E3E6);
  static const disabledBg = Color(0xFFE1E5DE);
  static const disabledText = Color(0xFF5E665C);
  static const focusRing = Color(0xFF2D7A28);
  static const focusRingOnDark = Color(0xFFE6D312);

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

abstract final class KapdhGradients {
  static const ktaCard = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
      colors: [Color(0xFF020702), Color(0xFF0E280C), Color(0xFF215E1E)], stops: [0, 0.45, 1]);
  static const buttonPrimary = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
      colors: [Color(0xFF215E1E), Color(0xFF1A4B17)]);
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
  static const double sm = 6;
  static const double md = 10;
  static const double lg = 14;
  static const double xl = 20;
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
