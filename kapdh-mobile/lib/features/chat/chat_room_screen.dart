import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Percakapan (F-11): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ChatRoomScreen extends StatelessWidget {
  const ChatRoomScreen({super.key, required this.roomId});

  /// Parameter rute `roomId`.
  final String roomId;

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Percakapan',
    feature: 'F-11',
    description: 'Riwayat pesan keyset, kirim pesan (maks 4.000 karakter), status kirim dan pembaruan realtime.',
    fallbackLocation: '/network',
  );
}
