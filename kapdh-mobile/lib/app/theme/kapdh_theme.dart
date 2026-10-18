import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'kapdh_tokens.dart';
import 'kapdh_focus.dart';

/// Tema Material 3 KAPDH berdasarkan Guidelines KAPDH Platform v1.0 (D15, PRD 4.6).
///
/// Berangkat dari `packages/design-tokens/flutter/lib/kapdh_theme.dart` dan disesuaikan untuk aplikasi: ukuran
/// prototipe (app bar 17 px, field label di atas), navigasi bawah, dialog dan target sentuh 48 px (N-11). Widget
/// badge status ada di `lib/design/status_badge.dart`.
///
/// Font: Poppins dimuat google_fonts saat runtime dan di-cache di perangkat; tanpa koneksi pada peluncuran pertama
/// teks memakai font sistem (fallback) sampai Poppins tersedia. Membundel TTF Poppins sebagai aset adalah tindak
/// lanjut rilis (README). Heading memakai Telegraf bila font berlisensi sudah dibundel sebagai aset `Telegraf`.
abstract final class KapdhTheme {
  static const bool useTelegraf = false; // ubah ke true setelah lisensi Telegraf dimiliki

  /// `false` mematikan pemuatan font runtime (uji widget dan lingkungan tanpa jaringan); teks memakai font sistem.
  static bool runtimeFonts = true;

  static const String _family = 'Poppins';

  static TextStyle _poppins({double? fontSize, FontWeight? fontWeight, Color? color, double? height}) {
    if (runtimeFonts) {
      return GoogleFonts.poppins(fontSize: fontSize, fontWeight: fontWeight, color: color, height: height);
    }
    return TextStyle(fontFamily: _family, fontSize: fontSize, fontWeight: fontWeight, color: color, height: height);
  }

  static TextTheme _bodyTheme() {
    if (runtimeFonts) return GoogleFonts.poppinsTextTheme();
    return Typography.material2021().black.apply(fontFamily: _family);
  }

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(seedColor: KapdhColors.primary, brightness: Brightness.light).copyWith(
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

    final body = _bodyTheme();
    TextStyle heading(double size) => useTelegraf
        ? TextStyle(
            fontFamily: 'Telegraf',
            fontSize: size,
            fontWeight: FontWeight.w700,
            color: KapdhColors.text,
            height: 1.2,
          )
        : _poppins(fontSize: size, fontWeight: FontWeight.w600, color: KapdhColors.text, height: 1.25);

    final textTheme = body.copyWith(
      displaySmall: heading(KapdhFontSize.display),
      headlineSmall: heading(KapdhFontSize.h1),
      titleLarge: heading(KapdhFontSize.h2),
      titleMedium: heading(KapdhFontSize.h3),
      titleSmall: _poppins(fontSize: 15, fontWeight: FontWeight.w600, color: KapdhColors.text, height: 1.3),
      bodyLarge: body.bodyLarge?.copyWith(fontSize: KapdhFontSize.bodyLg, color: KapdhColors.text, height: 1.45),
      bodyMedium: body.bodyMedium?.copyWith(fontSize: KapdhFontSize.body, color: KapdhColors.text, height: 1.45),
      bodySmall: body.bodySmall?.copyWith(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted, height: 1.45),
      labelLarge: body.labelLarge?.copyWith(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w600),
      labelMedium: body.labelMedium?.copyWith(fontSize: KapdhFontSize.caption, fontWeight: FontWeight.w500),
      labelSmall: body.labelSmall?.copyWith(fontSize: KapdhFontSize.overline, fontWeight: FontWeight.w500),
    );

    final fieldBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(KapdhRadius.md),
      borderSide: const BorderSide(color: KapdhColors.border),
    );

    // Cincin fokus hijau 3 px di permukaan terang (KapdhFocusTheme; emas lewat DarkSurfaceFocus di permukaan gelap).
    return KapdhFocusTheme.withRing(_base(scheme, textTheme, fieldBorder), KapdhColors.focusRing);
  }

  static ThemeData _base(ColorScheme scheme, TextTheme textTheme, OutlineInputBorder fieldBorder) {
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: KapdhColors.background,
      textTheme: textTheme,
      fontFamily: runtimeFonts ? null : _family,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      appBarTheme: AppBarTheme(
        backgroundColor: KapdhColors.surface,
        foregroundColor: KapdhColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        centerTitle: true,
        toolbarHeight: KapdhSize.appBarHeight,
        titleTextStyle: _poppins(fontSize: 17, fontWeight: FontWeight.w600, color: KapdhColors.text),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: KapdhColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
        border: fieldBorder,
        enabledBorder: fieldBorder,
        focusedBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.primary, width: 2)),
        errorBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.danger)),
        focusedErrorBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.danger, width: 2)),
        disabledBorder: fieldBorder.copyWith(borderSide: const BorderSide(color: KapdhColors.divider)),
        hintStyle: const TextStyle(color: KapdhColors.textMuted, fontSize: KapdhFontSize.body),
        labelStyle: const TextStyle(color: KapdhColors.text, fontWeight: FontWeight.w500),
        errorStyle: const TextStyle(color: KapdhColors.danger, fontSize: KapdhFontSize.caption),
        errorMaxLines: 3,
        helperMaxLines: 3,
        prefixIconColor: KapdhColors.textMuted,
        suffixIconColor: KapdhColors.textMuted,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: KapdhColors.primary,
          foregroundColor: KapdhColors.onPrimary,
          disabledBackgroundColor: KapdhColors.disabledBg,
          disabledForegroundColor: KapdhColors.disabledText,
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.buttonHeight),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: KapdhFontSize.label),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: KapdhColors.primary,
          side: const BorderSide(color: KapdhColors.primary),
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.buttonHeight),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: KapdhFontSize.label),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: KapdhColors.primary,
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
          textStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin)),
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? KapdhColors.primary : null,
        ),
        side: const BorderSide(color: KapdhColors.border, width: 1.5),
      ),
      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? KapdhColors.primary : KapdhColors.border,
        ),
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
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: KapdhColors.surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: KapdhColors.green100,
        elevation: 0,
        height: 64,
        iconTheme: WidgetStateProperty.resolveWith(
          (states) =>
              IconThemeData(color: states.contains(WidgetState.selected) ? KapdhColors.primary : KapdhColors.textMuted),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontSize: KapdhFontSize.caption,
            fontWeight: states.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w400,
            color: states.contains(WidgetState.selected) ? KapdhColors.primary : KapdhColors.textMuted,
          ),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: KapdhColors.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.lg)),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: KapdhColors.surface,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(KapdhRadius.xl))),
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(color: KapdhColors.primary),
      dividerTheme: const DividerThemeData(color: KapdhColors.divider, thickness: 1, space: 1),
      snackBarTheme: const SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: KapdhColors.green950,
        actionTextColor: KapdhColors.accent,
      ),
    );
  }
}
