import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Biaya KTA (F-03): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class OnboardingFeesScreen extends StatelessWidget {
  const OnboardingFeesScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Biaya KTA',
    feature: 'F-03',
    description:
        'Rincian iuran pendaftaran dan KTA ringkas berstatus Tidak Aktif (prototipe layar 2), lalu lanjut ke pembayaran.',
    showBack: false,
  );
}
