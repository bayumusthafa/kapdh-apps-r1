import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import 'chat_list_controller.dart';
import 'chat_outbox.dart';
import 'chat_realtime.dart';
import 'chat_repository.dart';
import 'chat_room_controller.dart';

/// Keadaan layar info percakapan.
@immutable
class ChatInfoState {
  const ChatInfoState({this.room, this.joined = const [], this.invited = const [], this.error, this.gone = false});

  final ChatRoom? room;

  /// Anggota joined (admin dulu, lalu nama; chat.yaml listChatRoomMembers).
  final List<ChatRoomMember> joined;

  /// Undangan tertunda; hanya dimuat untuk admin grup.
  final List<ChatRoomMember> invited;
  final ApiException? error;

  /// Bukan lagi anggota joined (AC F11-4).
  final bool gone;

  bool get loaded => room != null;

  ChatRoomMember? get me {
    for (final member in joined) {
      if (member.isMe) return member;
    }
    return null;
  }

  /// Anggota joined selain pemanggil.
  List<ChatRoomMember> get others => joined.where((m) => !m.isMe).toList();

  /// Pemanggil admin terakhir sementara masih ada anggota lain: keluar wajib menunjuk pengganti (AC F11-5).
  bool get mustChooseSuccessor {
    final room = this.room;
    if (room == null || room.kind != ChatRoomKind.group || room.myRole != ChatMemberRole.admin) return false;
    final admins = joined.where((m) => m.role == ChatMemberRole.admin).length;
    return admins <= 1 && others.isNotEmpty;
  }
}

/// Info percakapan (F-11, F-12): anggota, undangan tertunda (admin), mute, ubah grup, kelola peran, keluarkan,
/// undang, keluar grup dengan pengganti admin. Event realtime room ini memuat ulang data dari server.
final chatInfoProvider = NotifierProvider.autoDispose.family<ChatInfoController, ChatInfoState, String>(
  ChatInfoController.new,
);

class ChatInfoController extends Notifier<ChatInfoState> {
  ChatInfoController(this.roomId);

  final String roomId;

  ChatRepository get _repo => ref.read(chatRepositoryProvider);

  @override
  ChatInfoState build() {
    final events = ref.watch(chatRealtimeProvider).events.listen((event) {
      final affectsRoom = switch (event) {
        RoomUpdatedEvent(:final payload) => payload.roomId == roomId,
        RoomMemberChangedEvent(:final payload) => payload.roomId == roomId,
        _ => false,
      };
      if (affectsRoom) unawaited(load());
    });
    ref.onDispose(() => unawaited(events.cancel()));
    Future.microtask(load);
    return const ChatInfoState();
  }

  Future<void> load() async {
    if (!ref.mounted) return;
    try {
      final room = await _repo.getRoom(roomId);
      var joined = const <ChatRoomMember>[];
      var invited = const <ChatRoomMember>[];
      if (room.kind == ChatRoomKind.group) {
        joined = (await _repo.listMembers(roomId)).items;
        if (room.canManage) invited = (await _repo.listMembers(roomId, status: ChatMemberListStatus.invited)).items;
      }
      if (!ref.mounted) return;
      state = ChatInfoState(room: room, joined: joined, invited: invited);
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      if (error.code == ErrorCode.notFound) {
        ref.read(chatOutboxProvider.notifier).clearRoom(roomId);
        state = ChatInfoState(gone: true, error: error);
        return;
      }
      state = ChatInfoState(room: state.room, joined: state.joined, invited: state.invited, error: error);
    }
  }

  /// Memperbarui layar percakapan dan daftar room yang sedang terbuka.
  void _propagate() {
    final roomProvider = chatRoomControllerProvider(roomId);
    if (ref.exists(roomProvider)) unawaited(ref.read(roomProvider.notifier).refreshRoom());
    ref.read(chatListRefreshProvider.notifier).request();
  }

  Future<void> _mutate(Future<void> Function() action) async {
    await action();
    _propagate();
    await load();
  }

  /// Ubah nama/foto grup dengan If-Match (409 VERSION_CONFLICT: data terbaru dari `current` dipasang lalu galat
  /// diteruskan agar pengguna memuat ulang, pola AC F15-4).
  Future<void> updateGroup(ChatRoomUpdate update) => _mutate(() async {
    final room = state.room;
    if (room == null) return;
    try {
      final updated = await _repo.updateRoom(roomId, update, version: room.version);
      if (ref.mounted) state = ChatInfoState(room: updated, joined: state.joined, invited: state.invited);
    } on ApiException catch (error) {
      final current = error.current;
      if (error.code == ErrorCode.versionConflict && current is Map<String, Object?> && ref.mounted) {
        state = ChatInfoState(room: ChatRoom.fromJson(current), joined: state.joined, invited: state.invited);
      }
      rethrow;
    }
  });

  Future<void> setMuted(bool muted) => _mutate(() => _repo.setMuted(roomId, muted: muted));

  Future<void> setRole(String userId, ChatMemberRole role) => _mutate(() => _repo.setRole(roomId, userId, role));

  /// Keluarkan anggota joined atau batalkan undangan tertunda (AC F11-4).
  Future<void> remove(String userId) => _mutate(() => _repo.removeMember(roomId, userId));

  Future<ChatInviteOutcome> invite(List<String> userIds) async {
    final outcome = await _repo.invite(roomId, userIds);
    _propagate();
    await load();
    return outcome;
  }

  /// Keluar grup; admin terakhir wajib menunjuk [successorUserId] (AC F11-5). Setelah keluar riwayat tidak lagi dapat
  /// dibaca dan antrean pesan lokal room ini dibuang (AC F11-4).
  Future<void> leave({String? successorUserId}) async {
    await _repo.leave(roomId, successorUserId: successorUserId);
    ref.read(chatOutboxProvider.notifier).clearRoom(roomId);
    ref.read(chatListRefreshProvider.notifier).request();
    if (ref.mounted) state = const ChatInfoState(gone: true);
  }
}
