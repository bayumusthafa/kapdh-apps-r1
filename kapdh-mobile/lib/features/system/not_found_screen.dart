import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../design/design.dart';

/// Rute tidak dikenal (mis. tautan lama). Bukan galat jaringan (PRD 4.5).
class NotFoundScreen extends StatelessWidget {
  const NotFoundScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: 'Halaman tidak ditemukan',
      body: EmptyState(
        icon: Icons.search_off,
        title: 'Halaman tidak ditemukan',
        message: 'Tautan ini tidak tersedia atau sudah tidak berlaku.',
        actionLabel: 'Ke halaman utama',
        onAction: () => context.go('/'),
      ),
    );
  }
}
