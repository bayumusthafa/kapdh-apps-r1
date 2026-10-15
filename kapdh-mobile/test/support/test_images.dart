import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

/// PNG transparan 1×1 pengganti gambar jaringan di uji.
final Uint8List onePixelPng = Uint8List.fromList(const [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, //
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, //
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, //
  0x42, 0x60, 0x82,
]);

/// Gambar jaringan tiruan yang gagal pada [failures] pemuatan pertama (mis. koneksi putus) lalu berhasil. Setiap
/// pemuatan dicatat di [loads]; instans dengan [url] yang sama berbagi kunci cache seperti gambar jaringan asli.
class FlakyImage extends ImageProvider<FlakyImage> {
  FlakyImage(this.url, {required this.loads, this.failures = 1});

  final String url;
  final List<String> loads;
  final int failures;

  @override
  Future<FlakyImage> obtainKey(ImageConfiguration configuration) => SynchronousFuture(this);

  @override
  ImageStreamCompleter loadImage(FlakyImage key, ImageDecoderCallback decode) {
    loads.add(url);
    if (loads.length <= failures) {
      return OneFrameImageStreamCompleter(Future<ImageInfo>.error(StateError('Gambar gagal dimuat (uji): $url')));
    }
    return MultiFrameImageStreamCompleter(codec: _decode(decode), scale: 1);
  }

  Future<ui.Codec> _decode(ImageDecoderCallback decode) async =>
      decode(await ui.ImmutableBuffer.fromUint8List(onePixelPng));

  @override
  bool operator ==(Object other) => other is FlakyImage && other.url == url;

  @override
  int get hashCode => url.hashCode;
}
