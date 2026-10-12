import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Grup Baru (F-11): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NewGroupScreen extends StatelessWidget {
  const NewGroupScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Grup Baru',
    feature: 'F-11',
    description: 'Buat grup (maks 100 anggota) dan undang anggota aktif.',
    fallbackLocation: '/network',
  );
}
