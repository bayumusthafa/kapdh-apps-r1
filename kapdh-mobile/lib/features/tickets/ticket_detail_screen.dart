import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Detail Tiket (F-09): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class TicketDetailScreen extends StatelessWidget {
  const TicketDetailScreen({super.key, required this.ticketId});

  /// Parameter rute `ticketId`.
  final String ticketId;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Detail Tiket',
    feature: 'F-09',
    description: 'QR tiket, batas waktu pembayaran dan pembatalan sesuai aturan D6.',
    fallbackLocation: '/tickets',
  );
}
