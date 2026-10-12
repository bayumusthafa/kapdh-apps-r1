import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Hapus Akun (F-14): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class DeleteAccountScreen extends StatelessWidget {
  const DeleteAccountScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Hapus Akun',
    feature: 'F-14',
    description: 'Penjelasan retensi data (D2), konfirmasi password lalu permintaan penghapusan (POST /me/deletion).',
    fallbackLocation: '/account',
  );
}
