// Penopang uji irisan Beranda, Berita, Event dan Tiket: aplikasi lengkap (router, redirect, sesi asli) dengan
// gambar jaringan diganti gambar memori dan sesi anggota dengan status tertentu.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/features/home/shared/remote_image.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../../support/widget_harness.dart' show prototypeSize;

/// PNG transparan 1×1 untuk menggantikan gambar jaringan (cover, banner, avatar) di uji.
final Uint8List transparentPng = Uint8List.fromList(const [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, //
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, //
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, //
  0x42, 0x60, 0x82,
]);

/// URL gambar yang diminta layar (memastikan hanya http(s) yang dimuat).
final List<String> requestedImages = [];

Override get testImagesOverride => remoteImageProviderFactoryProvider.overrideWithValue((url) {
  requestedImages.add(url);
  return MemoryImage(transparentPng);
});

/// Menjalankan aplikasi dengan sesi anggota [status] (GET /me) lalu membuka [location] (push di atas rute awal
/// status agar tombol kembali bekerja seperti dari Beranda). [settled] false: frame dipompa tanpa menunggu tenang
/// (untuk memeriksa keadaan memuat selagi request ditahan). [overrides] menambah pengganti provider (mis. aliran
/// realtime tiruan). [size] layar uji (dp), dipasang sebelum frame pertama.
Future<AppHarness> pumpMemberApp(
  WidgetTester tester, {
  Map<String, FakeHandler> routes = const {},
  String status = 'verified',
  String? location,
  bool push = true,
  SecureStore? store,
  TestClock? clock,
  double textScale = 1,
  Size size = prototypeSize,
  Map<String, Object?>? config,
  bool settled = true,
  List<Override> overrides = const [],
}) async {
  requestedImages.clear();
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    store: store,
    clock: clock,
    textScale: textScale,
    size: size,
    settle: settled,
    overrides: [testImagesOverride, ...overrides],
    handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: status)), ...routes}, config: config),
  );
  if (!settled) await pumpFrames(tester);
  if (location != null) {
    if (push) {
      unawaited(app.router.push(location));
    } else {
      app.router.go(location);
    }
    if (settled) {
      await settle(tester);
    } else {
      await pumpFrames(tester);
    }
  }
  return app;
}

/// Query string request terakhir ke [path].
Map<String, dynamic> lastQuery(AppHarness app, String path) => app.adapter.requestsTo(path).last.queryParameters;

/// Menggulir daftar malas (ListView) sampai [finder] dibangun dan terlihat. [scrollable] bawaan: daftar vertikal
/// pertama di layar teratas.
Future<void> scrollUntil(WidgetTester tester, Finder finder, {Finder? scrollable, double delta = 200}) async {
  await tester.scrollUntilVisible(
    finder,
    delta,
    scrollable:
        scrollable ??
        find.byWidgetPredicate((widget) => widget is Scrollable && widget.axisDirection == AxisDirection.down).first,
  );
  await settle(tester);
}

/// Memompa beberapa frame tanpa menunggu tenang (kerangka memuat beranimasi terus sehingga pumpAndSettle tidak
/// pernah selesai selama request ditahan).
Future<void> pumpFrames(WidgetTester tester, {int count = 40}) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}
