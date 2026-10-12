import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Status Pembayaran (F-03): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class PaymentDetailScreen extends StatelessWidget {
  const PaymentDetailScreen({super.key, required this.paymentId});

  /// Parameter rute `paymentId`.
  final String paymentId;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Status Pembayaran',
    feature: 'F-03',
    description:
        'Menunggu verifikasi, perlu perbaikan dengan catatan pengurus, atau lunas beserta riwayat (prototipe layar 4, 5).',
    fallbackLocation: '/payments',
  );
}
