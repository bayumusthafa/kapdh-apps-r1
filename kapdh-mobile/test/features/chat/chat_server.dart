import 'package:dio/dio.dart';

import '../../support/fakes.dart';
import 'chat_fixtures.dart';

/// Server chat tiruan untuk satu room: riwayat keyset (created_at, id) dengan semantik `before`/`after` chat.yaml,
/// kirim pesan (ack sesudah commit, pengulangan client_message_id mengembalikan pesan yang sama), read cursor,
/// reaksi, hapus, anggota dan detail room.
class FakeChatServer {
  FakeChatServer({this.roomId = 'room-1', Map<String, Object?>? room, List<Map<String, Object?>>? messages})
    : room = room ?? roomJson(id: roomId),
      messages = [...?messages];

  final String roomId;
  Map<String, Object?> room;
  List<Map<String, Object?>> messages;
  List<Map<String, Object?>> members = [];
  List<Map<String, Object?>> invited = [];

  /// Galat yang dikembalikan untuk path tertentu (mis. 403 MEMBERSHIP_REQUIRED saat kirim).
  final Map<String, FakeResponse Function()> failures = {};
  int _seq = 100;

  String get base => '/chat/rooms/$roomId';

  int _compare(Map<String, Object?> a, Map<String, Object?> b) {
    final t = DateTime.parse(a['created_at']! as String).compareTo(DateTime.parse(b['created_at']! as String));
    return t != 0 ? t : (a['id']! as String).compareTo(b['id']! as String);
  }

  List<Map<String, Object?>> get sorted => [...messages]..sort(_compare);

  /// Pesan baru di server (commit) dengan waktu sesudah semua pesan yang ada.
  Map<String, Object?> commit({String? id, String senderId = 'user-2', String body = 'Pesan', String? clientId}) {
    final n = ++_seq;
    final message = chatMessageJson(
      id: id ?? 'm-$n',
      roomId: roomId,
      clientMessageId: clientId,
      senderId: senderId,
      senderName: senderId == 'user-1' ? 'Ahmad Islam' : 'Gamerisa Dewi',
      body: body,
      createdAt: at(n),
    );
    messages.add(message);
    return message;
  }

  FakeResponse _page(RequestOptions options) {
    final q = options.queryParameters;
    final limit = int.tryParse('${q['limit'] ?? 30}') ?? 30;
    final before = q['before'] as String?;
    final after = q['after'] as String?;
    final list = sorted;
    if (after != null) {
      final index = list.indexWhere((m) => m['id'] == after);
      if (index < 0) return FakeResponse.json(400, errorJson('VALIDATION_ERROR', 'Jangkar tidak sah'));
      final newer = list.sublist(index + 1);
      final page = newer.take(limit).toList();
      return FakeResponse.json(
        200,
        pageJson(page, nextCursor: newer.length > limit ? page.last['id'] as String : null),
      );
    }
    final end = before == null ? list.length : list.indexWhere((m) => m['id'] == before);
    final start = end - limit < 0 ? 0 : end - limit;
    final page = list.sublist(start, end);
    return FakeResponse.json(200, pageJson(page, nextCursor: start > 0 ? page.first['id'] as String : null));
  }

  FakeResponse _send(RequestOptions options) {
    final body = Map<String, Object?>.from(options.data as Map);
    final clientId = body['client_message_id']! as String;
    for (final existing in messages) {
      if (existing['client_message_id'] == clientId) return FakeResponse.json(200, existing);
    }
    final n = ++_seq;
    final message = chatMessageJson(
      id: 'm-$n',
      roomId: roomId,
      clientMessageId: clientId,
      senderId: 'user-1',
      senderName: 'Ahmad Islam',
      body: body['body'] as String?,
      createdAt: at(n),
    );
    messages.add(message);
    return FakeResponse.json(201, message);
  }

  FakeResponse? handle(RequestOptions options) {
    final failure = failures['${options.method} ${options.path}'];
    if (failure != null) return failure();
    final path = options.path;
    if (path == base && options.method == 'GET') return FakeResponse.json(200, room);
    if (path == '$base/messages' && options.method == 'GET') return _page(options);
    if (path == '$base/messages' && options.method == 'POST') return _send(options);
    if (path == '$base/members' && options.method == 'GET') {
      final status = options.queryParameters['status'];
      return FakeResponse.json(200, pageJson(status == 'invited' ? invited : members));
    }
    if (path == '$base/read' && options.method == 'PUT') {
      final id = (options.data as Map)['message_id'] as String;
      room = {...room, 'last_read_message_id': id, 'unread_count': 0};
      return FakeResponse.json(200, readStateJson(roomId: roomId, lastRead: id));
    }
    if (path.startsWith('$base/messages/') && !path.contains('/reactions/') && options.method == 'DELETE') {
      final id = path.substring('$base/messages/'.length);
      final index = messages.indexWhere((m) => m['id'] == id);
      if (index < 0) return FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan'));
      final m = messages[index];
      messages[index] = {...m, 'body': null, 'image': null, 'reactions': const <Object?>[], 'deleted_at': iso(at(900))};
      return FakeResponse.json(200, messages[index]);
    }
    if (path.contains('/reactions/')) {
      final segments = path.split('/');
      final messageId = segments[segments.length - 3];
      final emoji = Uri.decodeComponent(segments.last);
      final add = options.method == 'PUT';
      final index = messages.indexWhere((m) => m['id'] == messageId);
      final reactions = add
          ? [
              {'emoji': emoji, 'count': 1, 'reacted_by_me': true},
            ]
          : const <Map<String, Object?>>[];
      messages[index] = {...messages[index], 'reactions': reactions};
      return FakeResponse.json(200, {'message_id': messageId, 'reactions': reactions});
    }
    return null;
  }

  /// Penangan HTTP: room ini lalu [fallback].
  FakeHandler handler([FakeHandler? fallback]) => (options) {
    final response = handle(options);
    if (response != null) return response;
    if (fallback != null) return fallback(options);
    return FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan (uji): ${options.path}'));
  };
}
