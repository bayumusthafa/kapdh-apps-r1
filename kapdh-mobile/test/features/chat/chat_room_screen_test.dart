import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/features/chat/chat_image_picker.dart';
import 'package:kapdh_mobile/features/chat/chat_message_widgets.dart';
import 'package:kapdh_mobile/features/chat/chat_realtime.dart';
import 'package:kapdh_mobile/features/chat/chat_room_screen.dart';
import 'package:kapdh_mobile/features/chat/outgoing_message.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'chat_fixtures.dart';
import 'chat_server.dart';

/// Membuka /chat/room-1 di aplikasi lengkap dengan server chat tiruan.
Future<AppHarness> _openRoom(
  WidgetTester tester, {
  required FakeChatServer server,
  required FakeChatRealtime realtime,
  Map<String, Object?>? me,
  Map<String, FakeHandler> routes = const {},
  ChatImagePicker? picker,
  double textScale = 1,
}) async {
  final base = apiRoutes({'/me': (_) => FakeResponse.json(200, me ?? meJson()), ...routes});
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    handler: server.handler(base),
    overrides: [
      chatRealtimeProvider.overrideWithValue(realtime),
      if (picker != null) chatImagePickerProvider.overrideWithValue(picker),
    ],
  );
  app.router.go('/network');
  await settle(tester);
  app.router.push('/chat/room-1');
  await settle(tester);
  return app;
}

FakeChatServer _directRoom({Map<String, Object?>? room, int messages = 3}) {
  final server = FakeChatServer(room: room);
  for (var i = 0; i < messages; i++) {
    server.commit(body: 'Pesan ${i + 1}');
  }
  return server;
}

List<Map<String, Object?>> _posts(AppHarness app) => app.adapter
    .requestsTo('/chat/rooms/room-1/messages')
    .where((r) => r.method == 'POST')
    .map((r) => Map<String, Object?>.from(r.data as Map))
    .toList();

Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(find.widgetWithText(TextField, 'Tulis pesan…'), text);
  await tester.pump();
}

void main() {
  group('Percakapan (F-11)', () {
    testWidgets('riwayat tampil urut; header lawan bicara dan status daring dari presence', (tester) async {
      final realtime = FakeChatRealtime();
      await _openRoom(tester, server: _directRoom(), realtime: realtime);
      expect(find.byType(ChatRoomScreen), findsOneWidget);
      expect(find.text('Gamerisa Dewi'), findsOneWidget);
      final y1 = tester.getTopLeft(find.text('Pesan 1')).dy;
      final y3 = tester.getTopLeft(find.text('Pesan 3')).dy;
      expect(y1, lessThan(y3));
      expect(find.text('Awal percakapan'), findsOneWidget);

      realtime.emit(presenceEvent('user-2'));
      await settle(tester);
      expect(find.text('Daring'), findsOneWidget);
      realtime.emit(typingEvent('user-2'));
      await tester.pump();
      await tester.pump();
      expect(find.text('sedang mengetik…'), findsOneWidget);
      // TTL habis: indikator hilang (penghitung waktu layar).
      await tester.pump(const Duration(seconds: 6));
      await settle(tester);
    });

    testWidgets('AC F11-3: riwayat lama dimuat dengan keyset before saat digulir ke atas', (tester) async {
      final server = _directRoom(messages: 40);
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      expect(find.text('Pesan 40'), findsOneWidget);
      expect(find.text('Pesan 1'), findsNothing);
      await tester.fling(find.byType(ListView).last, const Offset(0, 3000), 3000);
      await settle(tester);
      await tester.fling(find.byType(ListView).last, const Offset(0, 3000), 3000);
      await settle(tester);
      final before = app.adapter
          .requestsTo('/chat/rooms/room-1/messages')
          .where((r) => r.method == 'GET' && r.queryParameters['before'] != null)
          .toList();
      expect(before.first.queryParameters['before'], server.messages[10]['id']);
      expect(find.text('Awal percakapan'), findsOneWidget);
      expect(find.text('Pesan 1'), findsOneWidget);
    });

    testWidgets('AC F11-2: pesan tampil "Mengirim" sampai ack sesudah commit, lalu "Terkirim" tanpa duplikat', (
      tester,
    ) async {
      final gate = Completer<void>();
      final server = _directRoom();
      final realtime = FakeChatRealtime();
      final app = await _openRoom(tester, server: server, realtime: realtime);
      // Tahan respons POST sampai gate dibuka.
      app.adapter.handler = (options) async {
        if (options.method == 'POST' && options.path == '/chat/rooms/room-1/messages') await gate.future;
        return server.handler(apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}))(options);
      };

      await _type(tester, 'Assalamualaikum, apa kabar?');
      await tester.tap(find.byTooltip('Kirim'));
      await tester.pump();
      expect(find.text('Assalamualaikum, apa kabar?'), findsOneWidget);
      expect(find.text('Mengirim'), findsOneWidget);

      gate.complete();
      await settle(tester);
      expect(find.text('Mengirim'), findsNothing);
      expect(find.text('Terkirim'), findsOneWidget);
      expect(find.text('Assalamualaikum, apa kabar?'), findsOneWidget);
      final sent = _posts(app).single;
      expect(sent['kind'], 'text');
      expect(sent['client_message_id'], isNotEmpty);

      // Event message.created untuk pesan yang sama tidak menduplikasi.
      realtime.emit(messageCreated(server.messages.last));
      await settle(tester);
      expect(find.text('Assalamualaikum, apa kabar?'), findsOneWidget);
    });

    testWidgets('AC F11-2: gagal kirim -> "Gagal terkirim"; kirim ulang memakai client_message_id yang sama', (
      tester,
    ) async {
      final server = _directRoom();
      server.failures['POST /chat/rooms/room-1/messages'] = FakeResponse.network;
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      await _type(tester, 'Coba kirim');
      await tester.tap(find.byTooltip('Kirim'));
      await settle(tester);
      expect(find.text('Gagal terkirim'), findsOneWidget);
      expect(find.textContaining('Ketuk untuk kirim ulang'), findsOneWidget);

      server.failures.clear();
      await tester.tap(find.text('Coba kirim'));
      await settle(tester);
      await tester.tap(find.text('Kirim ulang'));
      await settle(tester);
      final posts = _posts(app);
      expect(posts, hasLength(2));
      expect(posts[0]['client_message_id'], posts[1]['client_message_id']);
      expect(find.text('Gagal terkirim'), findsNothing);
      expect(find.text('Terkirim'), findsOneWidget);
    });

    testWidgets('status terbaca room direct dari read cursor lawan bicara (read.updated)', (tester) async {
      final server = _directRoom(messages: 0);
      server
        ..commit(body: 'Dari dia')
        ..commit(senderId: 'user-1', body: 'Dari saya');
      final realtime = FakeChatRealtime();
      await _openRoom(tester, server: server, realtime: realtime);
      expect(find.text('Terkirim'), findsOneWidget);
      realtime.emit(readUpdated('user-2', server.messages.last['id']! as String));
      await settle(tester);
      expect(find.text('Dibaca'), findsOneWidget);
    });

    testWidgets('membuka room di bawah menandai pesan terbaru terbaca (read cursor monoton)', (tester) async {
      final server = _directRoom();
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      final reads = app.adapter.requestsTo('/chat/rooms/room-1/read');
      expect(reads, hasLength(1));
      expect((reads.single.data as Map)['message_id'], server.messages.last['id']);
    });

    testWidgets('balas dan reaksi lewat lembar tindakan pesan', (tester) async {
      final server = _directRoom();
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      await tester.longPress(find.text('Pesan 2'));
      await settle(tester);
      await tester.tap(find.byTooltip('Reaksi 👍'));
      await settle(tester);
      expect(app.adapter.requests.where((r) => r.method == 'PUT' && r.path.contains('/reactions/')), hasLength(1));
      expect(find.bySemanticsLabel(RegExp('👍 1, termasuk Anda')), findsOneWidget);

      await tester.longPress(find.text('Pesan 2'));
      await settle(tester);
      await tester.tap(find.text('Balas'));
      await settle(tester);
      expect(find.byTooltip('Batalkan balasan'), findsOneWidget);
      await _type(tester, 'Setuju');
      await tester.tap(find.byTooltip('Kirim'));
      await settle(tester);
      expect(_posts(app).single['reply_to_id'], server.messages[1]['id']);
    });

    testWidgets('D5 v3.2: penghitung mendekati 4.000 karakter dan tombol kirim nonaktif bila lewat batas', (
      tester,
    ) async {
      await _openRoom(tester, server: _directRoom(), realtime: FakeChatRealtime());
      await _type(tester, 'a' * 3900);
      expect(find.text('3900/4000'), findsOneWidget);
      await _type(tester, 'a' * (maxChatTextChars + 1));
      expect(find.text('Pesan maksimal 4000 karakter.'), findsOneWidget);
      final send = tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.send));
      expect(send.onPressed, isNull);
    });

    testWidgets('AC F12-1: saya memblokir lawan bicara -> kirim nonaktif dengan tawaran buka blokir', (tester) async {
      final server = _directRoom(room: roomJson(canSend: false, sendRestriction: 'blocked'));
      await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      expect(find.text('Anda memblokir Gamerisa Dewi. Buka blokir untuk kembali mengirim pesan.'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Buka blokir'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Tulis pesan…'), findsNothing);
      expect(find.text('Pesan 1'), findsOneWidget, reason: 'riwayat lama tetap dapat dibaca (PRD 3.12)');
    });

    testWidgets('N-09: lawan bicara tidak tersedia/memblokir saya -> alasan tidak dibedakan', (tester) async {
      final server = _directRoom(
        room: roomJson(canSend: false, sendRestriction: 'peer_unavailable', peerAvailable: false),
      );
      await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      expect(find.textContaining('Anggota ini tidak dapat menerima pesan saat ini.'), findsOneWidget);
      expect(find.text('Tidak tersedia'), findsOneWidget);
      expect(find.textContaining('blokir'), findsNothing);
    });

    testWidgets('AC F11-6, PRD 4.5: masa keanggotaan berakhir saat chat -> ajakan perpanjang, kirim ditahan', (
      tester,
    ) async {
      final app = await _openRoom(
        tester,
        server: _directRoom(),
        realtime: FakeChatRealtime(),
        me: meJson(status: 'expiring', expiresAt: testNow.subtract(const Duration(minutes: 5))),
      );
      expect(find.textContaining('Masa keanggotaan Anda tidak aktif'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Tulis pesan…'), findsNothing);
      await tester.tap(find.widgetWithText(TextButton, 'Perpanjang KTA'));
      await settle(tester);
      expect(app.location, '/renewal');
    });

    testWidgets('PRD 4.5: server menolak kirim (MEMBERSHIP_REQUIRED) -> pesan ditahan dan ajakan perpanjang', (
      tester,
    ) async {
      final server = _directRoom();
      server.failures['POST /chat/rooms/room-1/messages'] = () =>
          FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Masa keanggotaan Anda telah berakhir.'));
      await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      await _type(tester, 'Pesan terakhir');
      await tester.tap(find.byTooltip('Kirim'));
      await settle(tester);
      expect(find.text('Ditahan'), findsOneWidget);
      expect(find.textContaining('Masa keanggotaan Anda tidak aktif'), findsOneWidget);
    });

    testWidgets('AC F11-3: koneksi putus menampilkan pita; reconnect menyinkron after=<jangkar>', (tester) async {
      final server = _directRoom();
      final realtime = FakeChatRealtime();
      final app = await _openRoom(tester, server: server, realtime: realtime);
      realtime.state.value = RealtimeConnectionState.waitingRetry;
      await tester.pump();
      expect(find.textContaining('Menyambungkan ulang'), findsOneWidget);
      server.commit(body: 'Terlewat saat putus');
      realtime.state.value = RealtimeConnectionState.connected;
      await settle(tester);
      expect(find.textContaining('Menyambungkan ulang'), findsNothing);
      expect(find.text('Terlewat saat putus'), findsOneWidget);
      final afterQueries = app.adapter
          .requestsTo('/chat/rooms/room-1/messages')
          .where((r) => r.method == 'GET' && r.queryParameters['after'] != null);
      expect(afterQueries.first.queryParameters['after'], server.messages[2]['id']);
    });

    testWidgets('AC F11-4: bukan anggota (404) -> percakapan tidak tersedia', (tester) async {
      final server = _directRoom();
      server.failures['GET /chat/rooms/room-1'] = () => FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ada'));
      await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      expect(find.text('Percakapan tidak tersedia'), findsOneWidget);
      expect(find.text('Pesan 1'), findsNothing);
    });

    testWidgets('AC F11-4: dikeluarkan saat room terbuka -> riwayat ditutup', (tester) async {
      final server = _directRoom(
        room: roomJson(kind: 'group', title: 'Angkatan 29', memberCount: 3),
      );
      final realtime = FakeChatRealtime();
      await _openRoom(tester, server: server, realtime: realtime);
      expect(find.text('3 anggota'), findsOneWidget);
      realtime.emit(memberChanged('user-1', 'removed', actor: 'user-9', memberCount: 2));
      await settle(tester);
      expect(find.text('Percakapan tidak tersedia'), findsOneWidget);
    });

    testWidgets('grup: nama pengirim dan "Dibaca N" dari read cursor anggota', (tester) async {
      final server = FakeChatServer(
        room: roomJson(kind: 'group', title: 'Angkatan 29', memberCount: 3),
      );
      server.commit(body: 'Halo semua');
      final mine = server.commit(senderId: 'user-1', body: 'Waalaikumsalam');
      server.members = [
        memberJson(
          userId: 'user-1',
          name: 'Ahmad Islam',
          role: 'admin',
          isMe: true,
          lastReadMessageId: mine['id'] as String,
        ),
        memberJson(userId: 'user-2', name: 'Gamerisa Dewi', lastReadMessageId: mine['id'] as String),
        memberJson(userId: 'user-3', name: 'Budi Santoso'),
      ];
      final realtime = FakeChatRealtime();
      await _openRoom(tester, server: server, realtime: realtime);
      expect(find.text('Gamerisa Dewi'), findsOneWidget, reason: 'nama pengirim di grup');
      expect(find.text('Dibaca 1'), findsOneWidget);
      realtime.emit(typingEvent('user-3'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Budi Santoso sedang mengetik…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 6));
      await settle(tester);
    });

    testWidgets('AC F12-2: laporkan pesan dengan pesan konteks dari room yang sama', (tester) async {
      final server = _directRoom();
      final app = await _openRoom(
        tester,
        server: server,
        realtime: FakeChatRealtime(),
        routes: {
          '/reports': (_) => FakeResponse.json(201, {
            'id': 'rep-1',
            'category': 'spam',
            'target_type': 'message',
            'target_name': 'Gamerisa Dewi',
            'room_name': null,
            'description': null,
            'status': 'open',
            'priority': 'normal',
            'outcome': null,
            'decision_message': null,
            'created_at': iso(testNow),
            'due_at': iso(testNow.add(const Duration(days: 2))),
            'resolved_at': null,
          }),
        },
      );
      await tester.longPress(find.text('Pesan 3'));
      await settle(tester);
      await tester.tap(find.text('Laporkan pesan'));
      await settle(tester);
      expect(find.text('Gamerisa Dewi: Pesan 3'), findsOneWidget);
      await scrollAndTap(tester, find.text('Spam'));
      await scrollAndTap(tester, find.text('Kirim laporan'));
      await settle(tester);
      final body = app.adapter.requestsTo('/reports').single.data as Map;
      expect(body['target_type'], 'message');
      expect(body['message_id'], server.messages[2]['id']);
      expect(body['context_message_ids'], [server.messages[0]['id'], server.messages[1]['id']]);
      expect(body['category'], 'spam');
    });

    testWidgets('kirim foto: diunggah sebagai chat_image lalu pesan image dikirim', (tester) async {
      final server = _directRoom();
      final app = await _openRoom(
        tester,
        server: server,
        realtime: FakeChatRealtime(),
        picker: (_) async => OutgoingImage(
          bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0]),
          filename: 'acara.jpg',
          mime: 'image/jpeg',
        ),
        routes: {
          '/files': (_) => FakeResponse.json(201, {
            'id': 'file-7',
            'purpose': 'chat_image',
            'mime': 'image/jpeg',
            'bytes': 4,
            'width': 800,
            'height': 600,
            'visibility': 'private',
            'public_url': null,
            'created_at': iso(testNow),
          }),
        },
      );
      await tester.tap(find.byTooltip('Kirim foto'));
      await settle(tester);
      await tester.tap(find.text('Galeri'));
      await settle(tester);
      expect(app.adapter.requestsTo('/files'), hasLength(1));
      final post = _posts(app).single;
      expect(post['kind'], 'image');
      expect(post['image_file_id'], 'file-7');
    });

    testWidgets('foto bukan JPG/PNG ditolak sebelum diunggah (N-10)', (tester) async {
      final app = await _openRoom(
        tester,
        server: _directRoom(),
        realtime: FakeChatRealtime(),
        picker: (_) async => throw const ChatImageException('Gunakan foto JPG atau PNG.'),
      );
      await tester.tap(find.byTooltip('Kirim foto'));
      await settle(tester);
      await tester.tap(find.text('Kamera'));
      await settle(tester);
      expect(find.text('Gunakan foto JPG atau PNG.'), findsOneWidget);
      expect(app.adapter.requestsTo('/files'), isEmpty);
      expect(sniffChatImageMime([0x89, 0x50, 0x4E, 0x47, 0x0D]), 'image/png');
      expect(sniffChatImageMime([0x47, 0x49, 0x46]), isNull);
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await _openRoom(tester, server: _directRoom(), realtime: FakeChatRealtime(), textScale: 2);
      expect(tester.takeException(), isNull);
    });

    testWidgets('AC F12-1, N-09: kirim ditolak 403 tanpa event (lawan bicara memblokir) -> izin room dimuat ulang', (
      tester,
    ) async {
      final server = _directRoom();
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      int roomGets() => app.adapter.requestsTo('/chat/rooms/room-1').where((r) => r.method == 'GET').length;
      final before = roomGets();
      // Pihak yang diblokir tidak menerima room.updated (moderation.yaml); hanya penolakan kirim yang memberi tahu.
      server.room = roomJson(canSend: false, sendRestriction: 'peer_unavailable');
      server.failures['POST /chat/rooms/room-1/messages'] = () =>
          FakeResponse.json(403, errorJson('FORBIDDEN', 'Anda tidak memiliki izin untuk tindakan ini.'));
      await _type(tester, 'Halo?');
      await tester.tap(find.byTooltip('Kirim'));
      await settle(tester);

      expect(roomGets(), before + 1, reason: 'detail room dimuat ulang sekali');
      expect(find.textContaining('Anggota ini tidak dapat menerima pesan saat ini.'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Tulis pesan…'), findsNothing);
      expect(find.textContaining('blokir'), findsNothing, reason: 'alasan tidak dibedakan (N-09)');
      expect(find.text('Gagal terkirim'), findsOneWidget);
      expect(find.textContaining('Ketuk untuk membuang.'), findsOneWidget);
      // Kirim ulang tidak ditawarkan karena pasti ditolak lagi; pesan hanya dapat dibuang.
      await tester.tap(find.text('Halo?'));
      await settle(tester);
      expect(find.text('Kirim ulang'), findsNothing);
      await tester.tap(find.text('Buang pesan'));
      await settle(tester);
      expect(find.text('Halo?'), findsNothing);
      expect(_posts(app), hasLength(1), reason: 'tidak ada kirim ulang otomatis untuk penolakan pasti');
    });

    testWidgets('AC F11-4: kirim ditolak 404 (bukan lagi anggota) -> percakapan tidak tersedia, antrean dibuang', (
      tester,
    ) async {
      final server = _directRoom(
        room: roomJson(kind: 'group', title: 'Angkatan 29', memberCount: 3),
      );
      await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      server.failures['POST /chat/rooms/room-1/messages'] = () =>
          FakeResponse.json(404, errorJson('NOT_FOUND', 'Data tidak ditemukan.'));
      server.failures['GET /chat/rooms/room-1'] = () => FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ada.'));
      await _type(tester, 'Masih di sini?');
      await tester.tap(find.byTooltip('Kirim'));
      await settle(tester);
      expect(find.text('Percakapan tidak tersedia'), findsOneWidget);
      expect(find.text('Pesan 1'), findsNothing);
      expect(find.text('Masih di sini?'), findsNothing);
    });

    testWidgets('N-11: foto pesan dapat dibuka dan dimuat ulang lewat pembaca layar', (tester) async {
      final semantics = tester.ensureSemantics();
      final server = _directRoom(messages: 1);
      server.messages.add(
        chatMessageJson(
          id: 'm-img',
          body: null,
          kind: 'image',
          image: {
            'file_id': 'file-1',
            // URL bertanda tangan yang sudah kedaluwarsa: gagal dimuat (HTTP uji selalu gagal).
            'url': 'https://files.test/chat/file-1?sig=lama',
            'url_expires_at': iso(testNow.subtract(const Duration(minutes: 1))),
            'mime': 'image/jpeg',
            'width': 800,
            'height': 600,
          },
          createdAt: at(300),
        ),
      );
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      expect(find.text('Muat ulang foto'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Gamerisa Dewi, .*, Foto$')), findsOneWidget);
      expect(
        tester.getSemantics(find.byType(ChatImageView)),
        containsSemantics(label: 'Foto', isImage: true, isButton: true, hasTapAction: true),
      );
      expect(
        tester.getSemantics(find.widgetWithText(TextButton, 'Muat ulang foto')),
        containsSemantics(label: 'Muat ulang foto', isButton: true, hasTapAction: true),
      );

      final syncsBefore = app.adapter
          .requestsTo('/chat/rooms/room-1/messages')
          .where((r) => r.method == 'GET' && r.queryParameters['after'] != null)
          .length;
      await tester.tap(find.widgetWithText(TextButton, 'Muat ulang foto'));
      await settle(tester);
      final syncsAfter = app.adapter
          .requestsTo('/chat/rooms/room-1/messages')
          .where((r) => r.method == 'GET' && r.queryParameters['after'] != null)
          .length;
      expect(syncsAfter, greaterThan(syncsBefore), reason: 'muat ulang foto menyinkron jendela pesan (URL baru)');
      semantics.dispose();
    });

    testWidgets('N-11: lembar tindakan pesan orang lain pada teks 200 % dapat digulir sampai Laporkan pesan', (
      tester,
    ) async {
      final server = _directRoom(messages: 1);
      server.commit(body: 'Dari dia');
      await _openRoom(tester, server: server, realtime: FakeChatRealtime(), textScale: 2);
      await tester.longPress(find.text('Dari dia'));
      await settle(tester);
      expect(tester.takeException(), isNull);
      await scrollAndTap(tester, find.text('Laporkan pesan'));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(find.text('Gamerisa Dewi: Dari dia'), findsOneWidget, reason: 'lembar laporan terbuka');
    });

    testWidgets('N-11: lembar tindakan pesan sendiri pada teks 200 % dapat digulir sampai Hapus pesan', (tester) async {
      final server = _directRoom(messages: 1);
      server.commit(senderId: 'user-1', body: 'Punya saya');
      await _openRoom(tester, server: server, realtime: FakeChatRealtime(), textScale: 2);
      await tester.longPress(find.text('Punya saya'));
      await settle(tester);
      expect(tester.takeException(), isNull);
      await scrollAndTap(tester, find.text('Hapus pesan'));
      await settle(tester);
      expect(find.text('Hapus pesan?'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('N-11, AC F11-2: status kirim milik sendiri pada teks 200 % tidak meluap', (tester) async {
      final server = _directRoom(messages: 0);
      server
        ..commit(body: 'Assalamualaikum')
        ..commit(senderId: 'user-1', body: 'Ok');
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime(), textScale: 2);
      expect(find.text('Terkirim'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Balas lalu gagal kirim: "Gagal terkirim" + kutipan balasan di gelembung keluar.
      await tester.longPress(find.text('Assalamualaikum'));
      await settle(tester);
      await scrollAndTap(tester, find.text('Balas'));
      await settle(tester);
      server.failures['POST /chat/rooms/room-1/messages'] = FakeResponse.network;
      await _type(tester, 'Waalaikumsalam');
      await tester.tap(find.byTooltip('Kirim'));
      await settle(tester);
      expect(find.text('Gagal terkirim'), findsOneWidget);
      expect(_posts(app), hasLength(1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('N-11: "Dibaca N" di grup pada teks 200 % tidak meluap', (tester) async {
      final server = FakeChatServer(
        room: roomJson(kind: 'group', title: 'Angkatan 29', memberCount: 13),
      );
      final mine = server.commit(senderId: 'user-1', body: 'Rapat jam 8');
      server.members = [
        memberJson(userId: 'user-1', name: 'Ahmad Islam', isMe: true, lastReadMessageId: mine['id'] as String),
        for (var i = 0; i < 12; i++)
          memberJson(userId: 'r-$i', name: 'Anggota $i', lastReadMessageId: mine['id'] as String),
      ];
      await _openRoom(tester, server: server, realtime: FakeChatRealtime(), textScale: 2);
      expect(find.text('Dibaca 12'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('PRD 4.5: riwayat lama gagal dimuat -> gulir tidak mengulang request, hanya "Coba lagi"', (
      tester,
    ) async {
      final server = _directRoom(messages: 40);
      final app = await _openRoom(tester, server: server, realtime: FakeChatRealtime());
      final base = server.handler(apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}));
      var failOlder = true;
      app.adapter.handler = (options) {
        if (failOlder &&
            options.method == 'GET' &&
            options.path == '/chat/rooms/room-1/messages' &&
            options.queryParameters['before'] != null) {
          return FakeResponse.network();
        }
        return base(options);
      };
      int olderRequests() => app.adapter
          .requestsTo('/chat/rooms/room-1/messages')
          .where((r) => r.method == 'GET' && r.queryParameters['before'] != null)
          .length;

      for (var i = 0; i < 3; i++) {
        await tester.fling(find.byType(ListView).last, const Offset(0, 3000), 3000);
        await settle(tester);
      }
      expect(olderRequests(), 1);
      expect(find.textContaining('Pesan lama belum dapat dimuat.'), findsOneWidget);

      failOlder = false;
      await tester.tap(find.widgetWithText(TextButton, 'Coba lagi'));
      await settle(tester);
      expect(olderRequests(), 2);
      expect(find.textContaining('Pesan lama belum dapat dimuat.'), findsNothing);
    });
  });
}
