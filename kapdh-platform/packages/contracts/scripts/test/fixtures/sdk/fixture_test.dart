// Uji perilaku SDK Dart yang dibangkitkan dari fixture generator (scripts/test/fixtures/sdk, BUKAN kontrak produk).
// Dijalankan scripts/check-dart.mjs di paket sementara .dart_tool/kapdh_api_fixture: respons 200 | 204, enum inline
// nullable, list enum nullable, nilai bebas opsional, field tiga keadaan, multipart yang dapat dikirim ulang, dan
// event realtime bertipe dengan $ref antarberkas (PRD 5.2, N-13, ARCHITECTURE §4.9).
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:test/test.dart';

class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  final ResponseBody Function(RequestOptions options) handler;
  final List<RequestOptions> requests = <RequestOptions>[];
  final List<String> bodies = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final bytes = <int>[];
    if (requestStream != null) {
      await for (final chunk in requestStream) {
        bytes.addAll(chunk);
      }
    }
    bodies.add(latin1.decode(bytes));
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonBody(Object? body, int status) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );

(FixtureApi, FakeAdapter) apiWith(ResponseBody Function(RequestOptions options) handler) {
  final adapter = FakeAdapter(handler);
  final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
  return (FixtureApi(dio), adapter);
}

Map<String, Object?> recordJson() => <String, Object?>{
      'id': 'r1',
      'status': null,
      'labels': <Object?>['red', null, 'hijau'],
      'states': <Object?>['draft', null],
      'updated_at': null,
    };

void main() {
  group('respons 200 | 204', () {
    test('PATCH 200 mengembalikan model, 204 mengembalikan null', () async {
      var status = 200;
      final (api, adapter) = apiWith((_) => status == 200 ? jsonBody(recordJson(), 200) : ResponseBody.fromString('', 204));
      final changed = await api.patchFixtureRecord('r1', const FixturePatch(note: Optional('baru')));
      expect(changed?.id, 'r1');
      status = 204;
      expect(await api.patchFixtureRecord('r1', const FixturePatch()), isNull);
      expect(adapter.requests.first.data, <String, Object?>{'note': 'baru'});
    });

    test('teks 200 | 204 menjadi String?', () async {
      var status = 200;
      final (api, _) = apiWith(
        (_) => status == 200
            ? ResponseBody.fromString('catatan', 200, headers: <String, List<String>>{
                Headers.contentTypeHeader: <String>['text/plain'],
              })
            : ResponseBody.fromString('', 204),
      );
      expect(await api.getFixtureRecordNote('r1'), 'catatan');
      status = 204;
      expect(await api.getFixtureRecordNote('r1'), isNull);
    });
  });

  group('enum nullable dan nilai bebas', () {
    test('enum inline nullable, list enum nullable dan nilai baru menjadi unknown', () {
      final record = FixtureRecord.fromJson(recordJson());
      expect(record.status, isNull);
      expect(record.labels, <FixtureRecordLabelsItem?>[
        FixtureRecordLabelsItem.red,
        null,
        FixtureRecordLabelsItem.unknown,
      ]);
      expect(record.states, <FixtureState?>[FixtureState.draft, null]);
      final json = record.toJson();
      expect(json['status'], isNull);
      expect(json.containsKey('status'), isTrue);
      expect(json['labels'], <Object?>['red', null, '']);
      expect(json['states'], <Object?>['draft', null]);
      // Nilai bebas opsional yang kosong tidak dikirim sebagai null.
      expect(json.containsKey('data'), isFalse);
      expect(
        FixtureRecord.fromJson(<String, Object?>{...recordJson(), 'status': 'closed', 'data': <String, Object?>{'a': 1}})
            .toJson()['data'],
        <String, Object?>{'a': 1},
      );
    });

    test('field tiga keadaan termasuk nilai bebas dan enum nullable', () {
      expect(const FixturePatch().toJson(), <String, Object?>{});
      expect(
        const FixturePatch(status: Optional(null), meta: Optional(null), note: Optional(null)).toJson(),
        <String, Object?>{'status': null, 'meta': null, 'note': null},
      );
      expect(
        const FixturePatch(status: Optional(FixturePatchStatus.open), meta: Optional(<String, Object?>{'x': 1}))
            .toJson(),
        <String, Object?>{'status': 'open', 'meta': <String, Object?>{'x': 1}},
      );
      final parsed = FixturePatch.fromJson(<String, Object?>{'status': null});
      expect(parsed.status.isPresent, isTrue);
      expect(parsed.status.valueOrNull, isNull);
      expect(parsed.meta.isPresent, isFalse);
    });
  });

  test('multipart berkas tunggal, daftar dan opsional dapat dikirim ulang (PRD 4.3)', () async {
    final (api, adapter) = apiWith((_) => jsonBody(recordJson(), 201));
    final upload = FixtureUpload(
      file: MultipartFile.fromBytes(utf8.encode('UTAMA'), filename: 'utama.png'),
      attachments: <MultipartFile>[
        MultipartFile.fromBytes(utf8.encode('LAMPIRAN1'), filename: 'a.pdf'),
        MultipartFile.fromBytes(utf8.encode('LAMPIRAN2'), filename: 'b.pdf'),
      ],
      cover: MultipartFile.fromBytes(utf8.encode('SAMPUL'), filename: 'sampul.jpg'),
      caption: 'Bukti',
    );
    await api.uploadFixtureFiles(upload);
    await api.uploadFixtureFiles(upload);
    expect(adapter.bodies, hasLength(2));
    for (final body in adapter.bodies) {
      for (final part in <String>['UTAMA', 'LAMPIRAN1', 'LAMPIRAN2', 'SAMPUL', 'Bukti']) {
        expect(body, contains(part));
      }
    }
    expect(upload.toString(), contains('utama.png'));
  });

  group('event realtime bertipe (ARCHITECTURE §4.9)', () {
    Map<String, Object?> eventJson(String type, Map<String, Object?> payload) => <String, Object?>{
          'v': 1,
          'event_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e5f',
          'type': type,
          'entity_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
          'ts': '2026-10-12T03:15:00.000Z',
          'payload': payload,
        };
    final message = <String, Object?>{
      'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e60',
      'body': 'Isi rahasia',
      'reply_to': <String, Object?>{
        'id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e62',
        'body': 'Pesan awal',
        'created_at': '2026-10-12T03:14:00.000Z',
      },
      'created_at': '2026-10-12T03:15:00.000Z',
    };

    test(r'payload bertipe dengan skema bersama ($ref antarberkas dan rekursif)', () {
      final event = RealtimeEvent.fromJson(
        eventJson('message.created', <String, Object?>{'room_id': '0192f0c2-7c1e-7d5a-9a51-1f1c2b3d4e61', 'message': message}),
      );
      final text = switch (event) {
        MessageCreatedEvent(:final payload) => payload.message.replyTo?.body,
        _ => null,
      };
      expect(text, 'Pesan awal');
      expect(event.toString(), isNot(contains('Isi rahasia')));
    });

    test('jenis tanpa payload, jenis pending dan payload menyimpang', () {
      expect(RealtimeEvent.fromJson(eventJson('session.revoked', <String, Object?>{})), isA<SessionRevokedEvent>());
      final typing = RealtimeEvent.fromJson(eventJson('typing', <String, Object?>{'room_id': 'x'}));
      expect(typing, isA<TypingEvent>());
      expect((typing as TypingEvent).payload['room_id'], 'x');
      expect(
        () => RealtimeEvent.fromJson(eventJson('message.created', <String, Object?>{'room_id': 'x'})),
        throwsFormatException,
      );
    });
  });
}
