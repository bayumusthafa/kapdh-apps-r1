import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Jejaring (F-10, F-11): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NetworkScreen extends StatelessWidget {
  const NetworkScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Jejaring',
    feature: 'F-10, F-11',
    description:
        'Tab Alumni, Pesan dan Grup: direktori anggota aktif yang menghormati privasi serta daftar percakapan (guideline hal. 7).',
    showBack: false,
  );
}
