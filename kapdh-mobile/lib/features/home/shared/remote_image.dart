import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/kapdh_tokens.dart';

/// Pembuat [ImageProvider] untuk gambar dari server (cover berita/event, banner, avatar peserta).
typedef RemoteImageProviderFactory = ImageProvider<Object> Function(String url);

/// Produksi memakai cache disk (cached_network_image, ARCHITECTURE §8.1) agar Beranda yang dibuka dari cache saat
/// offline tetap bergambar bila gambarnya pernah dimuat (AC F08-4). Uji menggantinya dengan gambar memori.
final remoteImageProviderFactoryProvider = Provider<RemoteImageProviderFactory>(
  (ref) =>
      (url) => CachedNetworkImageProvider(url),
);

/// URL gambar yang boleh dimuat: hanya http(s) dengan host. Server sudah memproses dan menyajikan gambar (N-10);
/// skema lain (data:, file:, javascript:) tidak pernah dimuat dari payload.
Uri? remoteImageUri(String? url) {
  if (url == null || url.trim().isEmpty) return null;
  final uri = Uri.tryParse(url.trim());
  if (uri == null || !uri.hasAuthority) return null;
  return uri.scheme == 'https' || uri.scheme == 'http' ? uri : null;
}

/// Gambar jaringan dengan tempat kosong yang rapi saat URL kosong, memuat, atau gagal dimuat (N-03). Label
/// [semanticLabel] dibacakan pembaca layar; tanpa label gambar dianggap dekoratif (N-11).
class RemoteImage extends ConsumerWidget {
  const RemoteImage({
    super.key,
    required this.url,
    this.semanticLabel,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.borderRadius = BorderRadius.zero,
    this.placeholderIcon = Icons.image_outlined,
  });

  final String? url;
  final String? semanticLabel;
  final double? width;
  final double? height;
  final BoxFit fit;
  final BorderRadius borderRadius;
  final IconData placeholderIcon;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final uri = remoteImageUri(url);
    final placeholder = _Placeholder(icon: placeholderIcon, width: width, height: height);
    Widget child;
    if (uri == null) {
      child = semanticLabel == null
          ? placeholder
          : Semantics(image: true, label: semanticLabel, child: ExcludeSemantics(child: placeholder));
    } else {
      child = Image(
        image: ref.watch(remoteImageProviderFactoryProvider)(uri.toString()),
        width: width,
        height: height,
        fit: fit,
        semanticLabel: semanticLabel,
        excludeFromSemantics: semanticLabel == null,
        gaplessPlayback: true,
        frameBuilder: (context, image, frame, wasSynchronouslyLoaded) {
          if (wasSynchronouslyLoaded || frame != null) return image;
          return placeholder;
        },
        errorBuilder: (context, error, stackTrace) => placeholder,
      );
    }
    return ClipRRect(borderRadius: borderRadius, child: child);
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.icon, this.width, this.height});

  final IconData icon;
  final double? width;
  final double? height;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      color: KapdhColors.green50,
      alignment: Alignment.center,
      child: Icon(icon, color: KapdhColors.green600, size: 28),
    );
  }
}
