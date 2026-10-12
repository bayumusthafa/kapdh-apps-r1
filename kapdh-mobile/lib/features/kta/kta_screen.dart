import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Kartu Tanda Anggota (F-05): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class KtaScreen extends StatelessWidget {
  const KtaScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Kartu Tanda Anggota',
    feature: 'F-05',
    description:
        'KTA aktif, tidak aktif atau offline dengan QR bertanda tangan server dan cache 7 hari (prototipe layar 6, 7; AC F05-2 sampai F05-4).',
    showBack: false,
  );
}
