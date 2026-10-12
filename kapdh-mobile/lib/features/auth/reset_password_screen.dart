import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Password Baru (F-02): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ResetPasswordScreen extends StatelessWidget {
  const ResetPasswordScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Password Baru',
    feature: 'F-02',
    description: 'Simpan password baru dengan token reset; seluruh sesi dicabut (AC F02-4).',
    fallbackLocation: '/login',
  );
}
