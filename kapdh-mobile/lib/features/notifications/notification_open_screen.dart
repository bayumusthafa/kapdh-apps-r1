import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../design/design.dart';
import 'notification_presentation.dart';
import 'notification_unread_count.dart';
import 'notifications_repository.dart';

/// Gerbang ketukan notifikasi push `/notifications/<id>` (AC F13-3, F13-5).
///
/// Redirect router memastikan pengguna masuk lebih dulu (tanpa sesi: login lalu kembali ke sini). Setelah itu
/// GET /notifications/{id} memastikan notifikasi milik akun yang sedang masuk: notifikasi akun sebelumnya di
/// perangkat yang sama menghasilkan 404 dan objeknya tidak pernah dibuka. Tujuan diambil dari `deep_link` resmi
/// server (bukan dari payload push), lalu redirect memeriksa status keanggotaan terkini dan endpoint objek memeriksa
/// izin di server (PRD 2.1).
class NotificationOpenScreen extends ConsumerStatefulWidget {
  const NotificationOpenScreen({super.key, required this.notificationId});

  final String notificationId;

  @override
  ConsumerState<NotificationOpenScreen> createState() => _NotificationOpenScreenState();
}

class _NotificationOpenScreenState extends ConsumerState<NotificationOpenScreen> {
  ApiException? _error;
  bool _notFound = false;

  @override
  void initState() {
    super.initState();
    unawaited(_resolve());
  }

  Future<void> _resolve() async {
    setState(() {
      _error = null;
      _notFound = false;
    });
    final repo = ref.read(notificationsRepositoryProvider);
    final InboxNotification notification;
    try {
      notification = await repo.get(widget.notificationId);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        // 404 (milik akun lain atau tidak ada) dan id tidak sah (400) tidak dibedakan (N-09).
        if (error.code == ErrorCode.notFound || error.code == ErrorCode.validationError) {
          _notFound = true;
        } else {
          _error = error;
        }
      });
      return;
    }
    if (notification.readAt == null) {
      // Tanda dibaca bukan syarat membuka tujuan (mis. ditolak saat pemeliharaan).
      unawaited(
        repo.markRead([notification.id]).then((result) {
          if (mounted) ref.read(notificationUnreadCountProvider.notifier).set(result.unreadCount);
        }, onError: (Object _) {}),
      );
    }
    if (!mounted) return;
    final target = notificationTarget(notification.deepLink) ?? Uri(path: AppRoutes.notifications);
    openNotificationTarget(context, target, replace: true);
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
    return AppScaffold(
      title: 'Notifikasi',
      fallbackLocation: AppRoutes.notifications,
      body: _notFound
          ? EmptyState(
              icon: KapdhIcons.notificationsOffOutlined,
              title: 'Notifikasi tidak tersedia',
              message:
                  'Notifikasi ini bukan milik akun yang sedang masuk atau sudah tidak tersedia. Isinya tidak dibuka '
                  'demi keamanan akun.',
              actionLabel: 'Buka kotak masuk',
              onAction: () => context.go(AppRoutes.notifications),
            )
          : error != null
          ? ErrorState.fromException(error, onRetry: _resolve)
          : const LoadingSkeleton(showCard: false, lines: 2, semanticsLabel: 'Membuka notifikasi'),
    );
  }
}
