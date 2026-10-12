import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Ganti Password (F-02): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ChangePasswordScreen extends StatelessWidget {
  const ChangePasswordScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Ganti Password',
    feature: 'F-02',
    description: 'Ganti password dengan password lama; sesi lain dicabut.',
    fallbackLocation: '/account',
  );
}
