import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/chat/chat_sync.dart';
import 'package:kapdh_mobile/features/chat/chat_timeline.dart';

import '../../support/fakes.dart';
import 'chat_fixtures.dart';

/// Server tiruan: riwayat urut (created_at, id) dengan semantik `before`/`after`/tanpa cursor chat.yaml
/// listChatMessages.
class _FakeHistory {
  _FakeHistory(this.messages);

  List<ChatMessage> messages;
  final List<String> calls = [];
  Set<String> invalidAnchors = {};

  Future<ChatMessagePage> fetch({String? before, String? after, required int limit}) async {
    calls.add(after != null ? 'after:$after' : (before != null ? 'before:$before' : 'latest'));
    final sorted = [...messages]..sort(compareMessages);
    if (after != null) {
      if (invalidAnchors.contains(after)) throw apiError(400, 'VALIDATION_ERROR', 'Jangkar tidak sah');
      final index = sorted.indexWhere((m) => m.id == after);
      final newer = sorted.sublist(index + 1);
      final page = newer.take(limit).toList();
      return pageOf(page, nextCursor: newer.length > limit ? page.last.id : null);
    }
    final end = before == null ? sorted.length : sorted.indexWhere((m) => m.id == before);
    final start = end - limit < 0 ? 0 : end - limit;
    final page = sorted.sublist(start, end);
    return pageOf(page, nextCursor: start > 0 ? page.first.id : null);
  }
}

ChatMessage _m(int n, {String sender = 'user-2', DateTime? deletedAt}) =>
    messageOf(id: 'm-${n.toString().padLeft(3, '0')}', createdAt: at(n), senderId: sender, deletedAt: deletedAt);

void main() {
  group('ChatTimeline (AC F11-3, N-02)', () {
    test('AC F11-3: urutan (created_at, id), gabung berdasarkan id tanpa duplikat', () {
      final timeline = ChatTimeline.empty.applyLatestPage(pageOf([_m(1), _m(2), _m(3)]));
      final merged = timeline.upsert(_m(2)).upsert(_m(5)).upsert(_m(4));
      expect(merged.messages.map((m) => m.id), ['m-001', 'm-002', 'm-003', 'm-004', 'm-005']);
      // Waktu sama: id menjadi pemecah seri.
      final tie = merged.upsert(messageOf(id: 'm-0045', createdAt: at(4)));
      expect(tie.messages.map((m) => m.id).toList().sublist(3), ['m-004', 'm-0045', 'm-005']);
    });

    test('AC F11-3: jangkar sinkron hanya maju dari halaman HTTP, bukan dari event message.created', () {
      final timeline = ChatTimeline.empty.applyLatestPage(pageOf([_m(1), _m(2)]));
      expect(timeline.syncAnchor, 'm-002');
      final withEvent = timeline.upsert(_m(9));
      expect(withEvent.syncAnchor, 'm-002', reason: 'event tidak memajukan jangkar');
      final synced = withEvent.applyAfterPage(pageOf([_m(3), _m(9)]));
      expect(synced.syncAnchor, 'm-009');
      expect(synced.messages.map((m) => m.id), ['m-001', 'm-002', 'm-003', 'm-009']);
    });

    test('halaman lama (before) menambah riwayat di atas tanpa mengubah jangkar', () {
      final latest = ChatTimeline.empty.applyLatestPage(pageOf([_m(3), _m(4)], nextCursor: 'm-003'));
      expect(latest.hasOlder, isTrue);
      final older = latest.applyOlderPage(pageOf([_m(1), _m(2)]));
      expect(older.messages.first.id, 'm-001');
      expect(older.syncAnchor, 'm-004');
      expect(older.hasOlder, isFalse);
    });

    test('message.deleted menjadi placeholder tanpa isi dan reaksi', () {
      final timeline = ChatTimeline.empty.applyLatestPage(
        pageOf([
          messageOf(
            id: 'm-1',
            reactions: [
              {'emoji': '👍', 'count': 2, 'reacted_by_me': true},
            ],
          ),
        ]),
      );
      final deleted = timeline.markDeleted('m-1', at(100));
      expect(deleted.messages.single.body, isNull);
      expect(deleted.messages.single.reactions, isEmpty);
      expect(deleted.messages.single.deletedAt, at(100));
    });

    test('reaction.updated: hitungan dari server, reacted_by_me dari pelaku event', () {
      final timeline = ChatTimeline.empty.applyLatestPage(pageOf([messageOf(id: 'm-1')]));
      final event = RealtimeEvent.fromJson(
        reactionUpdated('m-1', 'user-1', '👍', 'added', [
          {'emoji': '👍', 'count': 1},
        ]),
      );
      final mine = timeline.applyReactionEvent((event as ReactionUpdatedEvent).payload, myUserId: 'user-1');
      expect(mine.messages.single.reactions.single.reactedByMe, isTrue);
      final other = timeline.applyReactionEvent(event.payload, myUserId: 'user-3');
      expect(other.messages.single.reactions.single.reactedByMe, isFalse);
    });

    test('status terbaca: cursor di jendela lokal dan tidak mengklaim terbaca tanpa bukti', () {
      final timeline = ChatTimeline.empty.applyLatestPage(pageOf([_m(1), _m(2), _m(3)]));
      expect(timeline.isReadBy('m-002', timeline.messages[0]), isTrue);
      expect(timeline.isReadBy('m-002', timeline.messages[1]), isTrue);
      expect(timeline.isReadBy('m-002', timeline.messages[2]), isFalse);
      expect(timeline.isReadBy(null, timeline.messages[0]), isFalse);
      expect(timeline.isReadBy('tidak-ada', timeline.messages[0]), isFalse);
    });

    test('pesan optimistis dicocokkan dengan client_message_id milik pengirim (AC F11-2)', () {
      final timeline = ChatTimeline.empty.applyLatestPage(
        pageOf([messageOf(id: 'm-1', senderId: 'user-1', clientMessageId: 'c-1')]),
      );
      expect(timeline.byClientId('user-1', 'c-1')?.id, 'm-1');
      expect(timeline.byClientId('user-2', 'c-1'), isNull);
    });
  });

  group('syncTimeline setelah reconnect (AC F11-3, N-02)', () {
    test('AC F11-3: after=<jangkar> diulang sampai next_cursor null; pesan yang terlewat event tidak hilang', () async {
      final server = _FakeHistory([for (var i = 1; i <= 5; i++) _m(i)]);
      var timeline = ChatTimeline.empty.applyLatestPage(await server.fetch(limit: 30));
      expect(timeline.syncAnchor, 'm-005');
      // Koneksi putus: 7 pesan commit; hanya m-008 yang sempat tiba lewat event.
      server.messages = [...server.messages, for (var i = 6; i <= 12; i++) _m(i)];
      timeline = timeline.upsert(_m(8));

      final synced = await syncTimeline(timeline, server.fetch, pageSize: 30, syncPageSize: 3);
      expect(synced.messages.map((m) => m.id), [for (var i = 1; i <= 12; i++) 'm-${i.toString().padLeft(3, '0')}']);
      expect(synced.messages.where((m) => m.id == 'm-008'), hasLength(1), reason: 'tanpa duplikasi');
      expect(synced.syncAnchor, 'm-012');
      expect(server.calls.where((c) => c.startsWith('after:')), ['after:m-005', 'after:m-008', 'after:m-011']);
    });

    test('AC F11-3: penghapusan saat offline diterapkan dengan memuat ulang jendela yang ditampilkan', () async {
      final server = _FakeHistory([for (var i = 1; i <= 4; i++) _m(i)]);
      var timeline = ChatTimeline.empty.applyLatestPage(await server.fetch(limit: 30));
      server.messages = [_m(1), _m(2, deletedAt: at(50)), _m(3), _m(4)];
      timeline = await syncTimeline(timeline, server.fetch);
      expect(timeline.byId('m-002')!.deletedAt, isNotNull);
      expect(timeline.byId('m-002')!.body, isNull);
    });

    test('jendela lama yang sudah digulir ikut dimuat ulang lewat before', () async {
      final server = _FakeHistory([for (var i = 1; i <= 6; i++) _m(i)]);
      var timeline = ChatTimeline.empty.applyLatestPage(await server.fetch(limit: 3));
      timeline = timeline.applyOlderPage(await server.fetch(before: timeline.olderCursor, limit: 3));
      expect(timeline.messages, hasLength(6));
      server.messages = [_m(1, deletedAt: at(70)), ...server.messages.sublist(1)];
      server.calls.clear();
      timeline = await syncTimeline(timeline, server.fetch, pageSize: 3);
      expect(server.calls, contains('before:m-004'));
      expect(timeline.byId('m-001')!.deletedAt, isNotNull);
    });

    test('jangkar tidak lagi sah (400): garis waktu dimulai ulang dari halaman terbaru', () async {
      final server = _FakeHistory([_m(1), _m(2)]);
      final timeline = ChatTimeline.empty.applyLatestPage(await server.fetch(limit: 30));
      server.invalidAnchors = {'m-002'};
      server.messages = [_m(3), _m(4)];
      final synced = await syncTimeline(timeline, server.fetch);
      expect(synced.messages.map((m) => m.id), ['m-003', 'm-004']);
      expect(synced.syncAnchor, 'm-004');
    });

    test('belum ada jangkar: halaman terbaru dimuat', () async {
      final server = _FakeHistory([_m(1)]);
      final synced = await syncTimeline(ChatTimeline.empty, server.fetch);
      expect(synced.loaded, isTrue);
      expect(synced.syncAnchor, 'm-001');
    });

    test('galat jaringan diteruskan agar data lokal tetap tampil', () async {
      final timeline = ChatTimeline.empty.applyLatestPage(pageOf([_m(1)]));
      await expectLater(
        syncTimeline(timeline, ({String? before, String? after, required int limit}) async => throw networkError()),
        throwsA(isA<ApiException>()),
      );
    });
  });
}
