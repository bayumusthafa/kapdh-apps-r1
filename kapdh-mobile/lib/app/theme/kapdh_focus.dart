import 'package:flutter/material.dart';

import 'kapdh_tokens.dart';

/// Cincin fokus keyboard/akses saklar (WCAG 1.4.11, kontras non-teks minimal 3:1; N-11). Hijau [KapdhColors.focusRing]
/// (5,4:1) di permukaan terang, emas [KapdhColors.focusRingOnDark] (6,6:1) di permukaan hijau gelap. Flutter tidak
/// menggambar outline fokus sendiri, jadi tema memasang garis 3 px pada tombol Material dan [KapdhButton] membaca
/// warna cincin dari ekstensi ini.
@immutable
class KapdhFocusTheme extends ThemeExtension<KapdhFocusTheme> {
  const KapdhFocusTheme({required this.ring});

  static const light = KapdhFocusTheme(ring: KapdhColors.focusRing);
  static const onDark = KapdhFocusTheme(ring: KapdhColors.focusRingOnDark);

  /// Tebal cincin fokus.
  static const double width = 3;

  final Color ring;

  /// Warna cincin di [context]; bawaan hijau bila tema tidak memasang ekstensi.
  static Color ringOf(BuildContext context) => Theme.of(context).extension<KapdhFocusTheme>()?.ring ?? light.ring;

  /// Tema untuk isi permukaan hijau gelap (header, Welcome, splash, pratinjau KTA): cincin dan sorotan fokus emas.
  static ThemeData onDarkSurface(ThemeData base) => withRing(base, KapdhColors.focusRingOnDark);

  /// Memasang cincin [ring] ke [base]: ekstensi, sorotan InkWell ([ThemeData.focusColor]) dan garis fokus tombol.
  static ThemeData withRing(ThemeData base, Color ring) {
    WidgetStateProperty<BorderSide?> side(BorderSide? idle) => WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.focused) ? BorderSide(color: ring, width: width) : idle,
    );
    ButtonStyle? ringed(ButtonStyle? style) =>
        (style ?? const ButtonStyle()).copyWith(side: side(style?.side?.resolve(const <WidgetState>{})));
    return base.copyWith(
      focusColor: ring.withValues(alpha: 0.16),
      extensions: [
        ...base.extensions.values.where((e) => e is! KapdhFocusTheme),
        KapdhFocusTheme(ring: ring),
      ],
      filledButtonTheme: FilledButtonThemeData(style: ringed(base.filledButtonTheme.style)),
      outlinedButtonTheme: OutlinedButtonThemeData(style: ringed(base.outlinedButtonTheme.style)),
      textButtonTheme: TextButtonThemeData(style: ringed(base.textButtonTheme.style)),
      iconButtonTheme: IconButtonThemeData(style: ringed(base.iconButtonTheme.style)),
    );
  }

  @override
  KapdhFocusTheme copyWith({Color? ring}) => KapdhFocusTheme(ring: ring ?? this.ring);

  @override
  KapdhFocusTheme lerp(KapdhFocusTheme? other, double t) =>
      other == null ? this : KapdhFocusTheme(ring: Color.lerp(ring, other.ring, t) ?? ring);
}

/// Membungkus isi permukaan hijau gelap agar kontrol di dalamnya memakai cincin fokus emas.
class DarkSurfaceFocus extends StatelessWidget {
  const DarkSurfaceFocus({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Theme(data: KapdhFocusTheme.onDarkSurface(Theme.of(context)), child: child);
}
