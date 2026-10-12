import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Laporan Saya (F-12): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class MyReportsScreen extends StatelessWidget {
  const MyReportsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Laporan Saya',
    feature: 'F-12',
    description: 'Laporan yang Anda kirim beserta statusnya.',
    fallbackLocation: '/account',
  );
}
