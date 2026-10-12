import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Privasi (F-10): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class PrivacySettingsScreen extends StatelessWidget {
  const PrivacySettingsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Privasi',
    feature: 'F-10',
    description: 'Tampil di direktori, nomor telepon dan media sosial; bawaan tersembunyi (N-15).',
    fallbackLocation: '/account',
  );
}
