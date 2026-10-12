import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Info Percakapan (F-11, F-12): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ChatInfoScreen extends StatelessWidget {
  const ChatInfoScreen({super.key, required this.roomId});

  /// Parameter rute `roomId`.
  final String roomId;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Info Percakapan',
    feature: 'F-11, F-12',
    description: 'Anggota grup, undangan, keluar grup, blokir dan laporan.',
    fallbackLocation: '/network',
  );
}
