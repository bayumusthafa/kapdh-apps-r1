import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/widget_harness.dart';

/// Latar tombol (DecoratedBox selain lapisan cincin fokus `kapdh-button-focus`).
final _buttonSurface = find.byWidgetPredicate(
  (w) => w is DecoratedBox && w.key != const ValueKey('kapdh-button-focus'),
);

void main() {
  group('KapdhButton', () {
    testWidgets('utama: gradasi hijau, tinggi minimum 52 px, dapat diketuk', (tester) async {
      var taps = 0;
      await pumpDesign(tester, KapdhButton(label: 'Verifikasi', onPressed: () => taps++));

      expect(tester.getSize(find.byType(KapdhButton)).height, greaterThanOrEqualTo(52));
      final box = tester.widget<DecoratedBox>(
        find.descendant(of: find.byType(KapdhButton), matching: _buttonSurface).first,
      );
      expect((box.decoration as BoxDecoration).gradient, KapdhGradients.buttonPrimary);
      await tester.tap(find.text('Verifikasi'));
      expect(taps, 1);
    });

    testWidgets('nonaktif: abu-abu tanpa gradasi dan semantics enabled=false', (tester) async {
      await pumpDesign(tester, const KapdhButton(label: 'Masuk', onPressed: null));
      final box = tester.widget<DecoratedBox>(
        find.descendant(of: find.byType(KapdhButton), matching: _buttonSurface).first,
      );
      expect((box.decoration as BoxDecoration).color, KapdhColors.disabledBg);
      expect(
        tester.getSemantics(find.text('Masuk')),
        matchesSemantics(isButton: true, hasEnabledState: true, label: 'Masuk'),
      );
    });

    testWidgets('sibuk: label proses, indikator, tidak dapat diketuk', (tester) async {
      var taps = 0;
      await pumpDesign(
        tester,
        KapdhButton(label: 'Kirim', busyLabel: 'Mengirim...', busy: true, onPressed: () => taps++),
      );
      expect(find.text('Mengirim...'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.text('Mengirim...'));
      expect(taps, 0);
    });

    testWidgets('varian garis dan polos minimal 48 px; tidak meluap pada teks 200 %', (tester) async {
      await pumpDesign(
        tester,
        Column(
          children: [
            KapdhButton.outlined(label: 'Ganti bukti', onPressed: () {}),
            KapdhButton.solid(label: 'Ke Beranda', onPressed: () {}),
            Row(
              children: [KapdhButton.solid(label: 'Bayar', onPressed: () {}, expand: false)],
            ),
          ],
        ),
        textScale: 2,
      );
      for (final finder in [find.text('Ganti bukti'), find.text('Ke Beranda'), find.text('Bayar')]) {
        expect(
          tester.getSize(find.ancestor(of: finder, matching: find.byType(KapdhButton))).height,
          greaterThanOrEqualTo(48),
        );
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('permukaan gelap: emas 52 px dan garis putih 48 px, nonaktif abu-abu', (tester) async {
      var taps = 0;
      await pumpDesign(
        tester,
        Column(
          children: [
            KapdhButton.accent(label: 'Daftar KAPDH Apps', onPressed: () => taps++),
            KapdhButton.outlinedOnDark(label: 'Sudah Punya Akun? Masuk', onPressed: () => taps++),
            const KapdhButton.accent(label: 'Nonaktif', onPressed: null),
          ],
        ),
      );
      BoxDecoration decorationOf(String label) =>
          tester
                  .widget<DecoratedBox>(
                    find
                        .descendant(
                          of: find.ancestor(of: find.text(label), matching: find.byType(KapdhButton)),
                          matching: _buttonSurface,
                        )
                        .first,
                  )
                  .decoration
              as BoxDecoration;

      expect(decorationOf('Daftar KAPDH Apps').color, KapdhColors.accent);
      expect(decorationOf('Nonaktif').color, KapdhColors.disabledBg);
      expect(decorationOf('Sudah Punya Akun? Masuk').border, isNotNull);
      expect(
        tester.getSize(find.ancestor(of: find.text('Daftar KAPDH Apps'), matching: find.byType(KapdhButton))).height,
        greaterThanOrEqualTo(52),
      );
      expect(
        tester
            .getSize(find.ancestor(of: find.text('Sudah Punya Akun? Masuk'), matching: find.byType(KapdhButton)))
            .height,
        greaterThanOrEqualTo(48),
      );
      await tester.tap(find.text('Daftar KAPDH Apps'));
      await tester.tap(find.text('Sudah Punya Akun? Masuk'));
      await tester.tap(find.text('Nonaktif'));
      expect(taps, 2);
    });
  });

  group('KapdhTextField', () {
    testWidgets('label di atas field, galat server dan penghitung', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpDesign(
        tester,
        KapdhTextField(
          label: 'Email',
          controller: controller,
          hint: 'Masukkan Email',
          prefixIcon: KapdhIcons.mailOutline,
          errorText: 'Email sudah terdaftar',
          trailingText: '0/72',
        ),
      );
      final label = tester.getRect(find.text('Email'));
      final field = tester.getRect(find.byType(TextFormField));
      expect(label.bottom, lessThanOrEqualTo(field.top));
      expect(find.text('Email sudah terdaftar'), findsOneWidget);
      expect(find.text('0/72'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^Email')), findsWidgets);

      await tester.enterText(find.byType(TextFormField), 'a@kapdh.test');
      expect(controller.text, 'a@kapdh.test');
    });

    testWidgets('password dapat ditampilkan/disembunyikan dengan tombol bertooltip', (tester) async {
      await pumpDesign(tester, const KapdhTextField(label: 'Password', obscurable: true));
      EditableText editable() => tester.widget<EditableText>(find.byType(EditableText));
      expect(editable().obscureText, isTrue);
      await tester.tap(find.byTooltip('Tampilkan password'));
      await tester.pump();
      expect(editable().obscureText, isFalse);
      expect(find.byTooltip('Sembunyikan password'), findsOneWidget);
    });

    testWidgets('dropdown berlabel di atas dengan validasi', (tester) async {
      final form = GlobalKey<FormState>();
      await pumpDesign(
        tester,
        Form(
          key: form,
          child: KapdhDropdownField<int>(
            label: 'Angkatan',
            hint: 'Pilih angkatan',
            value: null,
            items: const [DropdownMenuItem(value: 29, child: Text('Angkatan 29'))],
            onChanged: (_) {},
            validator: (v) => v == null ? 'Pilih angkatan' : null,
          ),
        ),
      );
      expect(find.text('Pilih angkatan'), findsOneWidget);
      form.currentState!.validate();
      await tester.pump();
      expect(find.text('Pilih angkatan'), findsNWidgets(2));
    });
  });

  testWidgets('KapdhLinkButton target sentuh minimal 48 px', (tester) async {
    await pumpDesign(tester, KapdhLinkButton(label: 'Hubungi pengurus', onPressed: () {}));
    expect(tester.getSize(find.byType(TextButton)).height, greaterThanOrEqualTo(48));
  });
}
