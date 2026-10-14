import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/cache/decoded_image_memory.dart';

void main() {
  tearDown(
    () => PaintingBinding.instance.imageCache
      ..clear()
      ..clearLiveImages(),
  );

  testWidgets('PRD 5.2, N-09: foto privat yang sudah didekode dan yang masih dimuat dibuang dari cache memori', (
    tester,
  ) async {
    final cache = PaintingBinding.instance.imageCache;
    final image = (await tester.runAsync(() => createTestImage(width: 2, height: 2)))!;
    // Foto anggota lain yang sudah tampil (AlumniAvatar / Image.network: memori saja).
    cache.putIfAbsent(
      'avatar-anggota-lain',
      () => OneFrameImageStreamCompleter(SynchronousFuture(ImageInfo(image: image))),
    );
    // Bukti bayar yang masih dimuat saat logout.
    cache.putIfAbsent('bukti-bayar', () => OneFrameImageStreamCompleter(Completer<ImageInfo>().future));
    expect(cache.currentSize, 1);
    expect(cache.pendingImageCount, 1);
    expect(cache.liveImageCount, greaterThan(0));

    evictDecodedImages();

    expect(cache.containsKey('avatar-anggota-lain'), isFalse);
    expect(cache.containsKey('bukti-bayar'), isFalse);
    expect(cache.currentSize, 0);
    expect(cache.pendingImageCount, 0);
    expect(cache.liveImageCount, 0);
  });
}
