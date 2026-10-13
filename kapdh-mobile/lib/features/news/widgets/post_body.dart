import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_widget_from_html_core/flutter_widget_from_html_core.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../home/shared/links.dart';
import '../../home/shared/remote_image.dart';

/// Isi berita: HTML yang sudah disanitasi server (PRD 3.8; hanya tag teks dasar, tanpa script/style/iframe). Klien
/// tidak menjalankan skrip dan hanya memuat gambar http(s). Tautan bertanda `data-external="true"` diberi ikon dan
/// label "tautan luar" serta konfirmasi sebelum meninggalkan aplikasi; tautan aplikasi KAPDH dibuka di dalam
/// aplikasi (PRD 3.8 "tautan luar diberi indikasi yang jelas").
class PostBody extends ConsumerWidget {
  const PostBody({super.key, required this.html});

  final String html;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final images = ref.watch(remoteImageProviderFactoryProvider);
    return HtmlWidget(
      html,
      textStyle: const TextStyle(fontSize: 15, height: 1.6, color: KapdhColors.text),
      factoryBuilder: () => _ContentWidgetFactory(images),
      customStylesBuilder: (element) => switch (element.localName) {
        'a' => {'color': '#1A4B17', 'text-decoration': 'underline', 'font-weight': '600'},
        'blockquote' => {
          'border-left': '3px solid #3F9A38',
          'padding-left': '12px',
          'margin': '8px 0',
          'color': '#3F4A3E',
        },
        'h2' || 'h3' || 'h4' => {'color': '#1A4B17'},
        _ => null,
      },
      customWidgetBuilder: (element) {
        if (element.localName != 'a' || element.attributes['data-external'] != 'true') return null;
        final href = element.attributes['href'];
        final text = element.text.trim();
        if (href == null || text.isEmpty) return null;
        return InlineCustomWidget(
          child: _ExternalAnchor(text: text, onTap: () => unawaited(openContentLink(context, ref, href))),
        );
      },
      onTapUrl: (url) => openContentLink(context, ref, url),
    );
  }
}

class _ContentWidgetFactory extends WidgetFactory {
  _ContentWidgetFactory(this._images);

  final RemoteImageProviderFactory _images;

  @override
  ImageProvider? imageProviderFromNetwork(String url) {
    final uri = remoteImageUri(url);
    return uri == null ? null : _images(uri.toString());
  }
}

/// Tautan luar di dalam isi berita: teks bergaris bawah + ikon panah keluar; dibacakan "`teks`, tautan luar".
class _ExternalAnchor extends StatelessWidget {
  const _ExternalAnchor({required this.text, required this.onTap});

  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      link: true,
      label: '$text, tautan luar',
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(text: text),
              const WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: Padding(
                  padding: EdgeInsets.only(left: 2),
                  child: ExternalLinkMark(size: 14),
                ),
              ),
            ],
          ),
          style: const TextStyle(
            fontSize: 15,
            height: 1.6,
            color: KapdhColors.primary,
            fontWeight: FontWeight.w600,
            decoration: TextDecoration.underline,
          ),
        ),
      ),
    );
  }
}
