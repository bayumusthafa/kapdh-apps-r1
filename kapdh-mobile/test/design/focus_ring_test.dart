import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_focus.dart';
import 'package:kapdh_mobile/app/theme/kapdh_theme.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/widget_harness.dart';

/// Cincin fokus v2 (WCAG 1.4.11): hijau di permukaan terang, emas di permukaan gelap; teks nonaktif 4,5:1.
void main() {
  test('token: cincin hijau/emas dan teks nonaktif v2', () {
    expect(KapdhColors.focusRing, const Color(0xFF2D7A28));
    expect(KapdhColors.focusRingOnDark, const Color(0xFFE6D312));
    expect(KapdhColors.disabledText, const Color(0xFF5E665C));
    expect(KapdhColors.disabledBg, const Color(0xFFE1E5DE));
  });

  test('tema terang: ekstensi, sorotan InkWell dan garis 3 px tombol Material saat terfokus', () {
    final theme = KapdhTheme.light();
    expect(theme.extension<KapdhFocusTheme>()!.ring, KapdhColors.focusRing);
    expect(theme.focusColor, KapdhColors.focusRing.withValues(alpha: 0.16));
    for (final style in [
      theme.filledButtonTheme.style,
      theme.outlinedButtonTheme.style,
      theme.textButtonTheme.style,
      theme.iconButtonTheme.style,
    ]) {
      final side = style!.side!.resolve({WidgetState.focused})!;
      expect(side.color, KapdhColors.focusRing);
      expect(side.width, KapdhFocusTheme.width);
    }
    // Garis OutlinedButton saat tidak terfokus tetap primary.
    expect(theme.outlinedButtonTheme.style!.side!.resolve(const {})!.color, KapdhColors.primary);
  });

  test('permukaan gelap: cincin emas', () {
    final dark = KapdhFocusTheme.onDarkSurface(KapdhTheme.light());
    expect(dark.extension<KapdhFocusTheme>()!.ring, KapdhColors.focusRingOnDark);
    expect(dark.filledButtonTheme.style!.side!.resolve({WidgetState.focused})!.color, KapdhColors.focusRingOnDark);
  });

  BoxDecoration ringOf(WidgetTester tester, String label) =>
      tester
              .widget<DecoratedBox>(
                find
                    .descendant(
                      of: find.ancestor(of: find.text(label), matching: find.byType(KapdhButton)),
                      matching: find.byKey(const ValueKey('kapdh-button-focus')),
                    )
                    .first,
              )
              .decoration
          as BoxDecoration;

  testWidgets('KapdhButton: cincin 3 px saat difokuskan keyboard; varian gelap emas', (tester) async {
    await pumpDesign(
      tester,
      Column(
        children: [
          KapdhButton(label: 'Masuk', onPressed: () {}),
          KapdhButton.accent(label: 'Daftar', onPressed: () {}),
        ],
      ),
    );
    expect(ringOf(tester, 'Masuk').border, isNull);

    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    final first = ringOf(tester, 'Masuk').border! as Border;
    expect(first.top.color, KapdhColors.focusRing);
    expect(first.top.width, KapdhFocusTheme.width);

    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(ringOf(tester, 'Masuk').border, isNull);
    expect((ringOf(tester, 'Daftar').border! as Border).top.color, KapdhColors.focusRingOnDark);
  });

  testWidgets('KapdhButton di DarkSurfaceFocus memakai cincin emas', (tester) async {
    await pumpDesign(
      tester,
      DarkSurfaceFocus(
        child: KapdhButton(label: 'Coba lagi', onPressed: () {}),
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect((ringOf(tester, 'Coba lagi').border! as Border).top.color, KapdhColors.focusRingOnDark);
  });
}
