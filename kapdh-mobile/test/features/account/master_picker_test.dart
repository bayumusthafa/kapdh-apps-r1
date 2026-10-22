import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/account/widgets/master_picker.dart';

import '../../support/widget_harness.dart';

/// Lembar "Pilih profesi" dan "Pilih keahlian" pada layar kecil, teks besar dan keyboard terbuka (N-11): bagian atas
/// lembar tidak boleh menghimpit daftar, baris "Tambah …" dan tombol simpan.
void main() {
  final professions = [
    for (final (i, label) in ['Guru', 'Dokter', 'Petani/Peternak/Nelayan', 'Pedagang', 'Wiraswasta'].indexed)
      MasterItem(id: 'p-$i', label: label),
  ];
  final skills = [for (var i = 1; i <= 12; i++) MasterItem(id: 's-$i', label: 'Keahlian $i')];

  Finder byKey(String key) => find.byKey(ValueKey(key));

  /// Kotak cari, termasuk saat tergulir keluar layar (bagian atas lembar ikut tergulir bersama daftar).
  final search = find.byKey(const ValueKey('master-search'), skipOffstage: false);

  Future<void> typeSearch(WidgetTester tester, String text) async {
    await tester.ensureVisible(search);
    await tester.pumpAndSettle();
    await tester.enterText(search, text);
    await tester.pumpAndSettle();
  }

  /// Memasang layar [size] dengan skala teks [textScale] dan keyboard setinggi [keyboard], lalu membuka lembar lewat
  /// [show] dari tombol uji.
  Future<void> openSheet(
    WidgetTester tester,
    void Function(BuildContext context) show, {
    required Size size,
    required double textScale,
    double keyboard = 0,
  }) async {
    usePhoneSize(tester, size: size);
    if (keyboard > 0) {
      tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
      addTearDown(tester.view.resetViewInsets);
    }
    await tester.pumpWidget(
      designHarness(
        Builder(
          builder: (context) => TextButton(onPressed: () => show(context), child: const Text('Buka lembar')),
        ),
        textScale: textScale,
      ),
    );
    await tester.tap(find.text('Buka lembar'));
    await tester.pumpAndSettle();
  }

  for (final (size, textScale, keyboard) in [
    (const Size(360, 640), 2.0, 0.0),
    (const Size(360, 640), 1.3, 280.0),
    (const Size(390, 844), 2.0, 300.0),
  ]) {
    final screen = '${size.width.toInt()}x${size.height.toInt()}';
    final scale = '${(textScale * 100).round()} %';
    final withKeyboard = keyboard > 0 ? ' dengan keyboard ${keyboard.toInt()}' : '';
    testWidgets('N-11: Pilih profesi $screen teks $scale$withKeyboard: tidak meluap; daftar, "Tambah …" dan Simpan '
        'pilihan terjangkau', (tester) async {
      Future<List<String>?>? picked;
      await openSheet(
        tester,
        (context) => picked = showProfessionsPicker(context, load: () async => professions, selected: const []),
        size: size,
        textScale: textScale,
        keyboard: keyboard,
      );
      expect(tester.takeException(), isNull);
      // Tanpa keyboard master langsung terlihat; dengan keyboard master tetap dapat dicapai dengan menggulir.
      if (keyboard == 0) expect(byKey('master-p-0').hitTestable(), findsOneWidget);
      await tester.ensureVisible(byKey('master-p-0'));
      await tester.pumpAndSettle();
      expect(byKey('master-p-0').hitTestable(), findsOneWidget);

      // Ketik sendiri: "Tambah …" tampil tepat di bawah kotak cari dan dapat diketuk tanpa menggulir lagi.
      await typeSearch(tester, 'Penulis Lepas');
      expect(tester.takeException(), isNull);
      expect(byKey('profession-add-typed').hitTestable(), findsOneWidget);
      await tester.tap(byKey('profession-add-typed'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Dipilih 1 dari maksimal 5', skipOffstage: false), findsOneWidget);
      // Pilihan pertama ditandai sebagai profesi utama pada barisnya.
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('profession-own-Penulis Lepas'), skipOffstage: false),
          matching: find.text('Profesi utama', skipOffstage: false),
        ),
        findsOneWidget,
      );

      // Tombol simpan tetap terlihat di atas keyboard.
      expect(byKey('master-done').hitTestable(), findsOneWidget);
      expect(tester.getBottomLeft(byKey('master-done')).dy, lessThanOrEqualTo(size.height - keyboard));
      await tester.tap(byKey('master-done'));
      await tester.pumpAndSettle();
      expect(await picked, ['Penulis Lepas']);
      expect(tester.takeException(), isNull);
    });
  }

  for (final (size, textScale, keyboard) in [(const Size(360, 640), 2.0, 0.0), (const Size(360, 640), 1.3, 280.0)]) {
    final withKeyboard = keyboard > 0 ? ' dengan keyboard ${keyboard.toInt()}' : '';
    testWidgets('N-11: Pilih keahlian 360x640 teks ${(textScale * 100).round()} %$withKeyboard tetap memuat daftar '
        'dan tombol simpan', (tester) async {
      Future<List<MasterItem>?>? picked;
      await openSheet(
        tester,
        (context) => picked = showSkillsPicker(context, load: () async => skills, selected: const []),
        size: size,
        textScale: textScale,
        keyboard: keyboard,
      );
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(byKey('master-s-1'));
      await tester.pumpAndSettle();
      expect(byKey('master-s-1').hitTestable(), findsOneWidget);
      await tester.tap(byKey('master-s-1'));
      await tester.pumpAndSettle();
      await typeSearch(tester, 'Keahlian 12');
      await tester.ensureVisible(byKey('master-s-12'));
      await tester.pumpAndSettle();
      await tester.tap(byKey('master-s-12'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(byKey('master-done').hitTestable(), findsOneWidget);
      await tester.tap(byKey('master-done'));
      await tester.pumpAndSettle();
      expect([for (final item in (await picked)!) item.id], ['s-1', 's-12']);
    });
  }

  testWidgets('galat memuat daftar di 360x640 teks 200 %: Coba lagi terjangkau tanpa meluap, lalu daftar tampil', (
    tester,
  ) async {
    var calls = 0;
    await openSheet(
      tester,
      (context) => showProfessionsPicker(
        context,
        load: () async {
          calls++;
          if (calls == 1) throw const ApiException(kind: ApiFailureKind.network, operationId: 'listMasters');
          return professions;
        },
        selected: const [],
      ),
      size: const Size(360, 640),
      textScale: 2,
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    // Selama daftar belum termuat, ketikan sendiri belum ditawarkan.
    await typeSearch(tester, 'Penulis Lepas');
    expect(byKey('profession-add-typed'), findsNothing);
    await tester.ensureVisible(find.text('Coba lagi'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Coba lagi'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(byKey('profession-add-typed').hitTestable(), findsOneWidget);
  });
}
