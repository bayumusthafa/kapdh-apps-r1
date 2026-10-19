import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_focus.dart';
import 'package:kapdh_mobile/app/theme/kapdh_theme.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/fakes.dart';
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

  testWidgets('ringedSide: garis diam tetap, cincin 3 px saat fokus', (tester) async {
    late WidgetStateProperty<BorderSide?> side;
    await pumpDesign(
      tester,
      Builder(
        builder: (context) {
          side = KapdhFocusTheme.ringedSide(context, const BorderSide(color: KapdhColors.danger));
          return const SizedBox();
        },
      ),
    );
    expect(side.resolve(const {})!.color, KapdhColors.danger);
    final focused = side.resolve({WidgetState.focused})!;
    expect(focused.color, KapdhColors.focusRing);
    expect(focused.width, KapdhFocusTheme.width);
  });

  testWidgets('BrandIconButton: cincin emas saat difokuskan keyboard', (tester) async {
    await pumpDesign(tester, BrandIconButton(icon: KapdhIcons.notifications, tooltip: 'Notifikasi', onPressed: () {}));
    BoxDecoration ring() =>
        tester
                .widget<DecoratedBox>(
                  find
                      .descendant(of: find.byType(BrandIconButton), matching: find.byKey(KapdhFocusRing.decorationKey))
                      .first,
                )
                .decoration
            as BoxDecoration;
    expect(ring().border, isNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    final border = ring().border! as Border;
    expect(border.top.color, KapdhColors.focusRingOnDark);
    expect(border.top.width, KapdhFocusTheme.width);
  });

  testWidgets('KapdhSnackBarAction: tetap SnackBarAction, bercincin emas saat fokus, menutup snackbar', (tester) async {
    var pressed = 0;
    await pumpDesign(
      tester,
      Builder(
        builder: (context) => TextButton(
          onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: const Text('Gagal memuat'),
              action: KapdhSnackBarAction(label: 'Coba lagi', onPressed: () => pressed++),
            ),
          ),
          child: const Text('Tampilkan'),
        ),
      ),
    );
    await tester.tap(find.text('Tampilkan'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(SnackBarAction, 'Coba lagi'), findsOneWidget);
    // Tema tombol di sekitar TextButton aksi: gaya SnackBar + garis fokus emas.
    final style = TextButtonTheme.of(tester.element(find.widgetWithText(TextButton, 'Coba lagi'))).style!;
    final focused = style.side!.resolve({WidgetState.focused})!;
    expect(focused.color, KapdhColors.focusRingOnDark);
    expect(focused.width, KapdhFocusTheme.width);
    expect(style.side!.resolve(const {}), isNull);

    await tester.tap(find.text('Coba lagi'));
    await tester.pumpAndSettle();
    expect(pressed, 1);
    expect(find.text('Gagal memuat'), findsNothing);
  });

  testWidgets('KtaCard berketuk: cincin emas saat fokus keyboard, Enter membuka', (tester) async {
    var opened = 0;
    await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(cardOf()), onTap: () => opened++));
    Finder ring() => find.descendant(of: find.byType(KtaCard), matching: find.byKey(KapdhFocusRing.decorationKey));
    expect((tester.widget<DecoratedBox>(ring()).decoration as BoxDecoration).border, isNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    final border = (tester.widget<DecoratedBox>(ring()).decoration as BoxDecoration).border! as Border;
    expect(border.top.color, KapdhColors.focusRingOnDark);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opened, 1);
  });

  testWidgets('KtaCard tanpa onTap tidak dapat difokus dan tanpa lapisan cincin', (tester) async {
    await pumpDesign(tester, KtaCard(data: KtaCardData.fromMemberCard(cardOf())));
    expect(find.descendant(of: find.byType(KtaCard), matching: find.byKey(KapdhFocusRing.decorationKey)), findsNothing);
    expect(find.descendant(of: find.byType(KtaCard), matching: find.byType(InkWell)), findsNothing);
  });

  testWidgets('KapdhFocusRing: tanpa cincin pada mode sentuh, muncul saat beralih ke keyboard', (tester) async {
    addTearDown(() => FocusManager.instance.highlightStrategy = FocusHighlightStrategy.automatic);
    FocusManager.instance.highlightStrategy = FocusHighlightStrategy.alwaysTouch;
    final node = FocusNode();
    addTearDown(node.dispose);
    await pumpDesign(
      tester,
      KapdhFocusRing(
        radius: BorderRadius.circular(KapdhRadius.md),
        builder: (onFocusChange) => InkWell(
          focusNode: node,
          onTap: () {},
          onFocusChange: onFocusChange,
          child: const SizedBox.square(dimension: 48),
        ),
      ),
    );
    BoxDecoration ring() =>
        tester.widget<DecoratedBox>(find.byKey(KapdhFocusRing.decorationKey)).decoration as BoxDecoration;
    node.requestFocus();
    await tester.pump();
    expect(node.hasFocus, isTrue);
    expect(ring().border, isNull, reason: 'fokus tersisa di mode sentuh tidak menampilkan cincin');

    FocusManager.instance.highlightStrategy = FocusHighlightStrategy.alwaysTraditional;
    await tester.pump();
    expect((ring().border! as Border).top.color, KapdhColors.focusRing);
  });

  test('FAB: cincin fokus 3 px di luar tombol lewat bentuk bertingkat state', () {
    final shape = KapdhTheme.light().floatingActionButtonTheme.shape;
    final focused =
        WidgetStateProperty.resolveAs<ShapeBorder?>(shape, {WidgetState.focused})! as RoundedRectangleBorder;
    expect(focused.side.color, KapdhColors.focusRing);
    expect(focused.side.width, KapdhFocusTheme.width);
    expect(focused.side.strokeAlign, BorderSide.strokeAlignOutside);
    expect(focused.borderRadius, BorderRadius.circular(KapdhRadius.md));
    final idle = WidgetStateProperty.resolveAs<ShapeBorder?>(shape, const {})! as RoundedRectangleBorder;
    expect(idle.side, BorderSide.none);
  });
}
