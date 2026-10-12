import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_theme.dart';

/// Ukuran layar prototipe (390 × 844, prototipe layar 1 sampai 7).
const prototypeSize = Size(390, 844);

/// Mengatur ukuran layar uji dan mengembalikannya setelah uji.
void usePhoneSize(WidgetTester tester, {Size size = prototypeSize}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

/// Membungkus [child] dengan tema KAPDH, locale Indonesia dan skala teks [textScale] (N-11: uji 200 %).
Widget designHarness(Widget child, {double textScale = 1, bool scaffold = true}) {
  return MaterialApp(
    theme: KapdhTheme.light(),
    locale: const Locale('id'),
    supportedLocales: const [Locale('id')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    builder: (context, app) => MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
      child: app!,
    ),
    home: scaffold
        ? Scaffold(
            body: SingleChildScrollView(padding: const EdgeInsets.all(20), child: child),
          )
        : child,
  );
}

/// Memompa widget design system pada ukuran layar prototipe.
Future<void> pumpDesign(WidgetTester tester, Widget child, {double textScale = 1, bool scaffold = true}) async {
  usePhoneSize(tester);
  await tester.pumpWidget(designHarness(child, textScale: textScale, scaffold: scaffold));
}

/// Memompa layar dengan kontainer Riverpod uji.
Future<void> pumpScreen(WidgetTester tester, ProviderContainer container, Widget screen, {double textScale = 1}) async {
  usePhoneSize(tester);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: designHarness(screen, textScale: textScale, scaffold: false),
    ),
  );
}
