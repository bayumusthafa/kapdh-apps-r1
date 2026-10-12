import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Detail Event (F-09): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class EventDetailScreen extends StatelessWidget {
  const EventDetailScreen({super.key, required this.eventId});

  /// Parameter rute `eventId`.
  final String eventId;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Detail Event',
    feature: 'F-09',
    description: 'Detail event, kuota peserta dan reservasi satu kursi per anggota (D5).',
    fallbackLocation: '/events',
  );
}
