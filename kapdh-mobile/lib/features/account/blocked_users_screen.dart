import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Pengguna Diblokir (F-12): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class BlockedUsersScreen extends StatelessWidget {
  const BlockedUsersScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Pengguna Diblokir',
    feature: 'F-12',
    description: 'Daftar pengguna yang Anda blokir dan buka blokir.',
    fallbackLocation: '/account',
  );
}
