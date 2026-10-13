import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/realtime/realtime_client.dart';
import '../../core/session/session_controller.dart';
import 'chat_list_controller.dart';
import 'chat_outbox.dart';
import 'chat_realtime.dart';
import 'chat_repository.dart';
import 'chat_sync.dart';
import 'chat_timeline.dart';
import 'outgoing_message.dart';

/// Jeda minimum antar-emit `typing {room_id}` (server menyiarkan dengan TTL; emit lebih sering tidak berguna).
const Duration typingEmitInterval = Duration(seconds: 3);

/// Pesan untuk pesan yang ditahan karena keanggotaan tidak aktif (PRD 4.5 "Keanggotaan berakhir saat chat").
const String membershipHoldMessage =
    'Masa keanggotaan Anda tidak aktif. Pesan disimpan dan dikirim setelah KTA diperpanjang.';

/// Keadaan satu layar percakapan (F-11).
@immutable
class ChatRoomViewState {
  const ChatRoomViewState({
    this.room,
    this.timeline = ChatTimeline.empty,
    this.members = const {},
    this.loadError,
    this.loadingOlder = false,
    this.olderError,
    this.syncing = false,
    this.syncError,
    this.membershipLapsed = false,
    this.gone = false,
    this.typing = const {},
    this.online = const {},
  });

  /// Detail room terbaru dari GET /chat/rooms/{roomId}; null sebelum dimuat.
  final ChatRoom? room;

  /// Pesan server urut `(created_at, id)` beserta jangkar sinkron (AC F11-3).
  final ChatTimeline timeline;

  /// Anggota joined grup (nama dan read cursor untuk status "terbaca"); kosong untuk room direct.
  final Map<String, ChatRoomMember> members;

  /// Galat pemuatan awal (belum ada data untuk ditampilkan).
  final ApiException? loadError;
  final bool loadingOlder;
  final ApiException? olderError;

  /// Sinkron setelah reconnect/kembali aktif sedang berjalan.
  final bool syncing;

  /// Sinkron terakhir gagal (mis. offline); data lokal tetap tampil.
  final ApiException? syncError;

  /// Keanggotaan tidak aktif (expired/suspended): ajakan perpanjang dan pengiriman ditahan (PRD 4.5, AC F11-6).
  final bool membershipLapsed;

  /// Pemanggil bukan lagi anggota joined (keluar, dikeluarkan, atau room tidak ada): riwayat tidak lagi dapat
  /// dibaca (AC F11-4).
  final bool gone;

  /// Pengguna yang sedang mengetik, sampai kapan (jam perangkat; TTL dari event `typing`).
  final Map<String, DateTime> typing;

  /// Pengguna yang daring, sampai kapan (TTL dari event `presence`). Bukan bukti pesan dibaca (PRD 3.11).
  final Map<String, DateTime> online;

  bool get loaded => room != null && timeline.loaded;

  ChatRoomViewState copyWith({
    ChatRoom? room,
    ChatTimeline? timeline,
    Map<String, ChatRoomMember>? members,
    ApiException? loadError,
    bool clearLoadError = false,
    bool? loadingOlder,
    ApiException? olderError,
    bool clearOlderError = false,
    bool? syncing,
    ApiException? syncError,
    bool clearSyncError = false,
    bool? membershipLapsed,
    bool? gone,
    Map<String, DateTime>? typing,
    Map<String, DateTime>? online,
  }) => ChatRoomViewState(
    room: room ?? this.room,
    timeline: timeline ?? this.timeline,
    members: members ?? this.members,
    loadError: clearLoadError ? null : (loadError ?? this.loadError),
    loadingOlder: loadingOlder ?? this.loadingOlder,
    olderError: clearOlderError ? null : (olderError ?? this.olderError),
    syncing: syncing ?? this.syncing,
    syncError: clearSyncError ? null : (syncError ?? this.syncError),
    membershipLapsed: membershipLapsed ?? this.membershipLapsed,
    gone: gone ?? this.gone,
    typing: typing ?? this.typing,
    online: online ?? this.online,
  );
}

/// Galat yang berarti keanggotaan tidak aktif (PRD 2.2, 4.5).
bool isMembershipError(ApiException error) =>
    error.code == ErrorCode.membershipRequired || error.code == ErrorCode.accountSuspended;

/// Salinan [room] dengan read cursor baru.
ChatRoom chatRoomWithCursors(ChatRoom room, {String? lastReadMessageId, String? peerLastReadMessageId}) => ChatRoom(
  id: room.id,
  kind: room.kind,
  title: room.title,
  avatarUrl: room.avatarUrl,
  peer: room.peer,
  memberCount: room.memberCount,
  myRole: room.myRole,
  muted: room.muted,
  unreadCount: lastReadMessageId != null ? 0 : room.unreadCount,
  lastMessage: room.lastMessage,
  lastMessageAt: room.lastMessageAt,
  name: room.name,
  avatarFileId: room.avatarFileId,
  canSend: room.canSend,
  sendRestriction: room.sendRestriction,
  canManage: room.canManage,
  lastReadMessageId: lastReadMessageId ?? room.lastReadMessageId,
  peerLastReadMessageId: peerLastReadMessageId ?? room.peerLastReadMessageId,
  historyVisibleFrom: room.historyVisibleFrom,
  closedAt: room.closedAt,
  createdAt: room.createdAt,
  version: room.version,
);

ChatRoomMember _memberWithCursor(ChatRoomMember member, String cursor) => ChatRoomMember(
  userId: member.userId,
  fullName: member.fullName,
  avatarUrl: member.avatarUrl,
  role: member.role,
  status: member.status,
  invitedAt: member.invitedAt,
  joinedAt: member.joinedAt,
  lastReadMessageId: cursor,
  isMe: member.isMe,
);

/// Pengendali layar percakapan (F-11; AC F11-2, F11-3, F11-4, F11-6; N-02):
///
/// - Membuka room selalu memuat detail dan halaman terbaru lewat HTTP (salinan lokal hanya sementara, aturan
///   "Sinkron setelah reconnect" butir 4).
/// - Event realtime room ini digabung ke garis waktu berdasarkan `id`; `message.created` tidak memajukan jangkar.
/// - Reconnect dan aplikasi kembali aktif menjalankan [syncTimeline]: `after=<jangkar>` sampai habis, lalu jendela
///   yang ditampilkan dimuat ulang (AC F11-3).
/// - Pengiriman lewat [ChatOutbox] dengan `client_message_id` tetap (AC F11-2); keanggotaan tidak aktif menahan
///   pengiriman dan menampilkan ajakan perpanjang (PRD 4.5).
final chatRoomControllerProvider =
    NotifierProvider.autoDispose.family<ChatRoomController, ChatRoomViewState, String>(ChatRoomController.new);

class ChatRoomController extends Notifier<ChatRoomViewState> {
  ChatRoomController(this.roomId);

  final String roomId;

  bool _syncRunning = false;
  bool _syncAgain = false;

  /// Perubahan garis waktu dari event selama sinkron berjalan; diputar ulang di atas hasil sinkron agar event yang
  /// tiba di tengah sinkron tidak hilang.
  final List<ChatTimeline Function(ChatTimeline)> _opsDuringSync = [];
  bool _readInFlight = false;
  bool _readAgain = false;
  DateTime? _lastTypingSent;

  /// Server menolak dengan MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED sejak /me terakhir.
  bool _lapsedByServer = false;

  ChatRepository get _repo => ref.read(chatRepositoryProvider);
  ChatOutbox get _outbox => ref.read(chatOutboxProvider.notifier);
  String? get _me => ref.read(chatMyUserIdProvider);
  DateTime _deviceNow() => ref.read(clockProvider)().toUtc();

  @override
  ChatRoomViewState build() {
    final realtime = ref.watch(chatRealtimeProvider);
    final events = realtime.events.listen(_onEvent);
    final acks = ref.read(chatOutboxProvider.notifier).acknowledged.listen((message) {
      if (message.roomId == roomId && ref.mounted) _applyTimeline((t) => t.upsert(message));
    });
    var previous = realtime.connection.value;
    void onConnection() {
      final next = realtime.connection.value;
      final reconnected = next == RealtimeConnectionState.connected && previous != RealtimeConnectionState.connected;
      previous = next;
      if (reconnected && ref.mounted) {
        unawaited(resync());
      }
    }

    realtime.connection.addListener(onConnection);
    // /me baru: keanggotaan aktif kembali (perpanjangan disetujui) melepas pesan yang ditahan (PRD 4.5).
    ref.listen(sessionProvider.select((s) => (s.me?.effectiveStatus, s.me?.expiresAt)), (_, _) {
      _lapsedByServer = false;
      _refreshMembership();
    });
    // Pesan yang ditahan server karena keanggotaan berarti status lokal sudah usang.
    ref.listen(chatOutboxProvider.select((s) => s[roomId]), (_, next) {
      if (next != null && next.any((m) => m.status == OutgoingStatus.held) && !state.membershipLapsed) {
        _lapsedByServer = true;
        state = state.copyWith(membershipLapsed: true);
      }
    });
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(acks.cancel());
      realtime.connection.removeListener(onConnection);
    });
    Future.microtask(_open);
    return ChatRoomViewState(membershipLapsed: _membershipLapsedLocally());
  }

  /// Keanggotaan berakhir menurut /me yang dimiliki klien: status efektif, atau `expires_at` sudah lewat menurut
  /// jam server (expired murni berbasis waktu, chat.yaml butir f).
  bool _membershipLapsedLocally() {
    final me = ref.read(sessionProvider).me;
    if (me == null) return false;
    switch (me.effectiveStatus) {
      case EffectiveStatus.verified || EffectiveStatus.expiring:
        final expiresAt = me.expiresAt;
        return expiresAt != null && !ref.read(serverClockProvider).now().isBefore(expiresAt);
      default:
        return true;
    }
  }

  void _refreshMembership() {
    if (!ref.mounted) return;
    final lapsed = _lapsedByServer || _membershipLapsedLocally();
    final was = state.membershipLapsed;
    if (lapsed != was) state = state.copyWith(membershipLapsed: lapsed);
    if (lapsed) {
      _outbox.holdAll(roomId, membershipHoldMessage);
    } else if (was) {
      // Keanggotaan aktif kembali: kirim pesan yang ditahan dengan client_message_id yang sama (AC F11-2).
      _outbox.resume(roomId, includeHeld: true);
      unawaited(resync());
    }
  }

  void _handleLoadError(ApiException error) {
    if (error.code == ErrorCode.notFound) {
      // Bukan anggota joined lagi atau room tidak ada; UUID room bukan izin akses (AC F11-4).
      _outbox.clearRoom(roomId);
      state = state.copyWith(gone: true, syncing: false);
      ref.read(chatListRefreshProvider.notifier).request();
      return;
    }
    if (isMembershipError(error)) {
      _lapsedByServer = true;
      _outbox.holdAll(roomId, membershipHoldMessage);
      state = state.copyWith(membershipLapsed: true);
    }
  }

  Future<Map<String, ChatRoomMember>> _loadMembers(ChatRoom room) async {
    if (room.kind != ChatRoomKind.group) return const {};
    final page = await _repo.listMembers(roomId);
    return {for (final member in page.items) member.userId: member};
  }

  Future<void> _open() async {
    if (!ref.mounted) return;
    state = state.copyWith(clearLoadError: true);
    try {
      final results = await Future.wait<Object>([_repo.getRoom(roomId), _repo.listMessages(roomId)]);
      final room = results[0] as ChatRoom;
      final page = results[1] as ChatMessagePage;
      final members = await _loadMembers(room);
      if (!ref.mounted) return;
      state = state.copyWith(
        room: room,
        timeline: state.timeline.applyLatestPage(page),
        members: members,
        clearSyncError: true,
      );
      _afterServerTimeline();
      _refreshMembership();
      if (!state.membershipLapsed) _outbox.resume(roomId, includeHeld: true);
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      _handleLoadError(error);
      state = state.copyWith(loadError: error);
    }
  }

  /// Pesan keluar yang sudah terlihat di halaman server (respons hilang tetapi commit berhasil) dilepas dari
  /// antrean lokal (AC F11-2).
  void _afterServerTimeline() {
    final me = _me;
    if (me == null) return;
    for (final entry in ref.read(chatOutboxProvider)[roomId] ?? const <OutgoingMessage>[]) {
      if (state.timeline.byClientId(me, entry.clientMessageId) != null) {
        _outbox.resolve(roomId, entry.clientMessageId);
      }
    }
  }

  /// Muat ulang penuh (tombol "Coba lagi" saat pemuatan awal gagal).
  Future<void> reload() {
    if (state.loaded) return resync();
    return _open();
  }

  /// Sinkron setelah reconnect atau aplikasi kembali aktif (AC F11-3, N-02): `after=<jangkar>` sampai habis,
  /// jendela yang ditampilkan dimuat ulang, detail room dan anggota diperbarui, lalu pesan gagal sementara dikirim
  /// ulang dengan client_message_id yang sama.
  Future<void> resync() async {
    if (!ref.mounted) return;
    if (!state.loaded) {
      if (state.loadError != null && !state.gone) await _open();
      return;
    }
    if (_syncRunning) {
      _syncAgain = true;
      return;
    }
    _syncRunning = true;
    _opsDuringSync.clear();
    state = state.copyWith(syncing: true);
    try {
      do {
        _syncAgain = false;
        final base = state.timeline;
        final synced = await syncTimeline(
          base,
          ({String? before, String? after, required int limit}) =>
              _repo.listMessages(roomId, before: before, after: after, limit: limit),
        );
        final room = await _repo.getRoom(roomId);
        final members = await _loadMembers(room);
        if (!ref.mounted) return;
        var timeline = synced;
        for (final op in _opsDuringSync) {
          timeline = op(timeline);
        }
        _opsDuringSync.clear();
        state = state.copyWith(room: room, timeline: timeline, members: members, clearSyncError: true);
        _afterServerTimeline();
      } while (_syncAgain && ref.mounted);
      if (!ref.mounted) return;
      state = state.copyWith(syncing: false);
      _refreshMembership();
      if (!state.membershipLapsed) _outbox.resume(roomId);
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      _opsDuringSync.clear();
      _handleLoadError(error);
      state = state.copyWith(syncing: false, syncError: error);
    } finally {
      _syncRunning = false;
    }
  }

  void _applyTimeline(ChatTimeline Function(ChatTimeline) op) {
    if (_syncRunning) _opsDuringSync.add(op);
    state = state.copyWith(timeline: op(state.timeline));
  }

  /// Halaman lebih lama (`before`), saat pengguna menggulir ke atas.
  Future<void> loadOlder() async {
    final cursor = state.timeline.olderCursor;
    if (cursor == null || state.loadingOlder || !state.loaded) return;
    state = state.copyWith(loadingOlder: true, clearOlderError: true);
    try {
      final page = await _repo.listMessages(roomId, before: cursor);
      if (!ref.mounted) return;
      state = state.copyWith(loadingOlder: false, timeline: state.timeline.applyOlderPage(page));
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      _handleLoadError(error);
      state = state.copyWith(loadingOlder: false, olderError: error);
    }
  }

  void _onEvent(RealtimeEvent event) {
    if (!ref.mounted) return;
    switch (event) {
      case MessageCreatedEvent(:final payload) when payload.roomId == roomId:
        final message = chatMessageFromRealtime(payload.message);
        final me = _me;
        final clientId = message.clientMessageId;
        if (me != null && clientId != null && message.sender?.userId == me) _outbox.resolve(roomId, clientId);
        _applyTimeline((t) => t.upsert(message));
        final sender = message.sender?.userId;
        if (sender != null && state.typing.containsKey(sender)) {
          state = state.copyWith(typing: {...state.typing}..remove(sender));
        }
      case MessageDeletedEvent(:final payload) when payload.roomId == roomId:
        _applyTimeline((t) => t.markDeleted(payload.messageId, payload.deletedAt));
      case ReactionUpdatedEvent(:final payload) when payload.roomId == roomId:
        final me = _me;
        if (me != null) _applyTimeline((t) => t.applyReactionEvent(payload, myUserId: me));
      case ReadUpdatedEvent(:final payload) when payload.roomId == roomId:
        _onRead(payload);
      case RoomUpdatedEvent(:final payload) when payload.roomId == roomId:
        unawaited(refreshRoom());
      case RoomMemberChangedEvent(:final payload) when payload.roomId == roomId:
        _onMemberChanged(payload);
      case TypingEvent(:final payload) when payload.roomId == roomId:
        if (payload.userId == _me) return;
        state = state.copyWith(
          typing: {...state.typing, payload.userId: _deviceNow().add(Duration(seconds: payload.ttlSeconds))},
        );
      case PresenceEvent(:final payload):
        final online = {...state.online};
        if (payload.status == PresencePayloadStatus.online && payload.ttlSeconds > 0) {
          online[payload.userId] = _deviceNow().add(Duration(seconds: payload.ttlSeconds));
        } else {
          online.remove(payload.userId);
        }
        state = state.copyWith(online: online);
      default:
        break;
    }
  }

  void _onRead(ReadUpdatedPayload payload) {
    final room = state.room;
    if (room == null) return;
    if (payload.userId == _me) {
      state = state.copyWith(room: chatRoomWithCursors(room, lastReadMessageId: payload.lastReadMessageId));
      return;
    }
    if (room.kind == ChatRoomKind.direct) {
      state = state.copyWith(room: chatRoomWithCursors(room, peerLastReadMessageId: payload.lastReadMessageId));
      return;
    }
    final member = state.members[payload.userId];
    if (member != null) {
      state = state.copyWith(
        members: {...state.members, payload.userId: _memberWithCursor(member, payload.lastReadMessageId)},
      );
    }
  }

  void _onMemberChanged(RoomMemberChangedPayload payload) {
    final aboutMe = payload.userId == _me;
    if (aboutMe &&
        (payload.change == RoomMemberChangedPayloadChange.left ||
            payload.change == RoomMemberChangedPayloadChange.removed)) {
      // Keluar/dikeluarkan: subscription dicabut server dan riwayat tidak lagi dapat dibaca (AC F11-4).
      _outbox.clearRoom(roomId);
      state = state.copyWith(gone: true);
      ref.read(chatListRefreshProvider.notifier).request();
      return;
    }
    unawaited(refreshRoom());
  }

  /// Memuat ulang detail room (izin kirim, mute, nama, jumlah anggota) dan anggota grup.
  Future<void> refreshRoom() async {
    if (!ref.mounted || state.gone) return;
    try {
      final room = await _repo.getRoom(roomId);
      final members = await _loadMembers(room);
      if (!ref.mounted) return;
      state = state.copyWith(room: room, members: members);
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      _handleLoadError(error);
    }
  }

  /// Menandai pesan terbaru yang sudah ditampilkan sebagai terbaca (read cursor monoton, PRD 3.11). Dipanggil layar
  /// saat daftar berada di bawah; permintaan yang tumpang tindih digabung.
  Future<void> markLatestRead() async {
    if (!ref.mounted || state.gone || state.membershipLapsed) return;
    final room = state.room;
    final newest = state.timeline.newest;
    if (room == null || newest == null) return;
    final current = room.lastReadMessageId;
    if (current != null) {
      final currentIndex = state.timeline.indexOf(current);
      if (currentIndex >= 0 && currentIndex >= state.timeline.indexOf(newest.id)) return;
      if (current == newest.id) return;
    }
    if (_readInFlight) {
      _readAgain = true;
      return;
    }
    _readInFlight = true;
    try {
      final read = await _repo.markRead(roomId, newest.id);
      if (!ref.mounted) return;
      final latestRoom = state.room;
      final cursor = read.lastReadMessageId;
      if (latestRoom != null && cursor != null) {
        state = state.copyWith(room: chatRoomWithCursors(latestRoom, lastReadMessageId: cursor));
      }
      final listProvider = chatRoomListProvider(room.kind);
      if (ref.exists(listProvider)) ref.read(listProvider.notifier).markRoomRead(roomId, unreadCount: read.unreadCount);
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      _handleLoadError(error);
    } finally {
      _readInFlight = false;
    }
    if (_readAgain && ref.mounted) {
      _readAgain = false;
      await markLatestRead();
    }
  }

  /// Validasi teks (D5 v3.2): 1..4000 karakter dan tidak hanya spasi. Null bila sah.
  static String? validateText(String text) {
    if (text.trim().isEmpty) return 'Pesan tidak boleh kosong.';
    if (chatTextLength(text) > maxChatTextChars) return 'Pesan maksimal $maxChatTextChars karakter.';
    return null;
  }

  /// Menulis dan mengirim pesan teks. Mengembalikan galat validasi, atau null bila pesan masuk antrean.
  String? sendText(String text, {OutgoingReply? replyTo}) {
    final invalid = validateText(text);
    if (invalid != null) return invalid;
    _refreshMembership();
    _outbox.sendText(roomId, text, replyTo: replyTo, holdReason: state.membershipLapsed ? membershipHoldMessage : null);
    return null;
  }

  /// Menulis dan mengirim pesan gambar dengan keterangan opsional (maksimal 4000 karakter).
  String? sendImage(OutgoingImage image, {String? caption, OutgoingReply? replyTo}) {
    if (caption != null && chatTextLength(caption) > maxChatTextChars) {
      return 'Keterangan maksimal $maxChatTextChars karakter.';
    }
    _refreshMembership();
    _outbox.sendImage(
      roomId,
      image,
      caption: caption,
      replyTo: replyTo,
      holdReason: state.membershipLapsed ? membershipHoldMessage : null,
    );
    return null;
  }

  void retry(String clientMessageId) {
    _refreshMembership();
    if (state.membershipLapsed) return;
    _outbox.retry(roomId, clientMessageId);
  }

  void discard(String clientMessageId) => _outbox.discard(roomId, clientMessageId);

  /// Hapus pesan sendiri menjadi placeholder (chat.yaml deleteChatMessage).
  Future<void> deleteMessage(String messageId) async {
    final placeholder = await _repo.deleteMessage(roomId, messageId);
    if (!ref.mounted) return;
    _applyTimeline((t) => t.upsert(placeholder));
  }

  /// Tambah/hapus reaksi emoji sendiri (idempoten di server).
  Future<void> toggleReaction(ChatMessage message, String emoji) async {
    final mine = message.reactions.any((r) => r.emoji == emoji && r.reactedByMe);
    final result = mine
        ? await _repo.removeReaction(roomId, message.id, emoji)
        : await _repo.addReaction(roomId, message.id, emoji);
    if (!ref.mounted) return;
    _applyTimeline((t) => t.replaceReactions(result.messageId, result.reactions));
  }

  /// Emit `typing {room_id}` saat pengguna mengetik, dibatasi [typingEmitInterval].
  void notifyTyping() {
    if (state.membershipLapsed || !(state.room?.canSend ?? false)) return;
    final now = _deviceNow();
    final last = _lastTypingSent;
    if (last != null && now.difference(last) < typingEmitInterval) return;
    _lastTypingSent = now;
    ref.read(chatRealtimeProvider).sendTyping(roomId);
  }

  /// Membuang penanda mengetik/daring yang TTL-nya habis (dipanggil penghitung waktu layar).
  void pruneEphemeral() {
    if (!ref.mounted) return;
    final now = _deviceNow();
    final typing = {
      for (final e in state.typing.entries)
        if (e.value.isAfter(now)) e.key: e.value,
    };
    final online = {
      for (final e in state.online.entries)
        if (e.value.isAfter(now)) e.key: e.value,
    };
    if (typing.length != state.typing.length || online.length != state.online.length) {
      state = state.copyWith(typing: typing, online: online);
    }
  }
}
