import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Verifikasi Pemulihan (F-02): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ForgotOtpScreen extends StatelessWidget {
  const ForgotOtpScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Verifikasi Pemulihan',
    feature: 'F-02',
    description: 'Masukkan kode OTP pemulihan untuk memperoleh token reset sekali pakai (purpose password_reset).',
    fallbackLocation: '/forgot',
  );
}
