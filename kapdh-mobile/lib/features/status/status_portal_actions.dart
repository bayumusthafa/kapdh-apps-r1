import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../core/api/error_presenter.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../../app/theme/kapdh_tokens.dart';

/// Tombol "Periksa status" dan "Keluar" pada portal status (PRD 2.2). Memeriksa status memuat ulang GET /me; bila
/// pengurus sudah memulihkan akun, router mengarahkan ke rute status baru.
class StatusPortalActions extends ConsumerStatefulWidget {
  const StatusPortalActions({super.key});

  @override
  ConsumerState<StatusPortalActions> createState() => _StatusPortalActionsState();
}

class _StatusPortalActionsState extends ConsumerState<StatusPortalActions> {
  bool _refreshing = false;
  bool _signingOut = false;

  Future<void> _refresh() async {
    setState(() => _refreshing = true);
    try {
      await ref.read(sessionProvider.notifier).refreshMe();
    } on ApiException catch (error) {
      unawaited(ref.read(errorPresenterProvider).present(error, onRetry: _refresh));
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> _signOut() async {
    // Keluar atas pilihan sendiri membuka login yang bersih (tanpa tujuan tertunda dari sesi sebelumnya).
    final router = GoRouter.of(context);
    setState(() => _signingOut = true);
    try {
      await ref.read(sessionProvider.notifier).logout();
      router.go(AppRoutes.login);
    } finally {
      if (mounted) setState(() => _signingOut = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        KapdhButton(
          label: 'Periksa status',
          busyLabel: 'Memeriksa...',
          busy: _refreshing,
          icon: KapdhIcons.refresh,
          onPressed: _signingOut ? null : _refresh,
        ),
        const SizedBox(height: KapdhSpace.s3),
        KapdhButton.outlined(
          label: 'Keluar',
          busyLabel: 'Keluar...',
          busy: _signingOut,
          icon: KapdhIcons.logout,
          onPressed: _refreshing ? null : _signOut,
        ),
      ],
    );
  }
}
