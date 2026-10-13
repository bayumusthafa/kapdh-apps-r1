import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/features/chat/chat_outbox.dart';
import 'package:kapdh_mobile/features/chat/chat_realtime.dart';

import '../../support/fakes.dart';

/// Data uji chat mengikuti skema final chat.yaml dan events/*.schema.json (bentuk JSON persis kontrak).

String iso(DateTime value) => value.toUtc().toIso8601String();

/// Waktu pesan ke-[n] (detik sesudah testNow) agar urutan keyset (created_at, id) jelas.
DateTime at(int n) => testNow.add(Duration(seconds: n));

Map<String, Object?> userRefJson(String userId, String name) => {
  'user_id': userId,
  'full_name': name,
  'avatar_url': null,
};

Map<String, Object?> chatMessageJson({
  required String id,
  String roomId = 'room-1',
  String? clientMessageId,
  String kind = 'text',
  String? senderId = 'user-2',
  String senderName = 'Gamerisa Dewi',
  String? body = 'Halo',
  Map<String, Object?>? image,
  Map<String, Object?>? replyTo,
  List<Map<String, Object?>> reactions = const [],
  DateTime? createdAt,
  DateTime? deletedAt,
}) => {
  'id': id,
  'room_id': roomId,
  'client_message_id': kind == 'system' ? null : (clientMessageId ?? 'c-$id'),
  'kind': kind,
  'sender': senderId == null || kind == 'system' ? null : userRefJson(senderId, senderName),
  'body': deletedAt == null ? body : null,
  'image': deletedAt == null ? image : null,
  'reply_to': replyTo,
  'reactions': deletedAt == null ? reactions : const <Object?>[],
  'created_at': iso(createdAt ?? testNow),
  'deleted_at': deletedAt == null ? null : iso(deletedAt),
};

ChatMessage messageOf({
  required String id,
  String roomId = 'room-1',
  String? clientMessageId,
  String? senderId = 'user-2',
  String senderName = 'Gamerisa Dewi',
  String? body = 'Halo',
  DateTime? createdAt,
  DateTime? deletedAt,
  List<Map<String, Object?>> reactions = const [],
}) => ChatMessage.fromJson(
  chatMessageJson(
    id: id,
    roomId: roomId,
    clientMessageId: clientMessageId,
    senderId: senderId,
    senderName: senderName,
    body: body,
    createdAt: createdAt,
    deletedAt: deletedAt,
    reactions: reactions,
  ),
);

Map<String, Object?> pageJson(List<Map<String, Object?>> items, {String? nextCursor}) => {
  'items': items,
  'next_cursor': nextCursor,
};

ChatMessagePage pageOf(List<ChatMessage> items, {String? nextCursor}) =>
    ChatMessagePage(items: items, nextCursor: nextCursor);

Map<String, Object?> previewJson({
  required String id,
  String? senderId = 'user-2',
  String? senderName = 'Gamerisa Dewi',
  String? preview = 'Halo',
  bool hasImage = false,
  bool deleted = false,
  DateTime? createdAt,
}) => {
  'id': id,
  'kind': 'text',
  'sender_user_id': senderId,
  'sender_name': senderName,
  'preview': preview,
  'has_image': hasImage,
  'deleted': deleted,
  'created_at': iso(createdAt ?? testNow),
};

Map<String, Object?> peerJson({String userId = 'user-2', String name = 'Gamerisa Dewi', bool available = true}) => {
  'user_id': userId,
  'full_name': name,
  'avatar_url': null,
  'available': available,
};

/// `ChatRoomSummary` (daftar room).
Map<String, Object?> roomSummaryJson({
  String id = 'room-1',
  String kind = 'direct',
  String title = 'Gamerisa Dewi',
  Map<String, Object?>? peer,
  int memberCount = 2,
  String myRole = 'member',
  bool muted = false,
  int unreadCount = 0,
  Map<String, Object?>? lastMessage,
  DateTime? lastMessageAt,
}) => {
  'id': id,
  'kind': kind,
  'title': title,
  'avatar_url': null,
  'peer': kind == 'direct' ? (peer ?? peerJson()) : null,
  'member_count': memberCount,
  'my_role': myRole,
  'muted': muted,
  'unread_count': unreadCount,
  'last_message': lastMessage,
  'last_message_at': lastMessageAt == null ? null : iso(lastMessageAt),
};

/// `ChatRoom` (detail room).
Map<String, Object?> roomJson({
  String id = 'room-1',
  String kind = 'direct',
  String title = 'Gamerisa Dewi',
  Map<String, Object?>? peer,
  bool peerAvailable = true,
  int memberCount = 2,
  String myRole = 'member',
  bool muted = false,
  int unreadCount = 0,
  bool canSend = true,
  String? sendRestriction,
  bool canManage = false,
  String? lastReadMessageId,
  String? peerLastReadMessageId,
  DateTime? historyVisibleFrom,
  DateTime? closedAt,
  String version = '1',
  String? avatarFileId,
}) => {
  ...roomSummaryJson(
    id: id,
    kind: kind,
    title: title,
    peer: peer ?? peerJson(available: peerAvailable),
    memberCount: memberCount,
    myRole: myRole,
    muted: muted,
    unreadCount: unreadCount,
  ),
  'name': kind == 'group' ? title : null,
  'avatar_file_id': avatarFileId,
  'can_send': canSend,
  'send_restriction': sendRestriction,
  'can_manage': canManage,
  'last_read_message_id': lastReadMessageId,
  'peer_last_read_message_id': kind == 'direct' ? peerLastReadMessageId : null,
  'history_visible_from': historyVisibleFrom == null ? null : iso(historyVisibleFrom),
  'closed_at': closedAt == null ? null : iso(closedAt),
  'created_at': iso(testNow.subtract(const Duration(days: 3))),
  'version': version,
};

Map<String, Object?> roomPageJson(
  List<Map<String, Object?>> items, {
  String? nextCursor,
  int pendingInvitations = 0,
  int unreadRooms = 0,
}) => {
  'items': items,
  'next_cursor': nextCursor,
  'pending_invitation_count': pendingInvitations,
  'unread_room_count': unreadRooms,
};

Map<String, Object?> memberJson({
  required String userId,
  required String name,
  String role = 'member',
  String status = 'joined',
  String? lastReadMessageId,
  bool isMe = false,
}) => {
  'user_id': userId,
  'full_name': name,
  'avatar_url': null,
  'role': role,
  'status': status,
  'invited_at': iso(testNow.subtract(const Duration(days: 2))),
  'joined_at': status == 'joined' ? iso(testNow.subtract(const Duration(days: 1))) : null,
  'last_read_message_id': status == 'joined' ? lastReadMessageId : null,
  'is_me': isMe,
};

Map<String, Object?> readStateJson({String roomId = 'room-1', String? lastRead, int unread = 0}) => {
  'room_id': roomId,
  'last_read_message_id': lastRead,
  'last_read_at': lastRead == null ? null : iso(testNow),
  'unread_count': unread,
};

var _eventSeq = 0;

/// Amplop realtime `{v, event_id, type, entity_id, ts, payload}` (events/envelope.schema.json).
Map<String, Object?> envelope(String type, String entityId, Map<String, Object?> payload, {String? eventId}) => {
  'v': 1,
  'event_id': eventId ?? 'evt-${++_eventSeq}',
  'type': type,
  'entity_id': entityId,
  'ts': iso(testNow),
  'payload': payload,
};

Map<String, Object?> messageCreated(Map<String, Object?> message, {String? eventId}) => envelope(
  'message.created',
  message['id']! as String,
  {'room_id': message['room_id'], 'message': message},
  eventId: eventId,
);

Map<String, Object?> messageDeleted(String messageId, {String roomId = 'room-1'}) => envelope(
  'message.deleted',
  messageId,
  {'room_id': roomId, 'message_id': messageId, 'deleted_at': iso(at(500))},
);

Map<String, Object?> readUpdated(String userId, String messageId, {String roomId = 'room-1'}) => envelope(
  'read.updated',
  roomId,
  {'room_id': roomId, 'user_id': userId, 'last_read_message_id': messageId, 'last_read_at': iso(testNow)},
);

Map<String, Object?> typingEvent(String userId, {String roomId = 'room-1', int ttl = 5}) =>
    envelope('typing', roomId, {'room_id': roomId, 'user_id': userId, 'ttl_seconds': ttl});

Map<String, Object?> presenceEvent(String userId, {bool online = true, int ttl = 60}) => envelope(
  'presence',
  userId,
  {'user_id': userId, 'status': online ? 'online' : 'offline', 'ttl_seconds': online ? ttl : 0},
);

Map<String, Object?> memberChanged(
  String userId,
  String change, {
  String roomId = 'room-1',
  String? role,
  int memberCount = 3,
  String? actor,
}) => envelope('room.member_changed', roomId, {
  'room_id': roomId,
  'user_id': userId,
  'change': change,
  'role': role,
  'member_count': memberCount,
  'actor_user_id': actor,
});

Map<String, Object?> roomUpdated(List<String> changes, {String roomId = 'room-1', String version = '2'}) => envelope(
  'room.updated',
  roomId,
  {'room_id': roomId, 'version': version, 'changes': changes, 'name': null, 'avatar_url': null, 'closed_at': null},
);

Map<String, Object?> reactionUpdated(
  String messageId,
  String userId,
  String emoji,
  String action,
  List<Map<String, Object?>> counts, {
  String roomId = 'room-1',
}) => envelope('reaction.updated', messageId, {
  'room_id': roomId,
  'message_id': messageId,
  'user_id': userId,
  'emoji': emoji,
  'action': action,
  'counts': counts,
});

/// Realtime tiruan: event dipancarkan uji, keadaan koneksi dapat diubah, emit klien dicatat.
class FakeChatRealtime implements ChatRealtime {
  final StreamController<RealtimeEvent> _events = StreamController<RealtimeEvent>.broadcast();
  final ValueNotifier<RealtimeConnectionState> state = ValueNotifier(RealtimeConnectionState.connected);
  final List<String> typing = [];
  int pings = 0;

  @override
  Stream<RealtimeEvent> get events => _events.stream;

  @override
  ValueListenable<RealtimeConnectionState> get connection => state;

  @override
  void sendTyping(String roomId) => typing.add(roomId);

  @override
  void sendPresencePing() => pings++;

  void emit(Map<String, Object?> json) => _events.add(RealtimeEvent.fromJson(json));

  /// Koneksi putus lalu tersambung kembali (memicu sinkron AC F11-3).
  void reconnect() {
    state.value = RealtimeConnectionState.waitingRetry;
    state.value = RealtimeConnectionState.connected;
  }
}

/// Sesi uji tanpa bootstrap: keadaan langsung dari [initial]; [set] meniru /me baru.
class TestSession extends SessionController {
  TestSession(this.initial);

  final SessionState initial;

  @override
  SessionState build() => initial;

  void set(SessionState next) => state = next;

  @override
  Future<void> refreshQuietly() async {}
}

/// Sesi anggota aktif `user-1` dengan masa berlaku [expiresAt] (null = tanpa tanggal pada data uji).
SessionState activeSession({String status = 'verified', DateTime? expiresAt, String userId = 'user-1'}) =>
    SessionState.authenticated(
      Me.fromJson(meJson(userId: userId, status: status, expiresAt: expiresAt)),
      syncedAt: testNow,
    );

/// Kontainer uji chat: HTTP lewat [handler], realtime tiruan, sesi [session].
ProviderContainer chatContainer({
  required FakeHandler handler,
  required FakeChatRealtime realtime,
  SessionState? session,
  TestClock? clock,
  List<String> clientIds = const [],
}) {
  final ids = [...clientIds];
  var counter = 0;
  return makeContainer(
    adapter: FakeHttpAdapter(handler),
    clock: clock,
    overrides: [
      chatRealtimeProvider.overrideWithValue(realtime),
      sessionProvider.overrideWith(() => TestSession(session ?? activeSession())),
      clientMessageIdProvider.overrideWithValue(() => ids.isNotEmpty ? ids.removeAt(0) : 'client-${++counter}'),
    ],
  );
}

/// Adapter HTTP tiruan milik [container] (request yang tercatat).
FakeHttpAdapter adapterOf(ProviderContainer container) => container.read(httpClientAdapterProvider)! as FakeHttpAdapter;

/// Menunggu rantai async Dio/Riverpod (interceptor, adapter tiruan, transformer) selesai pada uji non-widget.
Future<void> settleAsync({int ticks = 40}) async {
  for (var i = 0; i < ticks; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 2));
  }
}
