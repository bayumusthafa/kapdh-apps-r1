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

  /// Garis tombol bergaris yang tetap bercincin saat fokus. Dipakai sebagai `styleFrom(...).copyWith(side: ...)` bila
  /// widget harus menimpa `side`, karena side di tingkat widget selalu menang atas side bertingkat-fokus dari tema.
  /// [ring] bawaan [ringOf] (hijau, atau emas di [DarkSurfaceFocus]).
  static WidgetStateProperty<BorderSide?> ringedSide(BuildContext context, BorderSide idle, {Color? ring}) {
    final c = ring ?? ringOf(context);
    return WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.focused) ? BorderSide(color: c, width: width) : idle,
    );
  }

  @override
  KapdhFocusTheme copyWith({Color? ring}) => KapdhFocusTheme(ring: ring ?? this.ring);

  @override
  KapdhFocusTheme lerp(KapdhFocusTheme? other, double t) =>
      other == null ? this : KapdhFocusTheme(ring: Color.lerp(ring, other.ring, t) ?? ring);
}

/// Cincin fokus 3 px di atas kontrol kustom (InkWell) saat terfokus keyboard/akses saklar (WCAG 1.4.11); tidak
/// mengubah tata letak. [builder] menerima callback untuk `InkWell.onFocusChange`. [ring] bawaan
/// [KapdhFocusTheme.ringOf] (hijau, atau emas di dalam [DarkSurfaceFocus]). Seperti sorotan fokus InkWell, cincin
/// hanya tampil pada mode sorotan keyboard ([FocusHighlightMode.traditional]): fokus yang tersisa setelah pengguna
/// beralih ke sentuhan tidak menyisakan cincin.
class KapdhFocusRing extends StatefulWidget {
  const KapdhFocusRing({super.key, required this.radius, required this.builder, this.ring});

  /// Kunci lapisan cincin (DecoratedBox foreground), untuk uji.
  static const decorationKey = ValueKey('kapdh-button-focus');

  final BorderRadius radius;
  final Color? ring;
  final Widget Function(ValueChanged<bool> onFocusChange) builder;

  @override
  State<KapdhFocusRing> createState() => _KapdhFocusRingState();
}

class _KapdhFocusRingState extends State<KapdhFocusRing> {
  bool _focused = false;
  bool _keyboard = FocusManager.instance.highlightMode == FocusHighlightMode.traditional;

  @override
  void initState() {
    super.initState();
    FocusManager.instance.addHighlightModeListener(_onHighlightMode);
  }

  @override
  void dispose() {
    FocusManager.instance.removeHighlightModeListener(_onHighlightMode);
    super.dispose();
  }

  void _onHighlightMode(FocusHighlightMode mode) {
    final keyboard = mode == FocusHighlightMode.traditional;
    if (mounted && keyboard != _keyboard) setState(() => _keyboard = keyboard);
  }

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: KapdhFocusRing.decorationKey,
    position: DecorationPosition.foreground,
    decoration: _focused && _keyboard
        ? BoxDecoration(
            border: Border.all(color: widget.ring ?? KapdhFocusTheme.ringOf(context), width: KapdhFocusTheme.width),
            borderRadius: widget.radius,
          )
        : const BoxDecoration(),
    child: widget.builder((focused) {
      if (mounted && focused != _focused) setState(() => _focused = focused);
    }),
  );
}

/// Membungkus isi permukaan hijau gelap agar kontrol di dalamnya memakai cincin fokus emas.
class DarkSurfaceFocus extends StatelessWidget {
  const DarkSurfaceFocus({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Theme(data: KapdhFocusTheme.onDarkSurface(Theme.of(context)), child: child);
}
