import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/chat/chat_outbox.dart';
import 'package:kapdh_mobile/features/chat/outgoing_message.dart';

import '../../support/fakes.dart';
import 'chat_fixtures.dart';

const _messagesPath = '/chat/rooms/room-1/messages';

Map<String, Object?> _sentBody(RequestOptions options) => Map<String, Object?>.from(options.data as Map);

/// Pesan server untuk body kirim [body] (ack sesudah commit).
FakeResponse _ack(RequestOptions options, {int status = 201, String? id}) {
  final body = _sentBody(options);
  final clientId = body['client_message_id']! as String;
  return FakeResponse.json(
    status,
    chatMessageJson(
      id: id ?? 'srv-$clientId',
      clientMessageId: clientId,
      senderId: 'user-1',
      senderName: 'Ahmad Islam',
      body: body['body'] as String?,
      createdAt: at(10),
    ),
  );
}

Future<void> _flush() => settleAsync();

void main() {
  late FakeChatRealtime realtime;

  setUp(() => realtime = FakeChatRealtime());

  group('ChatOutbox (AC F11-2, PRD 4.3, 4.5)', () {
    test('AC F11-2: ack sesudah commit melepas pesan dari antrean dan diteruskan ke garis waktu', () async {
      final container = chatContainer(
        realtime: realtime,
        clientIds: ['c-1'],
        handler: (options) => options.path == _messagesPath ? _ack(options) : FakeResponse.json(404),
      );
      final outbox = container.read(chatOutboxProvider.notifier);
      final acks = <ChatMessage>[];
      outbox.acknowledged.listen(acks.add);

      final entry = outbox.sendText('room-1', 'Assalamualaikum');
      expect(entry.clientMessageId, 'c-1');
      expect(container.read(chatOutboxProvider)['room-1']!.single.status, OutgoingStatus.sending);
      await _flush();

      expect(container.read(chatOutboxProvider)['room-1'], isNull);
      expect(acks.single.clientMessageId, 'c-1');
      final adapter = adapterOf(container);
      expect(_sentBody(adapter.requestsTo(_messagesPath).single), {
        'client_message_id': 'c-1',
        'kind': 'text',
        'body': 'Assalamualaikum',
      });
    });

    test('AC F11-2: respons hilang -> gagal; kirim ulang memakai client_message_id yang SAMA, server 200', () async {
      var attempt = 0;
      final container = chatContainer(
        realtime: realtime,
        clientIds: ['c-7'],
        handler: (options) {
          if (options.path != _messagesPath) return FakeResponse.json(404);
          attempt++;
          // Percobaan pertama: commit di server tetapi koneksi putus sebelum respons tiba.
          if (attempt == 1) return FakeResponse.network();
          return _ack(options, status: 200, id: 'srv-1');
        },
      );
      final outbox = container.read(chatOutboxProvider.notifier);
      final acks = <ChatMessage>[];
      outbox.acknowledged.listen(acks.add);
      outbox.sendText('room-1', 'Halo');
      await _flush();

      final failed = container.read(chatOutboxProvider)['room-1']!.single;
      expect(failed.status, OutgoingStatus.failed);
      expect(failed.autoRetry, isTrue);

      outbox.retry('room-1', 'c-7');
      await _flush();
      final requests = adapterOf(container).requestsTo(_messagesPath);
      expect(requests, hasLength(2));
      expect(requests.map((r) => _sentBody(r)['client_message_id']), ['c-7', 'c-7']);
      expect(acks.single.id, 'srv-1');
      expect(container.read(chatOutboxProvider)['room-1'], isNull);
    });

    test('AC F11-2: pengiriman per room berurutan sesuai urutan tulis', () async {
      final gate = Completer<void>();
      final order = <String>[];
      final container = chatContainer(
        realtime: realtime,
        clientIds: ['c-1', 'c-2'],
        handler: (options) async {
          final id = _sentBody(options)['client_message_id']! as String;
          order.add('mulai $id');
          if (id == 'c-1') await gate.future;
          order.add('selesai $id');
          return _ack(options);
        },
      );
      final outbox = container.read(chatOutboxProvider.notifier);
      outbox
        ..sendText('room-1', 'Pertama')
        ..sendText('room-1', 'Kedua');
      await _flush();
      expect(order, ['mulai c-1'], reason: 'pesan kedua menunggu ack pesan pertama');
      gate.complete();
      await _flush();
      expect(order, ['mulai c-1', 'selesai c-1', 'mulai c-2', 'selesai c-2']);
    });

    test('AC F11-6, PRD 4.5: MEMBERSHIP_REQUIRED menahan pesan; setelah aktif dikirim dengan id yang sama', () async {
      var expired = true;
      final container = chatContainer(
        realtime: realtime,
        clientIds: ['c-9'],
        handler: (options) => expired
            ? FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Masa keanggotaan berakhir.'))
            : _ack(options),
      );
      final outbox = container.read(chatOutboxProvider.notifier);
      outbox.sendText('room-1', 'Tolong dikirim');
      await _flush();
      final held = container.read(chatOutboxProvider)['room-1']!.single;
      expect(held.status, OutgoingStatus.held);
      expect(held.failureMessage, 'Masa keanggotaan berakhir.');

      // resume tanpa includeHeld tidak menyentuh pesan yang ditahan.
      outbox.resume('room-1');
      await _flush();
      expect(adapterOf(container).requestsTo(_messagesPath), hasLength(1));

      expired = false;
      outbox.resume('room-1', includeHeld: true);
      await _flush();
      final requests = adapterOf(container).requestsTo(_messagesPath);
      expect(requests, hasLength(2));
      expect(_sentBody(requests.last)['client_message_id'], 'c-9');
      expect(container.read(chatOutboxProvider)['room-1'], isNull);
    });

    test('pesan baru dengan holdReason langsung ditahan tanpa request', () async {
      final container = chatContainer(realtime: realtime, handler: (_) => FakeResponse.json(500));
      container.read(chatOutboxProvider.notifier).sendText('room-1', 'Nanti', holdReason: 'Perpanjang KTA');
      await _flush();
      expect(container.read(chatOutboxProvider)['room-1']!.single.status, OutgoingStatus.held);
      expect(adapterOf(container).requests, isEmpty);
    });

    test('gambar: diunggah sekali (chat_image); kirim ulang memakai berkas yang sama', () async {
      var sends = 0;
      final container = chatContainer(
        realtime: realtime,
        clientIds: ['c-img'],
        handler: (options) {
          if (options.path == '/files') {
            return FakeResponse.json(201, {
              'id': 'file-1',
              'purpose': 'chat_image',
              'mime': 'image/jpeg',
              'bytes': 3,
              'width': 10,
              'height': 10,
              'visibility': 'private',
              'public_url': null,
              'created_at': iso(testNow),
            });
          }
          sends++;
          return sends == 1 ? FakeResponse.json(500, errorJson('INTERNAL_ERROR', 'Galat server')) : _ack(options);
        },
      );
      final outbox = container.read(chatOutboxProvider.notifier);
      outbox.sendImage(
        'room-1',
        OutgoingImage(bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF]), filename: 'a.jpg', mime: 'image/jpeg'),
        caption: 'Foto acara',
      );
      await _flush();
      expect(container.read(chatOutboxProvider)['room-1']!.single.status, OutgoingStatus.failed);
      outbox.retry('room-1', 'c-img');
      await _flush();
      final adapter = adapterOf(container);
      expect(adapter.requestsTo('/files'), hasLength(1));
      final sent = adapter.requestsTo(_messagesPath).map(_sentBody).toList();
      expect(sent, hasLength(2));
      expect(sent.every((b) => b['image_file_id'] == 'file-1' && b['kind'] == 'image'), isTrue);
      expect(sent.last['body'], 'Foto acara');
    });

    test('pesan yang terlihat lewat event/sinkron dilepas; buang dan bersihkan room', () async {
      final container = chatContainer(realtime: realtime, handler: (_) => FakeResponse.network());
      final outbox = container.read(chatOutboxProvider.notifier);
      outbox
        ..sendText('room-1', 'A')
        ..sendText('room-1', 'B')
        ..sendText('room-2', 'C');
      await _flush();
      final ids = container.read(chatOutboxProvider)['room-1']!.map((e) => e.clientMessageId).toList();
      outbox.resolve('room-1', ids.first);
      expect(container.read(chatOutboxProvider)['room-1'], hasLength(1));
      outbox.discard('room-1', ids.last);
      expect(container.read(chatOutboxProvider)['room-1'], isNull);
      outbox.clearRoom('room-2');
      expect(container.read(chatOutboxProvider), isEmpty);
    });
  });
}
