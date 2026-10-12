import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Beranda (F-08): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Beranda',
    feature: 'F-08',
    description:
        'Banner aktif, event mendatang dan berita terbaru (GET /home) dengan keadaan kosong, galat dan waktu cache (AC F08-4).',
    showBack: false,
  );
}
