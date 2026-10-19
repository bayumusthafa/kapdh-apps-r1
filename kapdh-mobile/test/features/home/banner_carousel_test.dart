// Ukuran ubin banner Beranda: gambar banner 1760 x 800 px (2,2:1, docs/konten/konten-peluncuran.md) harus tampil
// utuh. Dulu tinggi karosel dihitung dari lebar LAYAR, padahal Beranda memberi padding samping s5, sehingga ubin
// lebih pendek dari 2,2:1 (sekitar 1,95:1 pada layar 360 dp) dan BoxFit.cover memotong sisi kiri-kanan gambar.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/app/theme/kapdh_tokens.dart';
import 'package:kapdh_mobile/features/home/shared/remote_image.dart';
import 'package:kapdh_mobile/features/home/widgets/banner_carousel.dart';

import '../../support/fakes.dart';
import '../../support/test_images.dart';
import '../../support/widget_harness.dart';
import 'content_fixtures.dart';
import 'feature_harness.dart';

/// Lebar layar uji (dp): ponsel kecil, Android umum, prototipe, Android besar, dan tablet kecil.
const _screenWidths = [320.0, 360.0, 390.0, 412.0, 600.0];

final _banners = [
  HomeBanner.fromJson(bannerJson()),
  HomeBanner.fromJson(bannerJson(id: 'banner-2', title: 'Iuran dan KTA')),
];

/// Karosel di dalam ListView berpadding samping s5, sama seperti Beranda.
Widget _paddedCarousel() => ProviderScope(
  overrides: [remoteImageProviderFactoryProvider.overrideWithValue((url) => MemoryImage(onePixelPng))],
  child: MaterialApp(
    home: Scaffold(
      body: ListView(
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: KapdhSpace.s4),
        children: [BannerCarousel(banners: _banners)],
      ),
    ),
  ),
);

/// Lebar ubin yang diharapkan: lebar karosel x 0,92 dikurangi padding s1 kiri-kanan tiap halaman.
double _expectedTileWidth(double carouselWidth) => carouselWidth * bannerViewportFraction - 2 * KapdhSpace.s1;

/// Memeriksa setiap ubin banner yang dibangun: tepat 2,2:1 dan gambarnya tetap BoxFit.cover.
void _expectTiles(WidgetTester tester, {required double carouselWidth}) {
  final images = find.descendant(of: find.byKey(const ValueKey('home-banners')), matching: find.byType(RemoteImage));
  expect(images, findsWidgets);
  for (var i = 0; i < images.evaluate().length; i++) {
    final finder = images.at(i);
    final size = tester.getSize(finder);
    expect(size.width, closeTo(_expectedTileWidth(carouselWidth), 0.01), reason: 'lebar ubin pada $carouselWidth');
    expect(size.width / size.height, closeTo(bannerAspectRatio, 0.01), reason: 'rasio ubin pada $carouselWidth');
    expect(tester.widget<RemoteImage>(finder).fit, BoxFit.cover);
    final image = find.descendant(of: finder, matching: find.byType(Image));
    expect(image, findsOneWidget);
    expect(tester.widget<Image>(image).fit, BoxFit.cover);
  }
}

void main() {
  group('Karosel banner Beranda: ubin tepat 2,2:1 (gambar 1760 x 800 tidak terpotong kiri-kanan)', () {
    for (final width in _screenWidths) {
      testWidgets('layar ${width.toInt()} dp dengan padding samping s5', (tester) async {
        usePhoneSize(tester, size: Size(width, 800));
        await tester.pumpWidget(_paddedCarousel());
        await tester.pumpAndSettle();
        _expectTiles(tester, carouselWidth: width - 2 * KapdhSpace.s5);
      });
    }

    testWidgets('Beranda asli pada layar 360 dp memakai lebar setelah padding, bukan lebar layar', (tester) async {
      final home = homeJson(
        banners: [
          bannerJson(),
          bannerJson(id: 'banner-2'),
        ],
      );
      await pumpMemberApp(tester, size: const Size(360, 780), routes: {'/home': (_) => FakeResponse.json(200, home)});
      final carouselWidth = tester.getSize(find.byKey(const ValueKey('home-banners'))).width;
      expect(carouselWidth, closeTo(360 - 2 * KapdhSpace.s5, 0.01));
      _expectTiles(tester, carouselWidth: carouselWidth);
    });
  });
}
