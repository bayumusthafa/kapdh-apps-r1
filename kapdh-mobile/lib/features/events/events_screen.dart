import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Event (F-09): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class EventsScreen extends StatelessWidget {
  const EventsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Event',
    feature: 'F-09',
    description: 'Daftar event dengan tab Semua, Reuni dan Workshop serta status pendaftaran (guideline hal. 8).',
    showBack: false,
  );
}
