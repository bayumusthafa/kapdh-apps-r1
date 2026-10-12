import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Informasi (F-08): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class LegalPageScreen extends StatelessWidget {
  const LegalPageScreen({super.key, required this.slug});

  /// Parameter rute `slug`.
  final String slug;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Informasi',
    feature: 'F-08',
    description:
        'Halaman legal dan informasi terbit (GET /public/pages/{slug}); terbuka untuk semua status dan sebelum login.',
    fallbackLocation: '/',
  );
}
