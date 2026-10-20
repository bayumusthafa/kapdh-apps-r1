import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/app_licenses.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('lisensi Phosphor dan Poppins terdaftar sekali dengan teks dari aset bundel (THIRD_PARTY_NOTICES.md)', () async {
    // Binding uji tidak memuat NOTICES, jadi registri hanya berisi entri aplikasi. Pemanggilan ulang tidak menggandakan.
    registerAppLicenses();
    registerAppLicenses();
    final entries = await LicenseRegistry.licenses.toList();
    expect(entries.map((entry) => entry.packages), [
      ['Phosphor Icons'],
      ['Poppins'],
    ]);

    String text(int index) => entries[index].paragraphs.map((paragraph) => paragraph.text).join('\n');
    expect(text(0), allOf(contains('MIT License'), contains('Copyright (c) 2020-2021 Phosphor Icons')));
    expect(
      text(1),
      allOf(
        contains('Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)'),
        contains('SIL OPEN FONT LICENSE Version 1.1'),
        contains('Reserved Font Name'),
      ),
    );
  });
}
