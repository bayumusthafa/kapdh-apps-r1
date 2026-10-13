import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/realtime/realtime_client.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
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

  /// Angka lencana tab Jejaring: room berpesan belum dibaca ditambah undangan grup tertunda.
  int get total => pendingInvitations + unreadRooms;
}

/// Sesi yang boleh memakai chat (anggota aktif, PRD 2.2; chat.yaml member_access active).
bool _chatActive(SessionState session) =>
    session.phase == SessionPhase.authenticated &&
    (session.effectiveStatus == EffectiveStatus.verified || session.effectiveStatus == EffectiveStatus.expiring);

/// Lencana navigasi chat (tab Jejaring di navigasi bawah, tab Pesan/Pesan Grup, tombol Undangan). Selama daftar room
/// hidup (tab Jejaring pernah dibuka), daftar itulah yang memperbarui jumlah dari setiap halaman GET /chat/rooms.
/// Sebelumnya, pengendali ini memuat jumlah sendiri lewat satu halaman kecil GET /chat/rooms saat realtime
/// tersambung dan saat event chat yang mengubah jumlah tiba (digabung: paling banyak satu request berjalan dan satu
/// menunggu), sehingga anggota di Beranda/Akun tetap melihat ada pesan atau undangan baru (F-11).
final chatBadgeCountsProvider = NotifierProvider<ChatBadgeCountsController, ChatBadgeCounts>(
  ChatBadgeCountsController.new,
);

class ChatBadgeCountsController extends Notifier<ChatBadgeCounts> {
  bool _fetching = false;
  bool _fetchAgain = false;

  @override
  ChatBadgeCounts build() {
    ref.watch(chatMyUserIdProvider);
    if (!ref.watch(sessionProvider.select(_chatActive))) return const ChatBadgeCounts();
    final realtime = ref.watch(chatRealtimeProvider);
    var previous = realtime.connection.value;
    void onConnection() {
      final next = realtime.connection.value;
      if (next == RealtimeConnectionState.connected && previous != RealtimeConnectionState.connected) {
        _refreshUnlessListsAlive();
      }
      previous = next;
    }

    realtime.connection.addListener(onConnection);
    final events = realtime.events.listen(_onEvent);
    ref.onDispose(() {
      realtime.connection.removeListener(onConnection);
      unawaited(events.cancel());
    });
    if (previous == RealtimeConnectionState.connected) Future.microtask(_refreshUnlessListsAlive);
    return const ChatBadgeCounts();
  }

  void set({required int pendingInvitations, required int unreadRooms}) =>
      state = ChatBadgeCounts(pendingInvitations: pendingInvitations, unreadRooms: unreadRooms);

  bool get _listsAlive =>
      ref.exists(chatRoomListProvider(ChatRoomKind.direct)) || ref.exists(chatRoomListProvider(ChatRoomKind.group));

  void _onEvent(RealtimeEvent event) {
    if (!ref.mounted) return;
    final me = ref.read(chatMyUserIdProvider);
    final relevant = switch (event) {
      MessageCreatedEvent(:final payload) =>
        payload.message.sender?.userId != null && payload.message.sender?.userId != me,
      ReadUpdatedEvent(:final payload) => payload.userId == me,
      RoomMemberChangedEvent(:final payload) => payload.userId == me,
      _ => false,
    };
    if (relevant) _refreshUnlessListsAlive();
  }

  void _refreshUnlessListsAlive() {
    if (!ref.mounted || _listsAlive) return;
    _fetchAgain = true;
    if (!_fetching) unawaited(_drain());
  }

  Future<void> _drain() async {
    _fetching = true;
    try {
      while (_fetchAgain && ref.mounted && !_listsAlive) {
        _fetchAgain = false;
        try {
          final page = await ref.read(chatRepositoryProvider).listRooms(limit: 1);
          if (!ref.mounted || _listsAlive) return;
          set(pendingInvitations: page.pendingInvitationCount, unreadRooms: page.unreadRoomCount);
        } on ApiException {
          // Lencana hanya petunjuk; dicoba lagi pada event/reconnect berikutnya.
        }
      }
    } finally {
      _fetching = false;
    }
  }
}

/// Jenis room yang pernah terlihat klien (halaman daftar dan detail room). Event `message.created` tidak membawa jenis
/// room, sehingga daftar memakai catatan ini agar pesan grup tidak memuat ulang tab Pesan dan pesan direct tidak
/// memuat ulang tab Pesan Grup (N-01, N-02, N-04: satu pesan tidak boleh melipatgandakan request setiap anggota).
class ChatRoomKindRegistry {
  final Map<String, ChatRoomKind> _kinds = {};

  ChatRoomKind? kindOf(String roomId) => _kinds[roomId];

  void remember(String roomId, ChatRoomKind kind) {
    if (kind != ChatRoomKind.unknown) _kinds[roomId] = kind;
  }
}

/// Catatan jenis room per akun (dikosongkan saat akun berganti).
final chatRoomKindRegistryProvider = Provider<ChatRoomKindRegistry>((ref) {
  ref.watch(chatMyUserIdProvider);
  return ChatRoomKindRegistry();
});

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

  bool _refreshRunning = false;
  bool _refreshPending = false;

  /// Room yang belum ada di daftar dan jenisnya belum diketahui (atau sejenis daftar ini) sejak muat ulang terakhir.
  final Set<String> _unknownRooms = {};

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
        requestRefresh();
      }
      previous = next;
    }

    realtime.connection.addListener(onConnection);
    ref.listen<int>(chatListRefreshProvider, (_, _) => requestRefresh());
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
      final registry = ref.read(chatRoomKindRegistryProvider);
      for (final room in page.items) {
        registry.remember(room.id, room.kind);
      }
      ref
          .read(chatBadgeCountsProvider.notifier)
          .set(pendingInvitations: page.pendingInvitationCount, unreadRooms: page.unreadRoomCount);
    }
    return PageResult(page.items, page.nextCursor);
  }

  /// Muat ulang diam-diam yang digabung (event realtime, reconnect, sinyal layar lain): paling banyak satu request
  /// berjalan dan satu menunggu, sehingga rentetan event tidak menjadi rentetan request (N-01, N-04).
  void requestRefresh() {
    _refreshPending = true;
    _drainRefreshes();
  }

  /// Pesan untuk room yang tidak ada di daftar ini: muat ulang hanya bila room itu mungkin milik daftar ini (room
  /// baru, atau sejenis tetapi di luar halaman yang dimuat). Room yang diketahui milik daftar lain diabaikan.
  void _onUnknownRoom(String roomId) {
    final known = ref.read(chatRoomKindRegistryProvider).kindOf(roomId);
    if (known != null && known != kind) return;
    _unknownRooms.add(roomId);
    _drainRefreshes();
  }

  bool get _refreshNeeded {
    final registry = ref.read(chatRoomKindRegistryProvider);
    // Selama menunggu, daftar lain mungkin sudah memuat room itu sehingga jenisnya kini diketahui.
    _unknownRooms.removeWhere((id) {
      final known = registry.kindOf(id);
      return known != null && known != kind;
    });
    return _refreshPending || _unknownRooms.isNotEmpty;
  }

  void _drainRefreshes() {
    if (_refreshRunning) return;
    unawaited(_runRefreshes());
  }

  Future<void> _runRefreshes() async {
    _refreshRunning = true;
    try {
      while (ref.mounted && _refreshNeeded) {
        _refreshPending = false;
        _unknownRooms.clear();
        await refresh(silent: true);
      }
    } finally {
      _refreshRunning = false;
    }
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
      _onUnknownRoom(message.roomId);
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
        if (index >= 0 && state.items[index].lastMessage?.id == payload.messageId) requestRefresh();
      case ReadUpdatedEvent(:final payload):
        if (payload.userId == _me) markRoomRead(payload.roomId);
      case RoomUpdatedEvent(:final payload):
        if (_indexOf(payload.roomId) >= 0) requestRefresh();
      case RoomMemberChangedEvent(:final payload):
        _onMemberChanged(payload);
      default:
        break;
    }
  }

  void _onMemberChanged(RoomMemberChangedPayload payload) {
    final index = _indexOf(payload.roomId);
    final aboutMe = payload.userId == _me;
    // Keanggotaan dan undangan hanya berubah di grup (events/README.md kanal room.member_changed).
    final group = kind == ChatRoomKind.group;
    switch (payload.change) {
      case RoomMemberChangedPayloadChange.left || RoomMemberChangedPayloadChange.removed when aboutMe:
        // Keluar/dikeluarkan: room hilang dari daftar dan riwayat tidak lagi dapat dibaca (AC F11-4).
        if (index >= 0) removeWhere((room) => room.id == payload.roomId);
        if (index >= 0 || group) requestRefresh();
      case RoomMemberChangedPayloadChange.joined when aboutMe:
        if (group) requestRefresh();
      case RoomMemberChangedPayloadChange.invited ||
          RoomMemberChangedPayloadChange.invitationCancelled ||
          RoomMemberChangedPayloadChange.declined:
        // Jumlah undangan tertunda berubah (hanya dikirim ke calon anggota dan admin grup).
        if (aboutMe && group) requestRefresh();
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
