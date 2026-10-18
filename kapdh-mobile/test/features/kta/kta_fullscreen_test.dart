import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/kta/kta_fullscreen.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'kta_screen_test.dart' show expiresAt, openKta;

void main() {
  group('Pratinjau KTA layar penuh landscape', () {
    late List<MethodCall> calls;

    setUp(() => calls = []);

    void recordSystemChrome(WidgetTester tester) {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method.startsWith('SystemChrome.')) calls.add(call);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    }

    List<Object?> orientations() =>
        calls.where((c) => c.method == 'SystemChrome.setPreferredOrientations').map((c) => c.arguments).toList();

    testWidgets('ketuk KTA: landscape, layar penuh, kartu berproporsi KTP; tutup memulihkan orientasi', (tester) async {
      await openKta(tester, card: () => FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)));
      recordSystemChrome(tester);
      // Layar landscape perangkat setelah diputar.
      tester.view.physicalSize = const Size(800, 360);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.tap(find.byType(KtaCard));
      await settle(tester);

      expect(find.byType(KtaFullScreen), findsOneWidget);
      expect(orientations().first, ['DeviceOrientation.landscapeLeft', 'DeviceOrientation.landscapeRight']);
      expect(
        calls.any(
          (c) => c.method == 'SystemChrome.setEnabledSystemUIMode' && c.arguments == 'SystemUiMode.immersiveSticky',
        ),
        isTrue,
      );
      final size = tester.getSize(find.byKey(const ValueKey('kta-fullscreen-card')));
      expect(size.width / size.height, closeTo(85.6 / 54, 0.01));
      expect(find.descendant(of: find.byType(KtaFullScreen), matching: find.byType(QrImageView)), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.byTooltip(KtaFullScreen.closeTooltip));
      await settle(tester);
      expect(find.byType(KtaFullScreen), findsNothing);
      expect(orientations().last, isEmpty);
    });

    testWidgets('ketuk di mana saja menutup pratinjau', (tester) async {
      await openKta(tester, card: () => FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)));
      recordSystemChrome(tester);
      await tester.tap(find.byType(KtaCard));
      await settle(tester);
      await tester.tapAt(const Offset(4, 4));
      await settle(tester);
      expect(find.byType(KtaFullScreen), findsNothing);
    });

    testWidgets('KTA diumumkan sebagai tombol dengan petunjuk layar penuh', (tester) async {
      final handle = tester.ensureSemantics();
      await openKta(tester, card: () => FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)));
      expect(
        tester.getSemantics(find.byType(KtaCard)),
        isSemantics(isButton: true, hasTapAction: true, hint: 'Ketuk untuk tampilan layar penuh'),
      );
      handle.dispose();
    });
  });
}
