import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Berita (F-08): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NewsListScreen extends StatelessWidget {
  const NewsListScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Berita',
    feature: 'F-08',
    description: 'Daftar berita terbit per kategori (GET /posts).',
    fallbackLocation: '/home',
  );
}
