import 'package:flutter/material.dart';

import '../../design/design.dart';

/// Undangan Grup (F-11): rute sudah terdaftar; isi layar dibangun pada irisan fitur berikutnya (BUILD_PLAN fase C).
class ChatInvitationsScreen extends StatelessWidget {
  const ChatInvitationsScreen({super.key});

  @override
  Widget build(BuildContext context) => const UnderConstructionScreen(
    title: 'Undangan Grup',
    feature: 'F-11',
    description: 'Undangan grup yang menunggu jawaban Anda.',
    fallbackLocation: '/network',
  );
}
