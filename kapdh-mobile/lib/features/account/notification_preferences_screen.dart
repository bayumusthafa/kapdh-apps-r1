import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Preferensi Notifikasi (F-13): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class NotificationPreferencesScreen extends StatelessWidget {
  const NotificationPreferencesScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Preferensi Notifikasi',
    feature: 'F-13',
    description: 'Kategori push dan email; notifikasi keamanan dan akun selalu aktif.',
    fallbackLocation: '/account',
  );
}
