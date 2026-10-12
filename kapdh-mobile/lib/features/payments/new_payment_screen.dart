import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Pembayaran (F-03, F-07): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NewPaymentScreen extends StatelessWidget {
  const NewPaymentScreen({super.key, required this.type});

  /// Parameter rute `type`.
  final String type;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Pembayaran',
    feature: 'F-03, F-07',
    description:
        'Nominal transfer, pilihan rekening tujuan dan unggah bukti dengan Idempotency-Key (prototipe layar 3; AC F03-4).',
    fallbackLocation: '/home',
  );
}
