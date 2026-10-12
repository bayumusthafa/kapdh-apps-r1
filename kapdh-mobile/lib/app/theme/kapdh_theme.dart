import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'kapdh_tokens.dart';

/// Tema Material 3 KAPDH berdasarkan Guidelines KAPDH Platform v1.0.
///
/// Heading memakai Telegraf bila font berlisensi sudah dibundel sebagai aset
/// `Telegraf`; tanpa itu, heading jatuh ke Poppins SemiBold.
abstract final class KapdhTheme {
  static const bool useTelegraf = false; // ubah ke true setelah lisensi Telegraf dimiliki

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(
      seedColor: KapdhColors.primary,
      brightness: Brightness.light,
    ).copyWith(
      primary: KapdhColors.primary,
      onPrimary: KapdhColors.onPrimary,
      secondary: KapdhColors.accent,
      onSecondary: KapdhColors.onAccent,
      surface: KapdhColors.surface,
      onSurface: KapdhColors.text,
      onSurfaceVariant: KapdhColors.textMuted,
      outline: KapdhColors.border,
      outlineVariant: KapdhColors.divider,
      error: KapdhColors.danger,
      errorContainer: KapdhColors.dangerBg,
    );

    final body = GoogleFonts.poppinsTextTheme();
    TextStyle heading(double size) => useTelegraf
        ? TextStyle(fontFamily: 'Telegraf', fontSize: size, fontWeight: FontWeight.w700, color: KapdhColors.text, height: 1.2)
        : GoogleFonts.poppins(fontSize: size, fontWeight: FontWeight.w600, color: KapdhColors.text, height: 1.2);

    final textTheme = body.copyWith(
      displaySmall: heading(KapdhFontSize.display),
      headlineSmall: heading(KapdhFontSize.h1),
      titleLarge: heading(KapdhFontSize.h2),
      titleMedium: heading(KapdhFontSize.h3),
      bodyLarge: body.bodyLarge?.copyWith(fontSize: KapdhFontSize.bodyLg, color: KapdhColors.text, height: 1.45),
      bodyMedium: body.bodyMedium?.copyWith(fontSize: KapdhFontSize.body, color: KapdhColors.text, height: 1.45),
      bodySmall: body.bodySmall?.copyWith(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
      labelLarge: body.labelLarge?.copyWith(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w600),
    );

    final fieldBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(KapdhRadius.md),
      borderSide: const BorderSide(color: KapdhColors.border),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: KapdhColors.background,
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: KapdhColors.surface,
        foregroundColor: KapdhColors.text,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: heading(KapdhFontSize.h3),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: KapdhColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: KapdhSpace.s4),
        border: fieldBorder,
        enabledBorder: fieldBorder,
        focusedBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.primary, width: 2)),
        errorBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.danger)),
        focusedErrorBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.danger, width: 2)),
        hintStyle: const TextStyle(color: KapdhColors.textMuted),
        labelStyle: const TextStyle(color: KapdhColors.text, fontWeight: FontWeight.w500),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: KapdhColors.primary,
          foregroundColor: KapdhColors.onPrimary,
          disabledBackgroundColor: KapdhColors.disabledBg,
          disabledForegroundColor: KapdhColors.disabledText,
          minimumSize: const Size.fromHeight(KapdhSize.buttonHeight),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: KapdhFontSize.label),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: KapdhColors.primary,
          side: const BorderSide(color: KapdhColors.primary),
          minimumSize: const Size.fromHeight(KapdhSize.buttonHeight),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: KapdhColors.primary, minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin)),
      ),
      cardTheme: CardThemeData(
        color: KapdhColors.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(KapdhRadius.lg),
          side: const BorderSide(color: KapdhColors.divider),
        ),
      ),
      chipTheme: ChipThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.pill)),
        side: BorderSide.none,
      ),
      dividerTheme: const DividerThemeData(color: KapdhColors.divider, thickness: 1),
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: KapdhColors.green950),
    );
  }
}

/// Badge status keanggotaan: warna + ikon + label, tidak bergantung pada warna saja.
class KapdhStatusBadge extends StatelessWidget {
  const KapdhStatusBadge(this.style, {super.key});
  final KapdhStatusStyle style;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Status: ${style.label}',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s3, vertical: KapdhSpace.s1),
        decoration: BoxDecoration(color: style.bg, borderRadius: BorderRadius.circular(KapdhRadius.pill)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 8, height: 8, decoration: BoxDecoration(color: style.fg, shape: BoxShape.circle)),
          const SizedBox(width: KapdhSpace.s2),
          Text(style.label, style: TextStyle(color: style.fg, fontWeight: FontWeight.w600, fontSize: KapdhFontSize.caption)),
        ]),
      ),
    );
  }
}
