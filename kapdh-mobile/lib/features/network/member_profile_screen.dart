import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Profil Alumni (F-10): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class MemberProfileScreen extends StatelessWidget {
  const MemberProfileScreen({super.key, required this.userId});

  /// Parameter rute `userId`.
  final String userId;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Profil Alumni',
    feature: 'F-10',
    description: 'Profil anggota dengan field yang diizinkan pemiliknya dan tombol Kirim Pesan.',
    fallbackLocation: '/network',
  );
}
