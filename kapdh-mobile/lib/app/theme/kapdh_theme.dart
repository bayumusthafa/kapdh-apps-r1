import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../design/kapdh_icons.dart';
import 'kapdh_focus.dart';
import 'kapdh_halo_border.dart';
import 'kapdh_palette.dart';
import 'kapdh_tokens.dart';

/// Tema Material 3 KAPDH berdasarkan Guidelines KAPDH Platform v1.0 (D15, PRD 4.6) dan redesain v2 mockup
/// (`kapdh-mobile/mockup-html/REDESAIN.md`): latar netral bernada hijau, radius 8/12/16/24, judul w700, kartu bergaris
/// rambut, dialog/lembar radius 24, menu dan snackbar radius 12, serta mode gelap dari palet [KapdhPalette.dark].
///
/// Berangkat dari `packages/design-tokens/flutter/lib/kapdh_theme.dart` dan disesuaikan untuk aplikasi: ukuran
/// prototipe (app bar 17 px, field label di atas), navigasi bawah, dialog dan target sentuh 48 px (N-11). Widget
/// badge status ada di `lib/design/status_badge.dart`.
///
/// Font: Poppins dibundel sebagai font aset (pubspec `fonts`, bobot 400/500/600/700 dan 400 italic) sehingga tampil
/// sejak peluncuran pertama tanpa koneksi dan tanpa permintaan ke server font pihak ketiga (ARCHITECTURE §8.1). Uji
/// widget tidak memuat font aset, jadi teks uji memakai font uji. Heading memakai Telegraf bila font berlisensi sudah
/// dibundel sebagai aset `Telegraf`.
abstract final class KapdhTheme {
  static const bool useTelegraf = false; // ubah ke true setelah lisensi Telegraf dimiliki

  static const String _family = 'Poppins';

  static TextStyle _poppins({double? fontSize, FontWeight? fontWeight, Color? color, double? height}) =>
      TextStyle(fontFamily: _family, fontSize: fontSize, fontWeight: fontWeight, color: color, height: height);

  /// Gaya teks berfont Poppins untuk tempat yang tidak mewarisi tema (ButtonStyle.textStyle menggantikan, tidak
  /// menggabungkan, gaya label tema; tanpa keluarga font tombol teks jatuh ke font sistem).
  static TextStyle font({
    double? fontSize,
    FontWeight? fontWeight,
    double? height,
    Color? color,
    TextDecoration? decoration,
    Color? decorationColor,
  }) => _poppins(
    fontSize: fontSize,
    fontWeight: fontWeight,
    color: color,
    height: height,
  ).copyWith(decoration: decoration, decorationColor: decorationColor);

  static TextTheme _bodyTheme(Brightness brightness) {
    final base = brightness == Brightness.dark ? Typography.material2021().white : Typography.material2021().black;
    return base.apply(fontFamily: _family);
  }

  // [v2] Ikon Phosphor untuk BackButton/CloseButton bawaan. Builder menggantikan seluruh ikon bawaan, termasuk label
  // semantik (duplikat tooltip) yang dipasang Flutter khusus Android, jadi label itu dipasang ulang di sini.
  static Widget _backButtonIcon(BuildContext context) => Icon(
    KapdhIcons.arrowBack,
    semanticLabel: _androidActionLabel(MaterialLocalizations.of(context).backButtonTooltip),
  );

  static Widget _closeButtonIcon(BuildContext context) =>
      Icon(KapdhIcons.close, semanticLabel: _androidActionLabel(MaterialLocalizations.of(context).closeButtonTooltip));

  // Sama dengan _ActionIcon bawaan: platform OS (bukan Theme.platform) karena Android yang mengharapkan label ganda.
  static String? _androidActionLabel(String label) => defaultTargetPlatform == TargetPlatform.android ? label : null;

  static ThemeData light() => _build(KapdhPalette.light);

  /// Mode gelap v2: varian tonal lebih terang di permukaan bertingkat; pita merek hijau (header, KTA) tetap.
  static ThemeData dark() => _build(KapdhPalette.dark);

  static ThemeData _build(KapdhPalette p) {
    final scheme = ColorScheme.fromSeed(seedColor: KapdhColors.primary, brightness: p.brightness).copyWith(
      primary: p.primary,
      onPrimary: p.onPrimary,
      secondary: KapdhColors.accent,
      onSecondary: KapdhColors.onAccent,
      // [v2] --m3-secondary-container / --m3-on-secondary-container: segmen SegmentedButton dan ChoiceChip terpilih.
      // Nilai terang sama dengan hasil fromSeed; gelap memakai token v2 (fromSeed gelap #3C4B37/#D6E8CD terlalu kusam).
      secondaryContainer: p.isDark ? const Color(0xFF2E4529) : const Color(0xFFD6E8CD),
      onSecondaryContainer: p.isDark ? const Color(0xFFCFE6C6) : const Color(0xFF3C4B37),
      surface: p.surface,
      onSurface: p.text,
      onSurfaceVariant: p.textMuted,
      outline: p.border,
      outlineVariant: p.divider,
      error: p.danger,
      onError: p.onDanger,
      errorContainer: p.dangerBg,
      surfaceTint: Colors.transparent,
    );

    final body = _bodyTheme(p.brightness);
    // [v2] Judul layar/bagian/dialog w700 (dulu w600) agar hierarki judul vs isi tegas.
    TextStyle heading(double size, {FontWeight weight = FontWeight.w700}) => useTelegraf
        ? TextStyle(fontFamily: 'Telegraf', fontSize: size, fontWeight: weight, color: p.text, height: 1.2)
        : _poppins(fontSize: size, fontWeight: weight, color: p.text, height: 1.25);

    final textTheme = body.copyWith(
      displaySmall: heading(KapdhFontSize.display),
      headlineSmall: heading(KapdhFontSize.h1),
      titleLarge: heading(KapdhFontSize.h2),
      titleMedium: heading(KapdhFontSize.h3, weight: FontWeight.w600),
      titleSmall: _poppins(fontSize: 15, fontWeight: FontWeight.w600, color: p.text, height: 1.3),
      bodyLarge: body.bodyLarge?.copyWith(fontSize: KapdhFontSize.bodyLg, color: p.text, height: 1.45),
      bodyMedium: body.bodyMedium?.copyWith(fontSize: KapdhFontSize.body, color: p.text, height: 1.45),
      bodySmall: body.bodySmall?.copyWith(fontSize: KapdhFontSize.caption, color: p.textMuted, height: 1.45),
      labelLarge: body.labelLarge?.copyWith(fontSize: KapdhFontSize.label, fontWeight: FontWeight.w600),
      labelMedium: body.labelMedium?.copyWith(fontSize: KapdhFontSize.caption, fontWeight: FontWeight.w500),
      labelSmall: body.labelSmall?.copyWith(fontSize: KapdhFontSize.overline, fontWeight: FontWeight.w500),
    );

    final fieldBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(KapdhRadius.md),
      borderSide: BorderSide(color: p.border),
    );

    // Cincin fokus 3 px: hijau di permukaan terang, emas di mode gelap dan di permukaan hijau (DarkSurfaceFocus).
    return KapdhFocusTheme.withRing(_base(p, scheme, textTheme, fieldBorder), p.focusRing);
  }

  static ThemeData _base(KapdhPalette p, ColorScheme scheme, TextTheme textTheme, OutlineInputBorder fieldBorder) {
    final menuShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(KapdhRadius.md),
      side: BorderSide(color: p.cardBorder),
    );
    // [v2] --shadow-md untuk semua menu (popup, dropdown, menu anchor) agar kedalaman seragam; gelap memakai hitam
    // elevation.dark seperti dialog/lembar (bayangan hijau tua nyaris tak tampak di latar gelap).
    const menuElevation = 3.0;
    final menuShadow = p.isDark ? const Color(0x5C000000) : const Color(0x3D0E280C);
    const menuPadding = WidgetStatePropertyAll(EdgeInsets.symmetric(vertical: KapdhSpace.s2));
    return ThemeData(
      useMaterial3: true,
      brightness: p.brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: p.background,
      textTheme: textTheme,
      fontFamily: _family,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      // [v2] Riak InkRipple: lebih singkat dari InkSparkle bawaan M3 (mockup: transisi 100-150 ms).
      splashFactory: InkRipple.splashFactory,
      // [v2] Tombol kembali/tutup bawaan AppBar memakai ikon Phosphor (KapdhIcons tidak punya ikon menu/laci).
      actionIconTheme: const ActionIconThemeData(
        backButtonIconBuilder: _backButtonIcon,
        closeButtonIconBuilder: _closeButtonIcon,
      ),
      extensions: [p],
      appBarTheme: AppBarTheme(
        backgroundColor: p.surface,
        foregroundColor: p.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        centerTitle: true,
        toolbarHeight: KapdhSize.appBarHeight,
        titleTextStyle: _poppins(fontSize: 17, fontWeight: FontWeight.w600, color: p.text),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
        border: fieldBorder,
        enabledBorder: fieldBorder,
        // [v2] Fokus: garis 2 px primary + halo 4 px; galat: halo merah.
        focusedBorder: KapdhHaloBorder(
          borderRadius: fieldBorder.borderRadius,
          borderSide: BorderSide(color: p.primary, width: 2),
          halo: p.shadowRingFocusField.first.color,
          haloWidth: p.shadowRingFocusField.first.spreadRadius,
        ),
        errorBorder: fieldBorder.copyWith(borderSide: BorderSide(color: p.danger)),
        focusedErrorBorder: KapdhHaloBorder(
          borderRadius: fieldBorder.borderRadius,
          borderSide: BorderSide(color: p.danger, width: 2),
          halo: p.danger.withValues(alpha: 0.16),
        ),
        disabledBorder: fieldBorder.copyWith(borderSide: BorderSide(color: p.divider)),
        hintStyle: TextStyle(color: p.textMuted, fontSize: KapdhFontSize.body),
        labelStyle: TextStyle(color: p.text, fontWeight: FontWeight.w500),
        errorStyle: TextStyle(color: p.danger, fontSize: KapdhFontSize.caption),
        // Batas atas, bukan ruang yang dicadangkan: pada 1x tampilan tidak berubah, sedangkan pada teks 200 % di layar
        // 320-390 dp kalimat helper/galat panjang tidak terpotong elipsis. Jangan null (null = satu baris + elipsis).
        errorMaxLines: 10,
        helperMaxLines: 10,
        prefixIconColor: WidgetStateColor.resolveWith(
          (states) => states.contains(WidgetState.focused) ? p.primary : p.textMuted,
        ),
        suffixIconColor: p.textMuted,
      ),
      // [v2] Transisi warna/elevasi tombol 150 ms (KapdhMotion.fast; bawaan 200 ms). withRing hanya menimpa side.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: p.primary,
          foregroundColor: p.onPrimary,
          disabledBackgroundColor: p.disabledBg,
          disabledForegroundColor: p.disabledText,
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.buttonHeight),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          textStyle: _poppins(fontWeight: FontWeight.w600, fontSize: KapdhFontSize.label),
          animationDuration: KapdhMotion.fast,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: p.primary,
          side: BorderSide(color: p.primary),
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.buttonHeight),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
          textStyle: _poppins(fontWeight: FontWeight.w600, fontSize: KapdhFontSize.label),
          animationDuration: KapdhMotion.fast,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: p.primary,
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
          textStyle: _poppins(fontWeight: FontWeight.w500, fontSize: 13),
          animationDuration: KapdhMotion.fast,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
          animationDuration: KapdhMotion.fast,
        ),
      ),
      // [v2] FAB primer radius 12; elevasi bawaan dibiarkan (bayangan kecil dipasang di widget chat). Lapisan status
      // dari onPrimary: bawaan M3 memakai onPrimaryContainer (untuk latar primaryContainer) yang nyaris tak tampak di
      // atas primary, padahal FAB chat menolkan focusElevation sehingga sorotan fokus satu-satunya penanda fokus.
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: p.primary,
        foregroundColor: p.onPrimary,
        splashColor: p.onPrimary.withValues(alpha: 0.1),
        hoverColor: p.onPrimary.withValues(alpha: 0.08),
        focusColor: p.onPrimary.withValues(alpha: 0.16),
        // [v2] Cincin fokus 3 px di luar tombol (kontras terhadap latar, bukan terhadap isi primary).
        shape: WidgetStateOutlinedBorder.resolveWith(
          (states) => RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(KapdhRadius.md),
            side: states.contains(WidgetState.focused)
                ? BorderSide(
                    color: p.focusRing,
                    width: KapdhFocusTheme.width,
                    strokeAlign: BorderSide.strokeAlignOutside,
                  )
                : BorderSide.none,
          ),
        ),
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? p.primary : null,
        ),
        checkColor: WidgetStatePropertyAll(p.onPrimary),
        side: BorderSide(color: p.border, width: 1.5),
      ),
      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? p.primary : p.border,
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? p.onPrimary : p.border,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? p.primary : p.neutral200,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? Colors.transparent : p.border,
        ),
      ),
      // [v2] Kartu: garis rambut cardBorder (dulu divider); bayangan --shadow-sm dipasang widget kartu sendiri.
      cardTheme: CardThemeData(
        color: p.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(KapdhRadius.lg),
          side: BorderSide(color: p.cardBorder),
        ),
      ),
      // [v2] Chip tidak terpilih bergaris rambut; terpilih tanpa garis.
      chipTheme: ChipThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.pill)),
        side: WidgetStateBorderSide.resolveWith(
          (states) => states.contains(WidgetState.selected) ? BorderSide.none : BorderSide(color: p.divider),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: p.tintStrong,
        elevation: 0,
        height: 64,
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(color: states.contains(WidgetState.selected) ? p.primary : p.textMuted),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontSize: KapdhFontSize.caption,
            fontWeight: states.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w400,
            color: states.contains(WidgetState.selected) ? p.primary : p.textMuted,
          ),
        ),
      ),
      // [v2] Dialog radius 24 (dulu 16), judul 20 w700 (dulu 24 w600: judul Indonesia sering 3 baris di lebar 280).
      // [v2] Dialog dan lembar memakai --shadow-lg (bawaan M3 shadowColor transparan, jadi datar).
      dialogTheme: DialogThemeData(
        backgroundColor: p.surfaceRaised,
        surfaceTintColor: Colors.transparent,
        elevation: 6,
        shadowColor: p.isDark ? const Color(0x80000000) : const Color(0x2E0E280C), // [v2] --shadow-lg
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.xl)),
        titleTextStyle: _poppins(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w700, color: p.text, height: 1.3),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: p.surfaceRaised,
        surfaceTintColor: Colors.transparent,
        elevation: 6,
        modalElevation: 6,
        shadowColor: p.isDark ? const Color(0x80000000) : const Color(0x2E0E280C), // [v2] --shadow-lg
        showDragHandle: true,
        dragHandleColor: p.border,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(KapdhRadius.xl))),
      ),
      // [v2] Menu putih bergaris rambut, radius 12 (dulu surfaceContainer radius 4).
      popupMenuTheme: PopupMenuThemeData(
        color: p.surfaceRaised,
        surfaceTintColor: Colors.transparent,
        shape: menuShape,
        elevation: menuElevation,
        shadowColor: menuShadow,
      ),
      // [v2] Dropdown dan menu anchor: bayangan --shadow-md setara popup, padding vertikal 8.
      dropdownMenuTheme: DropdownMenuThemeData(
        menuStyle: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(p.surfaceRaised),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
          shape: WidgetStatePropertyAll(menuShape),
          elevation: const WidgetStatePropertyAll(menuElevation),
          shadowColor: WidgetStatePropertyAll(menuShadow),
          padding: menuPadding,
        ),
      ),
      menuTheme: MenuThemeData(
        style: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(p.surfaceRaised),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
          shape: WidgetStatePropertyAll(menuShape),
          elevation: const WidgetStatePropertyAll(menuElevation),
          shadowColor: WidgetStatePropertyAll(menuShadow),
          padding: menuPadding,
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: p.primary, linearTrackColor: p.tintStrong),
      dividerTheme: DividerThemeData(color: p.divider, thickness: 1, space: 1),
      // [v2] Snackbar radius 12, margin 16/12 (bawaan M3 radius 4, margin 15/5).
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: KapdhColors.green950,
        contentTextStyle: _poppins(fontSize: KapdhFontSize.body, color: KapdhColors.textOnDark),
        actionTextColor: KapdhColors.accent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KapdhRadius.md)),
        insetPadding: const EdgeInsets.fromLTRB(KapdhSpace.s4, 0, KapdhSpace.s4, KapdhSpace.s3),
        elevation: 6,
      ),
      listTileTheme: ListTileThemeData(iconColor: p.textMuted),
      iconTheme: IconThemeData(color: p.text),
    );
  }
}
