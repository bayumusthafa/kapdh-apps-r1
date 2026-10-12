import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Profil (F-10): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ProfileEditScreen extends StatelessWidget {
  const ProfileEditScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Profil',
    feature: 'F-10',
    description: 'Ubah kota, telepon, profesi, keahlian dan foto profil (PATCH /me/profile dengan If-Match).',
    fallbackLocation: '/account',
  );
}
