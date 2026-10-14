import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_services.dart';
import '../../core/realtime/connection_transitions.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import 'notifications_repository.dart';

/// Jumlah notifikasi belum dibaca untuk lencana (lonceng Beranda, menu Akun, portal pembatasan; F-13). Null bila
/// belum diketahui (tanpa sesi, offline, atau belum dimuat). Event realtime `notification.created` membawa jumlah
/// terbaru; GET /notifications/unread-count dipakai saat sesi aktif dimulai, setiap kali realtime tersambung
/// (kembali), dan saat [NotificationUnreadCountController.refresh] dipanggil, mis. ketika aplikasi kembali ke latar
/// depan (kontrak C7 getNotificationUnreadCount; ARCHITECTURE §4.9).
final notificationUnreadCountProvider = NotifierProvider<NotificationUnreadCountController, int?>(
  NotificationUnreadCountController.new,
);

class NotificationUnreadCountController extends Notifier<int?> {
  @override
  int? build() {
    final key = ref.watch(sessionProvider.select((s) => s.phase == SessionPhase.authenticated ? s.userId : null));
    if (key == null) return null;
    final events = ref.watch(notificationCreatedEventsProvider).listen((payload) => state = payload.unreadCount);
    ref.onDispose(() => unawaited(events.cancel()));

    // Event yang terbit selama soket terputus (latar belakang, jaringan putus) tidak diputar ulang server, jadi
    // jumlah dimuat ulang setiap kali koneksi realtime berpindah ke tersambung.
    ref.onDispose(
      listenConnectedTransitions(ref.watch(realtimeClientProvider).connectionState, () => unawaited(refresh())),
    );

    unawaited(Future<void>.microtask(refresh));
    return null;
  }

  /// Memuat ulang dari server; kegagalan tidak mengubah lencana (lencana hanya petunjuk, kotak masuk sumber resmi).
  Future<void> refresh() async {
    if (!ref.mounted) return;
    try {
      final count = await ref.read(notificationsRepositoryProvider).unreadCount();
      if (ref.mounted) state = count;
    } on ApiException {
      // Dibiarkan; kotak masuk menampilkan galatnya sendiri.
    }
  }

  /// Jumlah terbaru dari respons kotak masuk atau POST /notifications/read.
  void set(int count) => state = count < 0 ? 0 : count;
}
