import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Lupa Password (F-02): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ForgotPasswordScreen extends StatelessWidget {
  const ForgotPasswordScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Lupa Password',
    feature: 'F-02',
    description:
        'Minta kode pemulihan ke email terdaftar (POST /auth/password/forgot). Jawaban selalu sama agar tidak mengungkap email terdaftar (PRD 2.5).',
    fallbackLocation: '/login',
  );
}
