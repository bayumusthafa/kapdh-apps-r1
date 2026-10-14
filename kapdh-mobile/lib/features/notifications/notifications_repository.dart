import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_services.dart';
import '../../core/api/api_providers.dart';

/// Repositori kotak masuk dan preferensi notifikasi (kontrak C7 `notifications.yaml`, F-13).
class NotificationsRepository {
  NotificationsRepository(this._api);

  final NotificationsApi _api;

  /// Satu halaman kotak masuk (keyset created_at, id menurun). Cursor terikat filter.
  Future<NotificationPage> list({bool unreadOnly = false, String? cursor}) =>
      _api.listNotifications(unreadOnly: unreadOnly ? true : null, cursor: cursor, limit: 30);

  Future<int> unreadCount() async => (await _api.getNotificationUnreadCount()).unreadCount;

  /// Notifikasi milik sendiri; 404 bila milik akun lain atau tidak ada (AC F13-3, F13-5).
  Future<InboxNotification> get(String id) => _api.getNotification(id);

  Future<MarkNotificationsReadResult> markRead(List<String> ids) =>
      _api.markNotificationsRead(MarkNotificationsReadRequest(ids: ids));

  /// Tandai semua yang dibuat sampai [upTo] (notifikasi yang datang setelah layar dimuat tidak ikut ditandai).
  Future<MarkNotificationsReadResult> markAllRead({DateTime? upTo}) =>
      _api.markNotificationsRead(MarkNotificationsReadRequest(all: true, upTo: upTo));

  Future<NotificationPreferences> preferences() => _api.getNotificationPreferences();

  /// Penggantian penuh preferensi; security dan account tidak memiliki saklar (ARCHITECTURE §4.7).
  Future<NotificationPreferences> savePreferences(NotificationPreferencesUpdate update) =>
      _api.updateNotificationPreferences(update);
}

final notificationsRepositoryProvider = Provider<NotificationsRepository>(
  (ref) => NotificationsRepository(ref.watch(kapdhApiProvider).notifications),
);

/// Notifikasi baru dari event realtime `notification.created` (ARCHITECTURE §4.9). Event bukan sumber kebenaran:
/// kotak masuk tetap dimuat ulang lewat HTTP saat dibuka.
final notificationCreatedEventsProvider = Provider<Stream<NotificationCreatedPayload>>(
  (ref) => ref.watch(realtimeClientProvider).on<NotificationCreatedEvent>().map((event) => event.payload),
);

/// Payload realtime ke bentuk kotak masuk (`InboxNotification` tanpa `read_at`; notifikasi baru belum dibaca).
InboxNotification inboxFromRealtime(NotificationCreatedPayload payload) => InboxNotification(
  id: payload.id,
  category: NotificationCategory.fromJson(payload.category.value),
  title: payload.title,
  body: payload.body,
  deepLink: payload.deepLink,
  readAt: null,
  createdAt: payload.createdAt,
);
