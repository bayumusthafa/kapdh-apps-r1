import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/realtime/realtime_client.dart';
import '../../core/session/session_controller.dart';
import '../network/paged_list.dart';
import 'chat_outbox.dart';
import 'chat_realtime.dart';
import 'chat_repository.dart';
import 'outgoing_message.dart';

/// user_id pemilik sesi (penanda pesan milik sendiri, read receipt dan typing).
final chatMyUserIdProvider = Provider<String?>((ref) => ref.watch(sessionProvider.select((s) => s.userId)));

/// Jumlah untuk lencana navigasi chat dari halaman GET /chat/rooms (`pending_invitation_count`,
/// `unread_room_count`).
@immutable
class ChatBadgeCounts {
  const ChatBadgeCounts({this.pendingInvitations = 0, this.unreadRooms = 0});

  final int pendingInvitations;
  final int unreadRooms;
}

final chatBadgeCountsProvider = NotifierProvider<ChatBadgeCountsController, ChatBadgeCounts>(
  ChatBadgeCountsController.new,
);

class ChatBadgeCountsController extends Notifier<ChatBadgeCounts> {
  @override
  ChatBadgeCounts build() {
    ref.watch(chatMyUserIdProvider);
    return const ChatBadgeCounts();
  }

  void set({required int pendingInvitations, required int unreadRooms}) =>
      state = ChatBadgeCounts(pendingInvitations: pendingInvitations, unreadRooms: unreadRooms);
}

/// Sinyal "daftar room perlu dimuat ulang diam-diam" (mis. setelah keluar dari layar percakapan, menerima undangan
/// atau keluar grup), tanpa menunggu event realtime.
final chatListRefreshProvider = NotifierProvider<ChatListRefresh, int>(ChatListRefresh.new);

class ChatListRefresh extends Notifier<int> {
  @override
  int build() => 0;

  void request() => state++;
}

/// Pratinjau maksimal 120 karakter (chat.yaml ChatMessagePreview.preview).
const int chatPreviewMaxChars = 120;

String? _previewText(String? body) {
  if (body == null) return null;
  final runes = body.trim().runes.toList();
  if (runes.isEmpty) return null;
  return runes.length <= chatPreviewMaxChars
      ? String.fromCharCodes(runes)
      : String.fromCharCodes(runes.take(chatPreviewMaxChars));
}

/// Pratinjau daftar room dari pesan lengkap (event `message.created` atau ack pengiriman).
ChatMessagePreview previewOf(ChatMessage message) => ChatMessagePreview(
  id: message.id,
  kind: message.kind,
  senderUserId: message.sender?.userId,
  senderName: message.sender?.fullName,
  preview: message.deletedAt == null ? _previewText(message.body) : null,
  hasImage: message.image != null,
  deleted: message.deletedAt != null,
  createdAt: message.createdAt,
);

ChatRoomSummary _withLast(ChatRoomSummary room, ChatMessage message, {required int unreadCount}) => ChatRoomSummary(
  id: room.id,
  kind: room.kind,
  title: room.title,
  avatarUrl: room.avatarUrl,
  peer: room.peer,
  memberCount: room.memberCount,
  myRole: room.myRole,
  muted: room.muted,
  unreadCount: unreadCount,
  lastMessage: previewOf(message),
  lastMessageAt: message.createdAt,
);

ChatRoomSummary _withUnread(ChatRoomSummary room, int unreadCount) => ChatRoomSummary(
  id: room.id,
  kind: room.kind,
  title: room.title,
  avatarUrl: room.avatarUrl,
  peer: room.peer,
  memberCount: room.memberCount,
  myRole: room.myRole,
  muted: room.muted,
  unreadCount: unreadCount,
  lastMessage: room.lastMessage,
  lastMessageAt: room.lastMessageAt,
);

ChatRoomSummary _withMemberCount(ChatRoomSummary room, int memberCount) => ChatRoomSummary(
  id: room.id,
  kind: room.kind,
  title: room.title,
  avatarUrl: room.avatarUrl,
  peer: room.peer,
  memberCount: memberCount,
  myRole: room.myRole,
  muted: room.muted,
  unreadCount: room.unreadCount,
  lastMessage: room.lastMessage,
  lastMessageAt: room.lastMessageAt,
);

/// Daftar room milik sendiri per jenis (tab Pesan = direct, tab Pesan Grup = group; F-11) dengan unread, pratinjau
/// terakhir dan status mute. Event realtime memperbarui pratinjau dan unread seketika (N-02); event bukan sumber
/// kebenaran, sehingga perubahan keanggotaan/metadata dan reconnect memuat ulang daftar lewat HTTP (events/README.md
/// "Sinkron setelah reconnect" butir 5).
final chatRoomListProvider = NotifierProvider.autoDispose
    .family<ChatRoomListController, PagedState<ChatRoomSummary>, ChatRoomKind>(ChatRoomListController.new);

class ChatRoomListController extends PagedController<ChatRoomSummary> {
  ChatRoomListController(this.kind);

  final ChatRoomKind kind;

  @override
  PagedState<ChatRoomSummary> build() {
    final realtime = ref.watch(chatRealtimeProvider);
    final events = realtime.events.listen(_onEvent);
    final acks = ref.watch(chatOutboxProvider.notifier).acknowledged.listen(_onAck);
    var previous = realtime.connection.value;
    void onConnection() {
      final next = realtime.connection.value;
      // Reconnect: event yang terlewat selama terputus tidak dikirim ulang; muat ulang daftar.
      if (next == RealtimeConnectionState.connected && previous != RealtimeConnectionState.connected) {
        unawaited(refresh(silent: true));
      }
      previous = next;
    }

    realtime.connection.addListener(onConnection);
    ref.listen<int>(chatListRefreshProvider, (_, _) => unawaited(refresh(silent: true)));
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(acks.cancel());
      realtime.connection.removeListener(onConnection);
    });
    return super.build();
  }

  String? get _me => ref.read(chatMyUserIdProvider);

  @override
  Future<PageResult<ChatRoomSummary>> fetchPage(String? cursor) async {
    final page = await ref.read(chatRepositoryProvider).listRooms(kind: kind, cursor: cursor);
    if (ref.mounted) {
      ref
          .read(chatBadgeCountsProvider.notifier)
          .set(pendingInvitations: page.pendingInvitationCount, unreadRooms: page.unreadRoomCount);
    }
    return PageResult(page.items, page.nextCursor);
  }

  @override
  String keyOf(ChatRoomSummary item) => item.id;

  int _indexOf(String roomId) => state.items.indexWhere((room) => room.id == roomId);

  /// Room dengan pesan terbaru naik ke atas (urutan last_message_at menurun, chat.yaml listChatRooms).
  void _moveToTop(int index, ChatRoomSummary updated) {
    final items = [...state.items]..removeAt(index);
    state = state.copyWith(items: [updated, ...items]);
  }

  void _onMessage(ChatMessage message) {
    if (!state.loaded) return;
    final index = _indexOf(message.roomId);
    if (index < 0) {
      // Room belum ada di daftar (room direct baru, atau di luar halaman yang dimuat): muat ulang dari server.
      unawaited(refresh(silent: true));
      return;
    }
    final room = state.items[index];
    // Pesan yang sudah ditampilkan (ack lalu event, atau sebaliknya) tidak menambah unread dua kali.
    if (room.lastMessage?.id == message.id) return;
    final mine = message.sender?.userId == _me;
    final systemOrMine = mine || message.kind == ChatMessageKind.system;
    final unread = systemOrMine ? room.unreadCount : math.min(999, room.unreadCount + 1);
    _moveToTop(index, _withLast(room, message, unreadCount: unread));
    if (room.unreadCount == 0 && unread > 0) _adjustUnreadRooms(1);
  }

  void _onAck(ChatMessage message) => _onMessage(message);

  void _adjustUnreadRooms(int delta) {
    final counts = ref.read(chatBadgeCountsProvider);
    ref
        .read(chatBadgeCountsProvider.notifier)
        .set(pendingInvitations: counts.pendingInvitations, unreadRooms: math.max(0, counts.unreadRooms + delta));
  }

  /// Unread room menjadi 0 setelah read cursor sendiri maju (layar percakapan atau perangkat lain).
  void markRoomRead(String roomId, {int unreadCount = 0}) {
    final index = _indexOf(roomId);
    if (index < 0) return;
    final room = state.items[index];
    if (room.unreadCount == unreadCount) return;
    final items = [...state.items]..[index] = _withUnread(room, unreadCount);
    state = state.copyWith(items: items);
    if (room.unreadCount > 0 && unreadCount == 0) _adjustUnreadRooms(-1);
  }

  void _onEvent(RealtimeEvent event) {
    if (!ref.mounted) return;
    switch (event) {
      case MessageCreatedEvent(:final payload):
        _onMessage(ChatMessage.fromJson(payload.message.toJson()));
      case MessageDeletedEvent(:final payload):
        final index = _indexOf(payload.roomId);
        if (index >= 0 && state.items[index].lastMessage?.id == payload.messageId) unawaited(refresh(silent: true));
      case ReadUpdatedEvent(:final payload):
        if (payload.userId == _me) markRoomRead(payload.roomId);
      case RoomUpdatedEvent(:final payload):
        if (_indexOf(payload.roomId) >= 0) unawaited(refresh(silent: true));
      case RoomMemberChangedEvent(:final payload):
        _onMemberChanged(payload);
      default:
        break;
    }
  }

  void _onMemberChanged(RoomMemberChangedPayload payload) {
    final index = _indexOf(payload.roomId);
    final aboutMe = payload.userId == _me;
    switch (payload.change) {
      case RoomMemberChangedPayloadChange.left || RoomMemberChangedPayloadChange.removed when aboutMe:
        // Keluar/dikeluarkan: room hilang dari daftar dan riwayat tidak lagi dapat dibaca (AC F11-4).
        if (index >= 0) removeWhere((room) => room.id == payload.roomId);
        unawaited(refresh(silent: true));
      case RoomMemberChangedPayloadChange.joined when aboutMe:
        unawaited(refresh(silent: true));
      case RoomMemberChangedPayloadChange.invited ||
          RoomMemberChangedPayloadChange.invitationCancelled ||
          RoomMemberChangedPayloadChange.declined:
        // Jumlah undangan tertunda berubah (hanya dikirim ke calon anggota dan admin grup).
        if (aboutMe) unawaited(refresh(silent: true));
      default:
        if (index >= 0) {
          final items = [...state.items]..[index] = _withMemberCount(state.items[index], payload.memberCount);
          state = state.copyWith(items: items);
        }
    }
  }
}

/// Ringkasan status kirim pesan keluar untuk daftar room (pesan gagal/ditahan masih menunggu tindakan).
bool hasUnsentMessages(List<OutgoingMessage> outgoing) =>
    outgoing.any((m) => m.status == OutgoingStatus.failed || m.status == OutgoingStatus.held);
