import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/widget_harness.dart';

Color borderOfBox(WidgetTester tester, int index) {
  final containers = tester
      .widgetList<Container>(find.descendant(of: find.byType(OtpBoxes), matching: find.byType(Container)))
      .where((c) => c.decoration is BoxDecoration && (c.decoration! as BoxDecoration).border != null)
      .toList();
  final border = (containers[index].decoration! as BoxDecoration).border! as Border;
  return border.top.color;
}

void main() {
  group('OtpBoxes (prototipe layar 1)', () {
    testWidgets('enam kotak; ketik digit mengisi kotak dan memanggil onCompleted', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      String? completed;
      await pumpDesign(tester, OtpBoxes(controller: controller, onCompleted: (code) => completed = code));

      expect(borderOfBox(tester, 0), KapdhColors.border);
      await tester.enterText(find.byKey(const ValueKey('otp-input')), '482');
      await tester.pump();
      expect(find.text('4'), findsOneWidget);
      expect(find.text('8'), findsOneWidget);
      expect(borderOfBox(tester, 0), KapdhColors.primary);
      expect(completed, isNull);

      await tester.enterText(find.byKey(const ValueKey('otp-input')), '482913');
      await tester.pump();
      expect(completed, '482913');
    });

    Opacity caretOpacity(WidgetTester tester) => tester.widget<Opacity>(
      find.ancestor(
        of: find.byWidgetPredicate(
          (w) => w is Container && w.constraints == const BoxConstraints.tightFor(width: 2, height: 24),
        ),
        matching: find.byType(Opacity),
      ),
    );

    testWidgets('kursor kotak aktif berkedip 500 ms (mockup kapdh-caret 1 s steps(1))', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpDesign(tester, OtpBoxes(controller: controller, autofocus: true));
      await tester.pumpAndSettle();
      expect(caretOpacity(tester).opacity, 1);
      await tester.pump(const Duration(milliseconds: 500));
      expect(caretOpacity(tester).opacity, 0);
      await tester.pump(const Duration(milliseconds: 500));
      expect(caretOpacity(tester).opacity, 1);
    });

    testWidgets('kursor statis bila reduce motion', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpDesign(
        tester,
        Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: OtpBoxes(controller: controller, autofocus: true),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (var i = 0; i < 3; i++) {
        await tester.pump(const Duration(milliseconds: 500));
        expect(caretOpacity(tester).opacity, 1);
      }
    });

    testWidgets('tempel teks berisi kode: hanya digit, maksimal enam', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpDesign(tester, OtpBoxes(controller: controller));
      await tester.enterText(find.byKey(const ValueKey('otp-input')), 'Kode Anda: 482 913 77');
      await tester.pump();
      expect(controller.text, '482913');
    });

    test('formatter OTP', () {
      const formatter = OtpInputFormatter(6);
      final result = formatter.formatEditUpdate(TextEditingValue.empty, const TextEditingValue(text: 'a1b2c3d4e5f6g7'));
      expect(result.text, '123456');
      expect(result.selection, const TextSelection.collapsed(offset: 6));
    });

    test('formatter: tempelan kode lengkap mengganti isi lama', () {
      const formatter = OtpInputFormatter(6);
      TextEditingValue paste(String old, String inserted) => formatter.formatEditUpdate(
        TextEditingValue(
          text: old,
          selection: TextSelection.collapsed(offset: old.length),
        ),
        TextEditingValue(text: old + inserted),
      );
      expect(paste('111111', '482913').text, '482913');
      expect(paste('12', 'Kode: 482 913').text, '482913');
      // Ketikan biasa tetap disisipkan.
      expect(paste('12', '3').text, '123');
      expect(paste('', '482913').text, '482913');
    });

    group('tombol Tempel kode', () {
      void mockClipboard(WidgetTester tester, String? text) {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.getData') return text == null ? null : <String, Object?>{'text': text};
          return null;
        });
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null),
        );
      }

      testWidgets('mengisi kotak dari papan klip dan memanggil onCompleted', (tester) async {
        mockClipboard(tester, 'Kode verifikasi KAPDH Anda: 482 913');
        final controller = TextEditingController(text: '11');
        addTearDown(controller.dispose);
        String? completed;
        final changes = <String>[];
        await pumpDesign(
          tester,
          OtpBoxes(controller: controller, onChanged: changes.add, onCompleted: (code) => completed = code),
        );
        await tester.tap(find.text(OtpBoxes.pasteLabel));
        await tester.pump();
        expect(controller.text, '482913');
        expect(changes, ['482913']);
        expect(completed, '482913');
        expect(find.text('4'), findsOneWidget);
      });

      testWidgets('papan klip tanpa angka: pesan, isi tidak berubah', (tester) async {
        mockClipboard(tester, 'halo');
        final controller = TextEditingController(text: '12');
        addTearDown(controller.dispose);
        await pumpDesign(tester, OtpBoxes(controller: controller));
        await tester.tap(find.text(OtpBoxes.pasteLabel));
        await tester.pump();
        expect(controller.text, '12');
        expect(find.text(OtpBoxes.pasteEmptyMessage), findsOneWidget);
      });

      testWidgets('nonaktif saat kotak nonaktif; dapat disembunyikan', (tester) async {
        final controller = TextEditingController();
        addTearDown(controller.dispose);
        await pumpDesign(tester, OtpBoxes(controller: controller, enabled: false));
        final button = tester.widget<TextButton>(
          find.descendant(of: find.byKey(const ValueKey('otp-paste')), matching: find.byType(TextButton)),
        );
        expect(button.onPressed, isNull);
        await pumpDesign(tester, OtpBoxes(controller: controller, showPasteButton: false));
        expect(find.text(OtpBoxes.pasteLabel), findsNothing);
      });

      testWidgets('target sentuh minimal 48 px', (tester) async {
        final controller = TextEditingController();
        addTearDown(controller.dispose);
        await pumpDesign(tester, OtpBoxes(controller: controller));
        expect(tester.getSize(find.byKey(const ValueKey('otp-paste'))).height, greaterThanOrEqualTo(48));
      });
    });

    testWidgets('keadaan galat: semua kotak merah dan pesan tampil', (tester) async {
      final controller = TextEditingController(text: '12');
      addTearDown(controller.dispose);
      await pumpDesign(tester, OtpBoxes(controller: controller, errorText: 'Kode salah. Sisa percobaan 3.'));
      for (var i = 0; i < 6; i++) {
        expect(borderOfBox(tester, i), KapdhColors.danger);
      }
      expect(find.text('Kode salah. Sisa percobaan 3.'), findsOneWidget);
    });

    testWidgets('galat melekat pada field dan diumumkan sebagai live region (N-11)', (tester) async {
      final handle = tester.ensureSemantics();
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpDesign(tester, OtpBoxes(controller: controller));
      expect(find.bySemanticsLabel(RegExp('Kode OTP 6 digit')), findsOneWidget);

      await pumpDesign(tester, OtpBoxes(controller: controller, errorText: 'Kode salah. Sisa percobaan 3.'));
      await tester.pump();
      final field = tester.getSemantics(find.bySemanticsLabel(RegExp('Kode OTP 6 digit')));
      expect(field.hint, 'Kode salah. Sisa percobaan 3.');
      final error = tester.getSemantics(find.text('Kode salah. Sisa percobaan 3.'));
      expect(error.flagsCollection.isLiveRegion, isTrue);
      handle.dispose();
    });

    testWidgets('kotak aktif bergaris primary dengan halo saat fokus (v2, dulu emas)', (tester) async {
      final controller = TextEditingController(text: '48');
      addTearDown(controller.dispose);
      await pumpDesign(tester, OtpBoxes(controller: controller, autofocus: true));
      await tester.pump();
      expect(borderOfBox(tester, 2), KapdhColors.primary);
    });

    testWidgets('berlabel untuk pembaca layar dan tidak meluap pada teks 200 %', (tester) async {
      final controller = TextEditingController(text: '482913');
      addTearDown(controller.dispose);
      await pumpDesign(tester, OtpBoxes(controller: controller), textScale: 2);
      expect(find.bySemanticsLabel(RegExp('Kode OTP 6 digit')), findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byType(OtpBoxes)).height, greaterThan(56));
    });
  });

  group('RegisterStepper', () {
    testWidgets('langkah selesai bercentang, langkah aktif diumumkan', (tester) async {
      await pumpDesign(tester, const RegisterStepper(current: 1));
      expect(find.byIcon(KapdhIcons.check), findsOneWidget);
      expect(find.bySemanticsLabel('Langkah 2 dari 4: OTP'), findsOneWidget);
      for (final label in ['Data Diri', 'OTP', 'Biaya KTA', 'Pembayaran']) {
        expect(find.text(label), findsOneWidget);
      }
    });

    testWidgets('versi ringkas dan teks 200 % tanpa meluap', (tester) async {
      await pumpDesign(tester, const RegisterStepper(current: 3, compact: true), textScale: 2);
      expect(find.byIcon(KapdhIcons.check), findsNWidgets(3));
      expect(tester.takeException(), isNull);
    });
  });
}
