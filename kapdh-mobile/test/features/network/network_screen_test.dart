import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/chat/chat_realtime.dart';
import 'package:kapdh_mobile/features/network/network_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../chat/chat_fixtures.dart';
import 'network_fixtures.dart';

final _members = [
  directoryMemberJson(
    userId: 'u-1',
    name: 'Gamerisa Dewi',
    profession: masterRefJson('p-2', 'Senior Developer'),
    skills: [masterRefJson('s-1', 'Publik Speaking'), masterRefJson('s-2', 'English Reading')],
  ),
  directoryMemberJson(userId: 'u-2', name: 'Ahmad Islam', cohort: 1),
];

Future<AppHarness> _openNetwork(
  WidgetTester tester, {
  required Map<String, FakeHandler> routes,
  FakeChatRealtime? realtime,
  double textScale = 1,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    handler: apiRoutes({...networkBaseRoutes(), ...routes}),
    overrides: [chatRealtimeProvider.overrideWithValue(realtime ?? FakeChatRealtime())],
  );
  app.router.go('/network');
  await settle(tester);
  return app;
}

Map<String, dynamic> _query(RequestOptions options) => options.queryParameters;

void main() {
  group('Jejaring: direktori (F-10)', () {
    testWidgets('AC F10-1: hasil dan total mengikuti filter; kartu guideline hal. 7 tanpa kontak', (tester) async {
      final app = await _openNetwork(
        tester,
        routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(_members, total: 2))},
      );
      expect(find.byType(NetworkScreen), findsOneWidget);
      expect(find.text('Cari relasi dengan alumni ...'), findsOneWidget);
      expect(find.text('Jejaring'), findsWidgets);
      expect(find.text('Pesan'), findsOneWidget);
      expect(find.text('Pesan Grup'), findsOneWidget);
      expect(find.text('2 alumni ditemukan'), findsOneWidget);
      expect(find.text('Gamerisa Dewi'), findsOneWidget);
      expect(find.text('Senior Developer • Pekanbaru'), findsOneWidget);
      expect(find.text('Publik Speaking'), findsOneWidget);
      expect(find.text('#KAPDH29'), findsOneWidget);
      expect(find.textContaining('@'), findsNothing, reason: 'kontak tidak pernah ada di kartu (AC F10-2)');

      await tester.tap(find.text('Gamerisa Dewi'));
      await settle(tester);
      expect(app.location, '/network/members/u-1');
    });

    testWidgets('AC F10-1: pencarian nama dan filter dikirim ke server; filter baru mulai dari halaman pertama', (
      tester,
    ) async {
      final app = await _openNetwork(
        tester,
        routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(_members, total: 2))},
      );
      await tester.enterText(find.byType(TextField).first, 'A');
      await tester.pump(directorySearchDebounce);
      await settle(tester);
      expect(find.text('Ketik minimal 2 huruf untuk mencari nama.'), findsOneWidget);
      expect(_query(app.adapter.requestsTo('/directory').last).containsKey('q'), isFalse);

      await tester.enterText(find.byType(TextField).first, 'Ahmad');
      await tester.pump(directorySearchDebounce);
      await settle(tester);
      expect(_query(app.adapter.requestsTo('/directory').last)['q'], 'Ahmad');

      await tester.tap(find.byTooltip('Filter alumni'));
      await settle(tester);
      expect(find.text('Filter Alumni'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextFormField, 'Contoh: 29'), '29');
      await tester.enterText(find.widgetWithText(TextFormField, 'Contoh: Pekanbaru'), 'Pekanbaru');
      await tester.tap(find.text('Semua').at(0));
      await settle(tester);
      await tester.tap(find.text('Kelas 4 (1 Aliyah)').last);
      await settle(tester);
      await scrollAndTap(tester, find.text('Semua').at(0));
      await settle(tester);
      await tester.tap(find.text('Guru').last);
      await settle(tester);
      await scrollAndTap(tester, find.text('Angkatan terbaru'));
      await scrollAndTap(tester, find.text('Terapkan'));
      await settle(tester);

      final query = _query(app.adapter.requestsTo('/directory').last);
      expect(query['q'], 'Ahmad');
      expect(query['cohort'], 29);
      expect(query['class_level'], 4);
      expect(query['city'], 'Pekanbaru');
      expect(query['profession_id'], 'p-1');
      expect(query['sort'], 'cohort_desc');
      expect(query.containsKey('cursor'), isFalse);
      // Chip filter aktif dan lencana jumlah filter.
      expect(find.text('Angkatan 29'), findsOneWidget);
      expect(find.text('Guru'), findsWidgets);
      expect(find.byTooltip('Filter alumni, 4 aktif'), findsOneWidget);

      await tester.tap(find.byTooltip('Hapus filter Angkatan 29'));
      await settle(tester);
      expect(_query(app.adapter.requestsTo('/directory').last).containsKey('cohort'), isFalse);
    });

    testWidgets('AC F10-1: halaman berikut memakai next_cursor dan item ganda tidak ditampilkan dua kali', (
      tester,
    ) async {
      final page1 = [for (var i = 1; i <= 8; i++) directoryMemberJson(userId: 'u-$i', name: 'Alumni $i')];
      final page2 = [
        directoryMemberJson(userId: 'u-8', name: 'Alumni 8'),
        directoryMemberJson(userId: 'u-9', name: 'Alumni 9'),
      ];
      final app = await _openNetwork(
        tester,
        routes: {
          '/directory': (options) => options.queryParameters['cursor'] == 'cur-2'
              ? FakeResponse.json(200, directoryPageJson(page2, total: 9))
              : FakeResponse.json(200, directoryPageJson(page1, total: 9, nextCursor: 'cur-2')),
        },
      );
      expect(find.text('9 alumni ditemukan'), findsOneWidget);
      await tester.drag(find.byType(ListView).first, const Offset(0, -2000));
      await settle(tester);
      await scrollTo(tester, find.text('Alumni 9'));
      expect(app.adapter.requestsTo('/directory').where((r) => _query(r)['cursor'] == 'cur-2'), hasLength(1));
      expect(find.text('Alumni 8'), findsOneWidget);
      expect(find.text('Alumni 9'), findsOneWidget);
    });

    testWidgets('kosong: pesan dan atur ulang filter', (tester) async {
      final app = await _openNetwork(
        tester,
        routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(const []))},
      );
      expect(find.text('Alumni tidak ditemukan'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, 'Zainab');
      await tester.pump(directorySearchDebounce);
      await settle(tester);
      expect(find.text('Atur ulang filter'), findsOneWidget);
      await tester.tap(find.text('Atur ulang filter'));
      await settle(tester);
      expect(_query(app.adapter.requestsTo('/directory').last).containsKey('q'), isFalse);
      // Kotak pencarian ikut kosong sehingga tidak menampilkan kata kunci yang sudah tidak berlaku.
      expect(tester.widget<TextField>(find.byType(TextField).first).controller!.text, isEmpty);
      expect(find.byTooltip('Hapus pencarian'), findsNothing);
    });

    testWidgets('F-10: kata kunci 1 huruf tidak dikosongkan saat filter lain berubah', (tester) async {
      await _openNetwork(tester, routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(const []))});
      await tester.enterText(find.byType(TextField).first, 'Za');
      await tester.pump(directorySearchDebounce);
      await settle(tester);
      // Menghapus satu huruf: kata kunci tidak berlaku lagi (< 2 huruf) tetapi teks pengguna tetap.
      await tester.enterText(find.byType(TextField).first, 'Z');
      await tester.pump(directorySearchDebounce);
      await settle(tester);
      expect(tester.widget<TextField>(find.byType(TextField).first).controller!.text, 'Z');
      expect(find.text('Ketik minimal 2 huruf untuk mencari nama.'), findsOneWidget);
    });

    testWidgets('AC F10-3: server menolak (403 MEMBERSHIP_REQUIRED) -> akses belum tersedia tanpa data', (
      tester,
    ) async {
      await _openNetwork(
        tester,
        routes: {
          '/directory': (_) =>
              FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Fitur ini hanya untuk anggota aktif.')),
        },
      );
      expect(find.text('Akses belum tersedia'), findsOneWidget);
      expect(find.text('Fitur ini hanya untuk anggota aktif.'), findsOneWidget);
    });

    testWidgets('galat jaringan: coba lagi memuat ulang', (tester) async {
      var fail = true;
      final app = await _openNetwork(
        tester,
        routes: {
          '/directory': (_) => fail ? FakeResponse.network() : FakeResponse.json(200, directoryPageJson(_members)),
        },
      );
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(find.text('Gamerisa Dewi'), findsOneWidget);
      expect(app.adapter.requestsTo('/directory'), hasLength(2));
    });

    testWidgets('presence.ping dikirim selama Jejaring terbuka dan tersambung', (tester) async {
      final realtime = FakeChatRealtime();
      await _openNetwork(
        tester,
        realtime: realtime,
        routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(_members))},
      );
      expect(realtime.pings, greaterThanOrEqualTo(1));
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await _openNetwork(
        tester,
        textScale: 2,
        routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(_members))},
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('Jejaring: tab Pesan dan Pesan Grup (F-11)', () {
    testWidgets('daftar room: unread, bisu, pratinjau; event message.created menaikkan room dan unread', (
      tester,
    ) async {
      final realtime = FakeChatRealtime();
      final app = await _openNetwork(
        tester,
        realtime: realtime,
        routes: {
          '/directory': (_) => FakeResponse.json(200, directoryPageJson(_members)),
          '/chat/rooms': (options) => FakeResponse.json(
            200,
            options.queryParameters['kind'] == 'group'
                ? roomPageJson([
                    roomSummaryJson(
                      id: 'g-1',
                      kind: 'group',
                      title: 'Angkatan 29',
                      memberCount: 12,
                      muted: true,
                      lastMessage: previewJson(id: 'gm-1', preview: 'Rapat malam ini'),
                      lastMessageAt: testNow,
                    ),
                  ], pendingInvitations: 2)
                : roomPageJson([
                    roomSummaryJson(
                      id: 'room-1',
                      title: 'Gamerisa Dewi',
                      unreadCount: 2,
                      lastMessage: previewJson(id: 'm-1', preview: 'Assalamualaikum'),
                      lastMessageAt: testNow,
                    ),
                    roomSummaryJson(
                      id: 'room-2',
                      title: 'Budi Santoso',
                      peer: peerJson(userId: 'user-3', name: 'Budi Santoso'),
                      lastMessage: previewJson(id: 'm-2', senderId: 'user-1', preview: 'Siap'),
                      lastMessageAt: testNow.subtract(const Duration(hours: 2)),
                    ),
                  ]),
          ),
        },
      );
      await tester.tap(find.text('Pesan'));
      await settle(tester);
      expect(find.bySemanticsLabel(RegExp('Gamerisa Dewi, 2 pesan belum dibaca')), findsOneWidget);
      expect(find.text('Anda: Siap'), findsOneWidget);

      // Pesan baru di room-2 dari lawan bicara: naik ke atas dan unread 1.
      realtime.emit(
        messageCreated(
          chatMessageJson(
            id: 'm-3',
            roomId: 'room-2',
            senderId: 'user-3',
            senderName: 'Budi',
            body: 'Halo',
            createdAt: at(30),
          ),
        ),
      );
      await settle(tester);
      expect(find.bySemanticsLabel(RegExp('Budi Santoso, 1 pesan belum dibaca')), findsOneWidget);
      final budiTop = tester.getTopLeft(find.text('Budi Santoso')).dy;
      final gamerisaTop = tester.getTopLeft(find.text('Gamerisa Dewi')).dy;
      expect(budiTop, lessThan(gamerisaTop));

      // Read cursor sendiri maju di perangkat lain: unread hilang.
      realtime.emit(readUpdated('user-1', 'm-3', roomId: 'room-2'));
      await settle(tester);
      expect(find.bySemanticsLabel(RegExp('Budi Santoso, 1 pesan belum dibaca')), findsNothing);

      await tester.tap(find.text('Pesan Grup'));
      await settle(tester);
      expect(find.text('Undangan (2)'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Angkatan 29, dibisukan')), findsOneWidget);
      expect(find.text('Gamerisa Dewi: Rapat malam ini'), findsOneWidget);

      await tester.tap(find.text('Angkatan 29'));
      await settle(tester);
      expect(app.location, '/chat/g-1');
    });

    testWidgets('N-02, N-04: pesan grup tidak memuat ulang tab Pesan; rentetan pesan room baru digabung', (
      tester,
    ) async {
      final realtime = FakeChatRealtime();
      final app = await _openNetwork(
        tester,
        realtime: realtime,
        routes: {
          '/directory': (_) => FakeResponse.json(200, directoryPageJson(_members)),
          '/chat/rooms': (options) => FakeResponse.json(
            200,
            options.queryParameters['kind'] == 'group'
                ? roomPageJson([
                    roomSummaryJson(
                      id: 'g-1',
                      kind: 'group',
                      title: 'Angkatan 29',
                      memberCount: 12,
                      lastMessage: previewJson(id: 'gm-1', preview: 'Rapat malam ini'),
                      lastMessageAt: testNow,
                    ),
                  ])
                : roomPageJson([
                    roomSummaryJson(
                      id: 'room-1',
                      lastMessage: previewJson(id: 'm-1', preview: 'Assalamualaikum'),
                      lastMessageAt: testNow,
                    ),
                  ]),
          ),
        },
      );
      int fetches(String kind) =>
          app.adapter.requestsTo('/chat/rooms').where((r) => r.queryParameters['kind'] == kind).length;
      final directBefore = fetches('direct');
      final groupBefore = fetches('group');
      expect(directBefore, greaterThanOrEqualTo(1));
      expect(groupBefore, greaterThanOrEqualTo(1));

      // Lima pesan di grup yang sudah ada di tab Pesan Grup: diperbarui di tempat, tab Pesan tidak dimuat ulang.
      for (var i = 0; i < 5; i++) {
        realtime.emit(
          messageCreated(
            chatMessageJson(
              id: 'gm-${10 + i}',
              roomId: 'g-1',
              senderId: 'user-3',
              senderName: 'Budi Santoso',
              body: 'Pesan grup $i',
              createdAt: at(40 + i),
            ),
          ),
        );
      }
      await settle(tester);
      expect(fetches('direct'), directBefore, reason: 'pesan grup tidak memuat ulang daftar direct');
      expect(fetches('group'), groupBefore, reason: 'room grup yang sudah dimuat diperbarui tanpa request');
      await tester.tap(find.text('Pesan Grup'));
      await settle(tester);
      expect(find.text('Budi Santoso: Pesan grup 4'), findsOneWidget);

      // Room baru yang belum dikenal kedua daftar: rentetan 5 pesan digabung (paling banyak 2 request per daftar).
      for (var i = 0; i < 5; i++) {
        realtime.emit(
          messageCreated(
            chatMessageJson(
              id: 'nm-$i',
              roomId: 'room-9',
              senderId: 'user-9',
              senderName: 'Rahmat Hidayat',
              body: 'Halo $i',
              createdAt: at(60 + i),
            ),
          ),
        );
      }
      await settle(tester);
      expect(fetches('direct') - directBefore, inInclusiveRange(1, 2));
      expect(fetches('group') - groupBefore, inInclusiveRange(1, 2));
    });

    testWidgets('PRD 4.5: halaman room berikut gagal -> gulir tidak mengulang request, hanya "Coba lagi"', (
      tester,
    ) async {
      var failMore = true;
      final app = await _openNetwork(
        tester,
        routes: {
          '/directory': (_) => FakeResponse.json(200, directoryPageJson(_members)),
          '/chat/rooms': (options) {
            if (options.queryParameters['kind'] != 'direct') return FakeResponse.json(200, roomPageJson(const []));
            if (options.queryParameters['cursor'] == 'c-2') {
              return failMore
                  ? FakeResponse.network()
                  : FakeResponse.json(200, roomPageJson([roomSummaryJson(id: 'room-99', title: 'Terakhir Sekali')]));
            }
            return FakeResponse.json(
              200,
              roomPageJson([
                for (var i = 0; i < 15; i++)
                  roomSummaryJson(
                    id: 'room-$i',
                    title: 'Alumni Chat $i',
                    peer: peerJson(userId: 'peer-$i', name: 'Alumni Chat $i'),
                    lastMessage: previewJson(id: 'pm-$i', preview: 'Halo $i'),
                    lastMessageAt: testNow.subtract(Duration(minutes: i)),
                  ),
              ], nextCursor: 'c-2'),
            );
          },
        },
      );
      int moreRequests() =>
          app.adapter.requestsTo('/chat/rooms').where((r) => r.queryParameters['cursor'] == 'c-2').length;
      await tester.tap(find.text('Pesan'));
      await settle(tester);
      for (var i = 0; i < 3; i++) {
        await tester.drag(find.byType(ListView).last, const Offset(0, -1500));
        await settle(tester);
      }
      expect(moreRequests(), 1);
      expect(find.widgetWithText(TextButton, 'Coba lagi'), findsOneWidget);

      failMore = false;
      await tester.tap(find.widgetWithText(TextButton, 'Coba lagi'));
      await settle(tester);
      expect(moreRequests(), 2);
      await scrollTo(tester, find.text('Terakhir Sekali'));
      expect(find.text('Terakhir Sekali'), findsOneWidget);
    });

    testWidgets('F-11: lencana tab Jejaring (unread + undangan) tampil sebelum Jejaring dibuka dan mengikuti event', (
      tester,
    ) async {
      final realtime = FakeChatRealtime();
      var unread = 2;
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          ...networkBaseRoutes(),
          '/chat/rooms': (_) =>
              FakeResponse.json(200, roomPageJson(const [], pendingInvitations: 1, unreadRooms: unread)),
        }),
        overrides: [chatRealtimeProvider.overrideWithValue(realtime)],
      );
      app.router.go('/home');
      await settle(tester);
      Finder badge(String label) => find.descendant(of: find.byType(NavigationBar), matching: find.text(label));
      int kindlessFetches() =>
          app.adapter.requestsTo('/chat/rooms').where((r) => r.queryParameters['kind'] == null).length;
      expect(badge('3'), findsOneWidget);
      expect(find.byTooltip('Jejaring, 2 percakapan belum dibaca, 1 undangan grup'), findsOneWidget);
      expect(kindlessFetches(), 1, reason: 'satu halaman kecil, bukan daftar penuh');
      expect('${app.adapter.requestsTo('/chat/rooms').single.queryParameters['limit']}', '1');

      // Pesan dari anggota lain: jumlah dimuat ulang.
      unread = 3;
      realtime.emit(
        messageCreated(chatMessageJson(id: 'x-1', roomId: 'room-5', senderId: 'user-5', createdAt: at(10))),
      );
      await settle(tester);
      expect(badge('4'), findsOneWidget);
      expect(kindlessFetches(), 2);

      // Pesan sendiri tidak mengubah jumlah belum dibaca: tanpa request.
      realtime.emit(
        messageCreated(
          chatMessageJson(
            id: 'x-2',
            roomId: 'room-5',
            senderId: 'user-1',
            senderName: 'Ahmad Islam',
            createdAt: at(11),
          ),
        ),
      );
      await settle(tester);
      expect(kindlessFetches(), 2);

      // Setelah Jejaring dibuka, daftar room yang memperbarui lencana (tanpa request lencana terpisah).
      app.router.go('/network');
      await settle(tester);
      realtime.emit(
        messageCreated(chatMessageJson(id: 'x-3', roomId: 'room-6', senderId: 'user-6', createdAt: at(12))),
      );
      await settle(tester);
      expect(kindlessFetches(), 2);
    });

    testWidgets('PRD 2.2: anggota expired tidak memuat lencana chat', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          ...networkBaseRoutes(),
          '/me': (_) => FakeResponse.json(200, meJson(status: 'expired')),
          '/chat/rooms': (_) => FakeResponse.json(200, roomPageJson(const [], pendingInvitations: 1, unreadRooms: 2)),
        }),
        overrides: [chatRealtimeProvider.overrideWithValue(FakeChatRealtime())],
      );
      app.router.go('/home');
      await settle(tester);
      expect(app.location, '/home');
      expect(app.adapter.requestsTo('/chat/rooms'), isEmpty);
      expect(find.byTooltip('Jejaring, terkunci'), findsOneWidget);
    });

    testWidgets('kosong: arahan memulai percakapan dari profil', (tester) async {
      await _openNetwork(tester, routes: {'/directory': (_) => FakeResponse.json(200, directoryPageJson(_members))});
      await tester.tap(find.text('Pesan'));
      await settle(tester);
      expect(find.text('Belum ada percakapan'), findsOneWidget);
      await tester.tap(find.text('Pesan Grup'));
      await settle(tester);
      expect(find.text('Belum ada grup'), findsOneWidget);
      expect(find.text('Buat grup'), findsOneWidget);
    });
  });
}
