import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Perpanjang KTA (F-07): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class RenewalScreen extends StatelessWidget {
  const RenewalScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Perpanjang KTA',
    feature: 'F-07',
    description: 'Masa keanggotaan, kelayakan perpanjangan dan iuran perpanjangan (GET /me/membership).',
    fallbackLocation: '/kta',
  );
}
