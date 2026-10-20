import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../support/widget_harness.dart';

/// Label aksi "process text" tiruan dari aplikasi lain yang terpasang di perangkat.
const _aksiLain = 'Aksi Aplikasi Lain';

/// Mendaftarkan satu aksi aplikasi lain lewat kanal `flutter/processtext` (Android) sebelum widget teks dibuat.
void _aksiAplikasiLain(WidgetTester tester) {
  final messenger = tester.binding.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(SystemChannels.processText, (call) async {
    if (call.method == 'ProcessText.queryTextActions') return <String, String>{'contoh.aksi.lain': _aksiLain};
    return null;
  });
  addTearDown(() => messenger.setMockMethodCallHandler(SystemChannels.processText, null));
}

/// Memilih seluruh isi [field], menampilkan menu seleksi, lalu mengembalikan tombol yang diberikan ke menu.
Future<List<ContextMenuButtonItem>> _tombolMenu(WidgetTester tester, Finder field) async {
  final editable = find.descendant(of: field, matching: find.byType(EditableText));
  await tester.tap(editable);
  await tester.pump();
  final state = tester.state<EditableTextState>(editable);
  state.userUpdateTextEditingValue(
    state.textEditingValue.copyWith(
      selection: TextSelection(baseOffset: 0, extentOffset: state.textEditingValue.text.length),
    ),
    SelectionChangedCause.longPress,
  );
  await tester.pump();
  expect(state.showToolbar(), isTrue);
  await tester.pumpAndSettle();
  final toolbar = tester.widget<AdaptiveTextSelectionToolbar>(find.byType(AdaptiveTextSelectionToolbar));
  final items = [...toolbar.buttonItems!];
  state.hideToolbar();
  await tester.pumpAndSettle();
  return items;
}

void main() {
  testWidgets('kontrol: TextField tanpa contextMenuBuilder menampilkan aksi aplikasi lain dari perangkat', (
    tester,
  ) async {
    _aksiAplikasiLain(tester);
    final controller = TextEditingController(text: 'ahmad.islam@contoh.test');
    addTearDown(controller.dispose);
    await pumpDesign(tester, TextField(key: const ValueKey('kontrol'), controller: controller));
    await tester.pump();

    final items = await _tombolMenu(tester, find.byKey(const ValueKey('kontrol')));
    expect(items.map((item) => item.label), contains(_aksiLain));
  });

  testWidgets('KapdhTextField dan SelectableText: menu seleksi tanpa aksi aplikasi lain, tombol bawaan tetap ada', (
    tester,
  ) async {
    _aksiAplikasiLain(tester);
    final controller = TextEditingController(text: 'ahmad.islam@contoh.test');
    addTearDown(controller.dispose);
    await pumpDesign(
      tester,
      Column(
        children: [
          KapdhTextField(key: const ValueKey('email'), label: 'Email', controller: controller),
          const SelectableText('Kode galat 7f3a', key: ValueKey('catatan'), contextMenuBuilder: kapdhTextContextMenu),
        ],
      ),
    );
    await tester.pump();
    final field = await _tombolMenu(tester, find.byKey(const ValueKey('email')));
    expect(field.map((item) => item.label), isNot(contains(_aksiLain)));
    expect(field.map((item) => item.type), isNot(contains(ContextMenuButtonType.custom)));
    expect(field.map((item) => item.type), containsAll([ContextMenuButtonType.cut, ContextMenuButtonType.copy]));

    final note = await _tombolMenu(tester, find.byKey(const ValueKey('catatan')));
    expect(note.map((item) => item.label), isNot(contains(_aksiLain)));
    expect(note.map((item) => item.type), contains(ContextMenuButtonType.copy));
  });

  test('kapdhContextMenuItems hanya membuang tombol custom', () {
    void noop() {}
    final items = kapdhContextMenuItems([
      ContextMenuButtonItem(onPressed: noop, type: ContextMenuButtonType.copy),
      ContextMenuButtonItem(onPressed: noop, label: _aksiLain),
      ContextMenuButtonItem(onPressed: noop, type: ContextMenuButtonType.share),
    ]);
    expect(items.map((item) => item.type), [ContextMenuButtonType.copy, ContextMenuButtonType.share]);
  });

  test('setiap TextField, TextFormField dan SelectableText di lib/ memakai kapdhTextContextMenu', () {
    final widget = RegExp(r'\b(TextField|TextFormField|SelectableText)\(');
    final missing = <String>[];
    var checked = 0;
    for (final file in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!file.path.endsWith('.dart')) continue;
      final source = file.readAsStringSync();
      for (final match in widget.allMatches(source)) {
        final lineStart = source.lastIndexOf('\n', match.start) + 1;
        if (source.substring(lineStart, match.start).trimLeft().startsWith('//')) continue;
        // Argumen konstruktor sampai kurung penutup yang sepadan.
        var depth = 0;
        var end = match.end - 1;
        for (; end < source.length; end++) {
          final char = source[end];
          if (char == '(') depth++;
          if (char == ')' && --depth == 0) break;
        }
        checked++;
        if (!source.substring(match.end, end).contains('contextMenuBuilder: kapdhTextContextMenu')) {
          final line = '\n'.allMatches(source.substring(0, match.start)).length + 1;
          missing.add('${file.path}:$line ${match.group(1)}');
        }
      }
    }
    expect(checked, greaterThan(0));
    expect(missing, isEmpty, reason: 'pasang contextMenuBuilder: kapdhTextContextMenu');
  });
}
