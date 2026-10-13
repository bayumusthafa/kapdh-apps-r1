import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/idempotency_store.dart';

/// Ukuran halaman bawaan riwayat dan daftar (ARCHITECTURE §4.10: bawaan 30, maksimum 100).
const int chatPageSize = 30;

/// Ukuran halaman sinkron `after` setelah reconnect: maksimum kontrak agar celah panjang cepat tertutup (AC F11-3).
const int chatSyncPageSize = 100;

/// Kebijakan tanpa retry otomatis Riverpod: galat API (403/404) tidak berubah bila diulang; pengguna memakai tombol
/// "Coba lagi" (PRD 4.5).
Duration? noAutoRetry(int retryCount, Object error) => null;

final chatRepositoryProvider = Provider<ChatRepository>(
  (ref) => ChatRepository(ref.watch(kapdhApiProvider), ref.watch(idempotencyStoreProvider)),
);

/// Akses domain chat (chat.yaml, F-11) lewat SDK terbangkit. Operasi ber-`x-kapdh-access.idempotent` memakai
/// Idempotency-Key yang disimpan sampai hasilnya pasti (PRD 4.3), sehingga ketukan ulang setelah jaringan putus tidak
/// membuat grup/undangan ganda. Pengiriman pesan memakai `client_message_id` (AC F11-2), bukan Idempotency-Key.
class ChatRepository {
  ChatRepository(this._api, this._idempotency);

  final KapdhApi _api;
  final IdempotencyStore _idempotency;

  ChatApi get _chat => _api.chat;

  Future<ChatRoomPage> listRooms({ChatRoomKind? kind, String? cursor, int limit = chatPageSize}) =>
      _chat.listChatRooms(kind: kind, cursor: cursor, limit: limit);

  Future<ChatRoom> getRoom(String roomId) => _chat.getChatRoom(roomId);

  /// Room direct kanonik (AC F11-1): 200 room lama atau 201 room baru; keduanya mengembalikan [ChatRoom].
  Future<ChatRoom> openDirect(String userId) => _chat.openDirectRoom(ChatDirectRoomRequest(userId: userId));

  Future<ChatGroupCreated> createGroup(ChatGroupCreateRequest request) => _idempotency.run(
    'chat.group.create',
    request.toJson(),
    (key) => _chat.createChatGroup(request, idempotencyKey: key),
  );

  /// Ubah nama/avatar grup dengan If-Match versi room (409 VERSION_CONFLICT bila berubah, AC F15-4 pola).
  Future<ChatRoom> updateRoom(String roomId, ChatRoomUpdate update, {required String version}) =>
      _chat.updateChatRoom(roomId, update, ifMatch: version);

  Future<ChatRoomMemberPage> listMembers(
    String roomId, {
    ChatMemberListStatus status = ChatMemberListStatus.joined,
    String? cursor,
    int limit = 100,
  }) => _chat.listChatRoomMembers(roomId, status: status, cursor: cursor, limit: limit);

  Future<ChatRoomMember> setRole(String roomId, String userId, ChatMemberRole role) =>
      _chat.updateChatRoomMember(roomId, userId, ChatMemberUpdate(role: role));

  /// Keluarkan anggota joined atau batalkan undangan tertunda (AC F11-4).
  Future<void> removeMember(String roomId, String userId) => _idempotency.run('chat.member.remove.$roomId.$userId', {
    'room_id': roomId,
    'user_id': userId,
  }, (key) => _chat.removeChatRoomMember(roomId, userId, idempotencyKey: key));

  Future<ChatInviteOutcome> invite(String roomId, List<String> userIds) {
    final request = ChatInviteRequest(userIds: userIds);
    return _idempotency.run(
      'chat.invite.$roomId',
      request.toJson(),
      (key) => _chat.inviteChatMembers(roomId, request, idempotencyKey: key),
    );
  }

  Future<ChatInvitationPage> listInvitations({String? cursor, int limit = chatPageSize}) =>
      _chat.listChatInvitations(cursor: cursor, limit: limit);

  Future<ChatRoom> acceptInvitation(String roomId) => _idempotency.run('chat.invitation.accept.$roomId', {
    'room_id': roomId,
  }, (key) => _chat.acceptChatInvitation(roomId, idempotencyKey: key));

  Future<void> declineInvitation(String roomId) => _idempotency.run('chat.invitation.decline.$roomId', {
    'room_id': roomId,
  }, (key) => _chat.declineChatInvitation(roomId, idempotencyKey: key));

  /// Keluar grup; admin terakhir wajib menunjuk [successorUserId] (AC F11-5).
  Future<void> leave(String roomId, {String? successorUserId}) {
    final request = ChatLeaveRequest(successorUserId: successorUserId);
    return _idempotency.run(
      'chat.leave.$roomId',
      request.toJson(),
      (key) => _chat.leaveChatRoom(roomId, request, idempotencyKey: key),
    );
  }

  Future<void> setMuted(String roomId, {required bool muted}) =>
      _chat.setChatRoomMute(roomId, ChatMuteRequest(muted: muted));

  /// Riwayat keyset (AC F11-3): tanpa cursor = halaman terbaru; `before`/`after` = ID pesan jangkar.
  Future<ChatMessagePage> listMessages(String roomId, {String? before, String? after, int limit = chatPageSize}) =>
      _chat.listChatMessages(roomId, before: before, after: after, limit: limit);

  /// Ack sesudah commit; pengulangan `client_message_id` mengembalikan pesan yang sama (AC F11-2).
  Future<ChatMessage> send(String roomId, ChatSendMessageRequest request) => _chat.sendChatMessage(roomId, request);

  Future<ChatMessage> deleteMessage(String roomId, String messageId) => _chat.deleteChatMessage(roomId, messageId);

  Future<ChatMessageReactions> addReaction(String roomId, String messageId, String emoji) =>
      _chat.addChatReaction(roomId, messageId, emoji);

  Future<ChatMessageReactions> removeReaction(String roomId, String messageId, String emoji) =>
      _chat.removeChatReaction(roomId, messageId, emoji);

  /// Read cursor monoton (server tidak memundurkan cursor oleh paket terlambat, PRD 3.11).
  Future<ChatReadState> markRead(String roomId, String messageId) =>
      _chat.markChatRoomRead(roomId, ChatReadRequest(messageId: messageId));

  /// Unggah gambar chat (purpose chat_image, N-10); berkas privat dan hanya dapat diakses anggota room (AC F11-4).
  Future<FileRef> uploadChatImage(Uint8List bytes, {required String filename, required String mime}) =>
      _api.files.uploadFile(
        FileUploadRequest(
          purpose: FileUploadPurpose.chatImage,
          file: MultipartFile.fromBytes(bytes, filename: filename, contentType: DioMediaType.parse(mime)),
        ),
      );
}
