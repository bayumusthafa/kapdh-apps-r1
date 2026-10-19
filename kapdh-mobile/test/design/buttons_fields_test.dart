import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/widget_harness.dart';

/// Latar tombol (DecoratedBox selain lapisan cincin fokus `kapdh-button-focus`).
final _buttonSurface = find.byWidgetPredicate(
  (w) => w is DecoratedBox && w.key != const ValueKey('kapdh-button-focus'),
);

/// [KapdhButton] yang memuat teks [label].
Finder _buttonOf(String label) => find.ancestor(of: find.text(label), matching: find.byType(KapdhButton));

/// Memompa [body] sebagai isi Scaffold pada layar selebar [width] dp.
Future<void> _pumpAtWidth(WidgetTester tester, double width, Widget body, {double textScale = 2}) async {
  usePhoneSize(tester, size: Size(width, 800));
  await tester.pumpWidget(designHarness(Scaffold(body: body), textScale: textScale, scaffold: false));
}

/// Tombol [label] tidak meluap: tidak ada galat tata letak, tombol dan labelnya di dalam layar selebar [width],
/// tinggi minimal 48, dan tetap dapat diketuk.
Future<void> _expectButtonFits(WidgetTester tester, String label, double width) async {
  expect(tester.takeException(), isNull);
  final button = tester.getRect(_buttonOf(label));
  final text = tester.getRect(find.text(label));
  expect(button.left, greaterThanOrEqualTo(0));
  expect(button.right, lessThanOrEqualTo(width));
  expect(text.left, greaterThanOrEqualTo(button.left));
  expect(text.right, lessThanOrEqualTo(button.right));
  expect(button.height, greaterThanOrEqualTo(48));
  expect(text.top, greaterThanOrEqualTo(button.top));
  expect(text.bottom, lessThanOrEqualTo(button.bottom));
  await tester.tap(find.text(label));
}

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

  group('KapdhButton lebar intrinsik di lebar terbatas (teks 200 %, N-11)', () {
    for (final width in [320.0, 360.0]) {
      testWidgets('EmptyState "Muat ulang" tidak meluap di $width dp', (tester) async {
        var taps = 0;
        // Seperti Beranda: daftar berpadding 20 di kiri-kanan.
        await _pumpAtWidth(
          tester,
          width,
          ListView(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5),
            children: [EmptyState(title: 'Belum ada kabar terbaru', actionLabel: 'Muat ulang', onAction: () => taps++)],
          ),
        );
        await _expectButtonFits(tester, 'Muat ulang', width);
        expect(taps, 1);
      });

      testWidgets('ErrorState "Coba lagi" tidak meluap di $width dp', (tester) async {
        var taps = 0;
        await _pumpAtWidth(
          tester,
          width,
          ListView(
            children: [
              ErrorState(title: 'Tidak ada koneksi', message: 'Periksa koneksi internet.', onRetry: () => taps++),
            ],
          ),
        );
        await _expectButtonFits(tester, 'Coba lagi', width);
        expect(taps, 1);
      });

      testWidgets('KapdhButton berikon langsung di lebar terbatas tidak meluap di $width dp', (tester) async {
        await _pumpAtWidth(
          tester,
          width,
          Padding(
            padding: const EdgeInsets.all(KapdhSpace.s5),
            child: Align(
              alignment: Alignment.topCenter,
              child: KapdhButton.solid(
                label: 'Lanjut ke pembayaran',
                icon: KapdhIcons.refresh,
                onPressed: () {},
                expand: false,
              ),
            ),
          ),
        );
        await _expectButtonFits(tester, 'Lanjut ke pembayaran', width);
      });
    }

    testWidgets('teks normal: lebar tetap selebar isi dan label satu baris', (tester) async {
      await _pumpAtWidth(
        tester,
        390,
        Column(
          children: [
            EmptyState(title: 'Kosong', actionLabel: 'Muat ulang', onAction: () {}),
            ErrorState(title: 'Galat', message: 'Coba beberapa saat lagi.', onRetry: () {}),
          ],
        ),
        textScale: 1,
      );
      // Padding mendatar 16 + 16; ikon 20 dan jarak 8 bila ada.
      final reload = tester.getSize(_buttonOf('Muat ulang'));
      expect(reload.width, tester.getSize(find.text('Muat ulang')).width + 32);
      expect(reload.height, 48);
      final retry = tester.getSize(_buttonOf('Coba lagi'));
      expect(retry.width, tester.getSize(find.text('Coba lagi')).width + 20 + 8 + 32);
      expect(retry.height, 48);
    });

    testWidgets('di dalam Row tanpa batas lebar tetap satu baris selebar isi', (tester) async {
      await _pumpAtWidth(
        tester,
        390,
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              KapdhButton.outlined(label: 'Muat ulang', icon: KapdhIcons.refresh, onPressed: () {}, expand: false),
            ],
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      final text = tester.getSize(find.text('Muat ulang'));
      // Satu baris teks 14 px pada skala 2 (dua baris setidaknya 56 px).
      expect(text.height, lessThan(14 * 2 * 2));
      expect(tester.getSize(_buttonOf('Muat ulang')).width, text.width + 20 + 8 + 32);
    });

    for (final scale in [1.0, 2.0]) {
      testWidgets('aksi AlertDialog (mengukur lebar intrinsik) tidak galat pada teks ${scale * 100} %', (tester) async {
        var taps = 0;
        await _pumpAtWidth(
          tester,
          360,
          AlertDialog(
            title: const Text('Konfirmasi identitas'),
            actions: [
              TextButton(onPressed: () {}, child: const Text('Batal')),
              KapdhButton.solid(label: 'Konfirmasi', onPressed: () => taps++, expand: false),
            ],
          ),
          textScale: scale,
        );
        await _expectButtonFits(tester, 'Konfirmasi', 360);
        expect(taps, 1);
        if (scale == 1) {
          expect(tester.getSize(_buttonOf('Konfirmasi')).width, tester.getSize(find.text('Konfirmasi')).width + 32);
        }
      });
    }

    testWidgets('tombol sibuk (indikator + label) di aksi AlertDialog tidak meluap di 320 dp', (tester) async {
      // Seperti reauth_dialog saat memeriksa password: indikator 18 dan jarak 8 ikut di Row.
      await _pumpAtWidth(
        tester,
        320,
        AlertDialog(
          title: const Text('Konfirmasi identitas'),
          actions: [
            KapdhButton.solid(
              label: 'Konfirmasi',
              busyLabel: 'Memeriksa...',
              busy: true,
              onPressed: () {},
              expand: false,
            ),
          ],
        ),
      );
      await _expectButtonFits(tester, 'Memeriksa...', 320);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(
        tester.getSemantics(find.text('Memeriksa...')),
        matchesSemantics(isButton: true, hasEnabledState: true, label: 'Memeriksa...'),
      );
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
