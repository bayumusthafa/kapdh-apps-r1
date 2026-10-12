import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Tiket Saya (F-09): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class TicketsScreen extends StatelessWidget {
  const TicketsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Tiket Saya',
    feature: 'F-09',
    description: 'Tiket milik sendiri; tiket lunas tetap tampil untuk anggota kedaluwarsa (PRD 2.2).',
    fallbackLocation: '/account',
  );
}
