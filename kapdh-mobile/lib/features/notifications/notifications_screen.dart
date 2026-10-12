import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Notifikasi (F-13): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Notifikasi',
    feature: 'F-13',
    description: 'Kotak masuk resmi dengan tanda baca dan tautan ke objek terkait (GET /notifications).',
    fallbackLocation: '/home',
  );
}
