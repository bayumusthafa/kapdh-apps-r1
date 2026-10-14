import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/features/chat/chat_outbox.dart';
import 'package:kapdh_mobile/features/chat/chat_room_controller.dart';
import 'package:kapdh_mobile/features/chat/outgoing_message.dart';

import '../../support/fakes.dart';
import 'chat_fixtures.dart';
import 'chat_server.dart';

typedef _Harness = ({ProviderContainer container, FakeChatServer server, FakeChatRealtime realtime, TestClock clock});

Future<_Harness> _open({
  FakeChatServer? server,
  int initialMessages = 5,
  SessionStateFactory? session,
  List<String> clientIds = const [],
}) async {
  final chat = server ?? FakeChatServer();
  if (server == null) {
    for (var i = 0; i < initialMessages; i++) {
      chat.commit();
    }
  }
  final realtime = FakeChatRealtime();
  final clock = TestClock();
  final container = chatContainer(
    handler: chat.handler(),
    realtime: realtime,
    clock: clock,
    session: session?.call(),
    clientIds: clientIds,
  );
  container.listen(chatRoomControllerProvider('room-1'), (_, _) {});
  await settleAsync();
  return (container: container, server: chat, realtime: realtime, clock: clock);
}

typedef SessionStateFactory = SessionState Function();

ChatRoomViewState _state(_Harness h) => h.container.read(chatRoomControllerProvider('room-1'));
ChatRoomController _controller(_Harness h) => h.container.read(chatRoomControllerProvider('room-1').notifier);
List<String> _ids(_Harness h) => _state(h).timeline.messages.map((m) => m.id).toList();
List<OutgoingMessage> _outbox(_Harness h) => h.container.read(chatOutboxProvider)['room-1'] ?? const [];

void main() {
  group('ChatRoomController (F-11; AC F11-2, F11-3, F11-4, F11-6; N-02)', () {
    test('membuka room: detail dan halaman terbaru lewat HTTP; jangkar = pesan terbaru halaman', () async {
      final h = await _open();
      expect(_state(h).loaded, isTrue);
      expect(_ids(h), ['m-101', 'm-102', 'm-103', 'm-104', 'm-105']);
      expect(_state(h).timeline.syncAnchor, 'm-105');
    });

    test('N-02: message.created ditambahkan seketika tanpa duplikat dan tanpa memajukan jangkar', () async {
      final h = await _open();
      final message = h.server.commit();
      h.realtime
        ..emit(messageCreated(message))
        ..emit(messageCreated(message, eventId: 'evt-ulang'));
      await settleAsync(ticks: 2);
      expect(_ids(h).last, message['id']);
      expect(_ids(h).where((id) => id == message['id']), hasLength(1));
      expect(_state(h).timeline.syncAnchor, 'm-105');
    });

    test(
      'AC F11-3: setelah reconnect, pesan yang tidak sempat menerima event disinkron lewat after=<jangkar>',
      () async {
        final h = await _open();
        // Koneksi putus; tiga pesan commit, hanya satu yang sempat tiba lewat event.
        h.realtime.state.value = RealtimeConnectionState.disconnected;
        final missed1 = h.server.commit();
        final viaEvent = h.server.commit();
        final missed2 = h.server.commit();
        h.realtime.emit(messageCreated(viaEvent));
        await settleAsync(ticks: 2);
        expect(_ids(h).contains(missed1['id']), isFalse);

        adapterOf(h.container).requests.clear();
        h.realtime.reconnect();
        await settleAsync();

        expect(_ids(h).sublist(5), [missed1['id'], viaEvent['id'], missed2['id']]);
        expect(_state(h).timeline.syncAnchor, missed2['id']);
        final queries = adapterOf(h.container).requestsTo('/chat/rooms/room-1/messages').map((r) => r.queryParameters);
        expect(queries.first['after'], 'm-105');
        expect(_state(h).syncing, isFalse);
      },
    );

    test('AC F11-3: sinkron memuat ulang jendela sehingga penghapusan saat offline diterapkan', () async {
      final h = await _open();
      h.server.messages[1] = {...h.server.messages[1], 'body': null, 'deleted_at': iso(at(800))};
      h.realtime.reconnect();
      await settleAsync();
      expect(_state(h).timeline.byId('m-102')!.deletedAt, isNotNull);
      expect(_state(h).timeline.byId('m-102')!.body, isNull);
    });

    test('AC F11-2: respons kirim hilang, event milik sendiri melepas pesan dari antrean lokal', () async {
      final h = await _open(clientIds: ['c-1']);
      h.server.failures['POST /chat/rooms/room-1/messages'] = FakeResponse.network;
      expect(_controller(h).sendText('Halo semua'), isNull);
      await settleAsync();
      expect(_outbox(h).single.status, OutgoingStatus.failed);
      // Ternyata commit di server: event membawa client_message_id yang sama.
      h.server.failures.clear();
      final committed = h.server.commit(senderId: 'user-1', clientId: 'c-1', body: 'Halo semua');
      h.realtime.emit(messageCreated(committed));
      await settleAsync(ticks: 2);
      expect(_outbox(h), isEmpty);
      expect(_ids(h).last, committed['id']);
    });

    test('AC F11-2: kirim ulang memakai client_message_id yang sama dan server tidak menduplikasi', () async {
      final h = await _open(clientIds: ['c-5']);
      var attempts = 0;
      h.server.failures['POST /chat/rooms/room-1/messages'] = () {
        attempts++;
        // Server sudah commit tetapi respons hilang.
        h.server.commit(senderId: 'user-1', clientId: 'c-5', body: 'Uji');
        h.server.failures.clear();
        return FakeResponse.network();
      };
      _controller(h).sendText('Uji');
      await settleAsync();
      expect(attempts, 1);
      _controller(h).retry('c-5');
      await settleAsync();
      final mine = _state(h).timeline.messages.where((m) => m.clientMessageId == 'c-5').toList();
      expect(mine, hasLength(1));
      expect(h.server.messages.where((m) => m['client_message_id'] == 'c-5'), hasLength(1));
      expect(_outbox(h), isEmpty);
    });

    test('D5 v3.2: teks kosong atau lebih dari 4.000 karakter ditolak tanpa request', () async {
      final h = await _open();
      expect(_controller(h).sendText('   '), 'Pesan tidak boleh kosong.');
      expect(_controller(h).sendText('a' * (maxChatTextChars + 1)), 'Pesan maksimal 4000 karakter.');
      expect(_controller(h).sendText('a' * maxChatTextChars), isNull);
    });

    test('AC F11-6, PRD 4.5: expires_at sudah lewat -> ajakan perpanjang dan pesan ditahan tanpa request', () async {
      final h = await _open(
        session: () => activeSession(status: 'expiring', expiresAt: testNow.subtract(const Duration(minutes: 1))),
      );
      expect(_state(h).membershipLapsed, isTrue);
      adapterOf(h.container).requests.clear();
      expect(_controller(h).sendText('Tetap simpan'), isNull);
      await settleAsync();
      expect(_outbox(h).single.status, OutgoingStatus.held);
      expect(
        adapterOf(h.container).requestsTo('/chat/rooms/room-1/messages').where((r) => r.method == 'POST'),
        isEmpty,
      );
    });

    test(
      'PRD 4.5: 403 MEMBERSHIP_REQUIRED saat kirim menahan pesan; /me aktif kembali mengirim dengan id sama',
      () async {
        final h = await _open(clientIds: ['c-hold']);
        h.server.failures['POST /chat/rooms/room-1/messages'] = () =>
            FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Masa keanggotaan berakhir.'));
        _controller(h).sendText('Pesan penting');
        await settleAsync();
        expect(_outbox(h).single.status, OutgoingStatus.held);
        expect(_state(h).membershipLapsed, isTrue);

        // Perpanjangan disetujui: /me baru dengan masa berlaku di masa depan.
        h.server.failures.clear();
        (h.container.read(sessionProvider.notifier) as TestSession).set(
          activeSession(status: 'verified', expiresAt: testNow.add(const Duration(days: 365))),
        );
        await settleAsync();
        expect(_state(h).membershipLapsed, isFalse);
        expect(_outbox(h), isEmpty);
        expect(h.server.messages.where((m) => m['client_message_id'] == 'c-hold'), hasLength(1));
      },
    );

    test('AC F11-4: dikeluarkan dari grup -> percakapan tidak tersedia dan antrean lokal dibuang', () async {
      final h = await _open(clientIds: ['c-x']);
      h.server.failures['POST /chat/rooms/room-1/messages'] = FakeResponse.network;
      _controller(h).sendText('Belum terkirim');
      await settleAsync();
      expect(_outbox(h), hasLength(1));
      h.realtime.emit(memberChanged('user-1', 'removed', actor: 'user-9'));
      await settleAsync(ticks: 2);
      expect(_state(h).gone, isTrue);
      expect(_outbox(h), isEmpty);
    });

    test('AC F11-4: room bukan milik pemanggil (404) -> tidak tersedia', () async {
      final server = FakeChatServer();
      server.failures['GET /chat/rooms/room-1'] = () => FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ada'));
      final h = await _open(server: server);
      expect(_state(h).gone, isTrue);
      expect(_state(h).loaded, isFalse);
    });

    test('status terbaca: read.updated lawan bicara dan read cursor sendiri yang monoton', () async {
      final h = await _open();
      h.realtime.emit(readUpdated('user-2', 'm-104'));
      await settleAsync(ticks: 2);
      expect(_state(h).room!.peerLastReadMessageId, 'm-104');

      await _controller(h).markLatestRead();
      final reads = adapterOf(h.container).requestsTo('/chat/rooms/room-1/read');
      expect((reads.single.data as Map)['message_id'], 'm-105');
      expect(_state(h).room!.lastReadMessageId, 'm-105');
      // Sudah terbaca: tidak ada request ulang.
      await _controller(h).markLatestRead();
      expect(adapterOf(h.container).requestsTo('/chat/rooms/room-1/read'), hasLength(1));
    });

    test('indikator mengetik dan presence memakai TTL, bukan bukti dibaca', () async {
      final h = await _open();
      h.realtime
        ..emit(typingEvent('user-2', ttl: 5))
        ..emit(presenceEvent('user-2', ttl: 60));
      await settleAsync(ticks: 2);
      expect(_state(h).typing.keys, ['user-2']);
      expect(_state(h).online.keys, ['user-2']);
      h.clock.advance(const Duration(seconds: 6));
      _controller(h).pruneEphemeral();
      expect(_state(h).typing, isEmpty);
      expect(_state(h).online.keys, ['user-2']);
      // Pesan dari pengguna yang mengetik menghapus indikatornya.
      h.realtime.emit(typingEvent('user-2', ttl: 5));
      await settleAsync(ticks: 2);
      h.realtime.emit(messageCreated(h.server.commit()));
      await settleAsync(ticks: 2);
      expect(_state(h).typing, isEmpty);
    });

    test('emit typing dibatasi setiap 3 detik', () async {
      final h = await _open();
      _controller(h)
        ..notifyTyping()
        ..notifyTyping();
      expect(h.realtime.typing, ['room-1']);
      h.clock.advance(const Duration(seconds: 3));
      _controller(h).notifyTyping();
      expect(h.realtime.typing, ['room-1', 'room-1']);
    });

    test('hapus pesan dan reaksi memperbarui salinan lokal', () async {
      final h = await _open();
      final mine = h.server.commit(senderId: 'user-1');
      h.realtime.emit(messageCreated(mine));
      await settleAsync(ticks: 2);
      await _controller(h).toggleReaction(_state(h).timeline.byId('m-105')!, '👍');
      expect(_state(h).timeline.byId('m-105')!.reactions.single.reactedByMe, isTrue);
      await _controller(h).toggleReaction(_state(h).timeline.byId('m-105')!, '👍');
      expect(_state(h).timeline.byId('m-105')!.reactions, isEmpty);
      await _controller(h).deleteMessage(mine['id']! as String);
      expect(_state(h).timeline.byId(mine['id']! as String)!.deletedAt, isNotNull);
      h.realtime.emit(messageDeleted('m-101'));
      await settleAsync(ticks: 2);
      expect(_state(h).timeline.byId('m-101')!.deletedAt, isNotNull);
    });
  });
}
