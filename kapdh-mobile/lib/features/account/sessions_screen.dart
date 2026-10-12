import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Sesi Perangkat (F-02): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class SessionsScreen extends StatelessWidget {
  const SessionsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Sesi Perangkat',
    feature: 'F-02',
    description: 'Daftar sesi aktif, cabut sesi dan keluar dari semua perangkat (AC F02-6).',
    fallbackLocation: '/account',
  );
}
