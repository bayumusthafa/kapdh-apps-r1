import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Detail Berita (F-08): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NewsDetailScreen extends StatelessWidget {
  const NewsDetailScreen({super.key, required this.slug});

  /// Parameter rute `slug`.
  final String slug;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Detail Berita',
    feature: 'F-08',
    description: 'Isi berita (HTML tersanitasi server) dan like idempoten (AC F08-3).',
    fallbackLocation: '/news',
  );
}
