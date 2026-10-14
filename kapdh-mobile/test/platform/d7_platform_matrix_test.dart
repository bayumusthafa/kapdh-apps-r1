// N-12 (PRD 2.4): versi OS minimum dikunci D7 (disahkan PRD v3.5: Android 8.0+, iOS 15+). Uji ini menjaga konfigurasi
// build tetap sama dengan matriks perangkat di docs/qa/device-matrix.md: menaikkan minimum tanpa mengubah D7 akan
// mengeluarkan perangkat anggota yang dijanjikan didukung, menurunkannya membuka OS yang tidak pernah diuji.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String _read(String path) => File(path).readAsStringSync();

void main() {
  group('N-12, D7: versi OS minimum', () {
    test('Android 8.0 (API 26)', () {
      final gradle = _read('android/app/build.gradle.kts');
      final minSdk = RegExp(r'^\s*minSdk\s*=\s*(\S+)', multiLine: true).allMatches(gradle).toList();
      expect(minSdk, hasLength(1), reason: 'satu minSdk eksplisit, bukan flutter.minSdkVersion');
      expect(minSdk.single.group(1), '26');
    });

    test('iOS 15.0 di Podfile dan semua konfigurasi build Runner', () {
      expect(_read('ios/Podfile'), contains("platform :ios, '15.0'"));
      final targets = RegExp(
        r'IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);',
      ).allMatches(_read('ios/Runner.xcodeproj/project.pbxproj')).map((match) => match.group(1)).toList();
      expect(targets, isNotEmpty);
      expect(targets.toSet(), {'15.0'});
    });
  });
}
