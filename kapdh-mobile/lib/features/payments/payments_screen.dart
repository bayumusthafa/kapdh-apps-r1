import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Riwayat Pembayaran (F-03, F-04): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class PaymentsScreen extends StatelessWidget {
  const PaymentsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Riwayat Pembayaran',
    feature: 'F-03, F-04',
    description: 'Daftar pembayaran milik sendiri beserta status dan riwayat keputusan pengurus.',
    fallbackLocation: '/account',
  );
}
