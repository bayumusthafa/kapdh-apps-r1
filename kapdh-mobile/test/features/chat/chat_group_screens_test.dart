import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/chat/chat_image_picker.dart';
import 'package:kapdh_mobile/features/chat/chat_info_screen.dart';
import 'package:kapdh_mobile/features/chat/chat_invitations_screen.dart';
import 'package:kapdh_mobile/features/chat/chat_realtime.dart';
import 'package:kapdh_mobile/features/chat/new_group_screen.dart';
import 'package:kapdh_mobile/features/chat/outgoing_message.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../network/network_fixtures.dart';
import 'chat_fixtures.dart';
import 'chat_server.dart';

Future<AppHarness> _open(
  WidgetTester tester,
  String location, {
  FakeChatServer? server,
  Map<String, FakeHandler> routes = const {},
  FakeChatRealtime? realtime,
  ChatImagePicker? picker,
  double textScale = 1,
}) async {
  final base = apiRoutes({...networkBaseRoutes(), ...routes});
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    handler: server == null ? base : server.handler(base),
    overrides: [
      chatRealtimeProvider.overrideWithValue(realtime ?? FakeChatRealtime()),
      if (picker != null) chatImagePickerProvider.overrideWithValue(picker),
    ],
  );
  app.router.go('/network');
  await settle(tester);
  app.router.push(location);
  await settle(tester);
  return app;
}

Map<String, Object?> _invitationJson(String roomId, String name) => {
  'room_id': roomId,
  'room_name': name,
  'room_avatar_url': null,
  'member_count': 12,
  'invited_by': userRefJson('user-5', 'Siti Aminah'),
  'invited_at': iso(testNow.subtract(const Duration(hours: 2))),
};

FakeChatServer _group({bool admin = true, int otherAdmins = 0}) {
  final server = FakeChatServer(
    room: roomJson(
      kind: 'group',
      title: 'Angkatan 29',
      memberCount: 3 + otherAdmins,
      myRole: admin ? 'admin' : 'member',
      canManage: admin,
    ),
  );
  server.members = [
    memberJson(userId: 'user-1', name: 'Ahmad Islam', role: admin ? 'admin' : 'member', isMe: true),
    for (var i = 0; i < otherAdmins; i++) memberJson(userId: 'admin-$i', name: 'Admin $i', role: 'admin'),
    memberJson(userId: 'user-2', name: 'Gamerisa Dewi'),
    memberJson(userId: 'user-3', name: 'Budi Santoso'),
  ];
  server.invited = [memberJson(userId: 'user-7', name: 'Rahmat Hidayat', status: 'invited')];
  return server;
}

void main() {
  group('Undangan grup (F-11, PRD 3.11)', () {
    testWidgets('terima undangan membuka room; tolak (dengan konfirmasi) menghapus undangan', (tester) async {
      final server = FakeChatServer(
        room: roomJson(kind: 'group', title: 'Angkatan 29'),
      );
      final app = await _open(
        tester,
        '/chat/invitations',
        server: server,
        routes: {
          '/chat/invitations': (_) => FakeResponse.json(
            200,
            pageJson([_invitationJson('room-1', 'Angkatan 29'), _invitationJson('room-2', 'Panitia Reuni')]),
          ),
          '/chat/invitations/room-2/decline': (_) => FakeResponse.json(204),
          '/chat/invitations/room-1/accept': (_) =>
              FakeResponse.json(200, roomJson(kind: 'group', title: 'Angkatan 29')),
        },
      );
      expect(find.byType(ChatInvitationsScreen), findsOneWidget);
      expect(find.text('Panitia Reuni'), findsOneWidget);
      expect(find.textContaining('Diundang oleh Siti Aminah'), findsNWidgets(2));

      await tester.tap(find.text('Tolak').last);
      await settle(tester);
      expect(find.text('Tolak undangan Panitia Reuni?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Tolak').last);
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/invitations/room-2/decline').single.headers['Idempotency-Key'], isNotNull);
      expect(find.text('Panitia Reuni'), findsNothing);

      await tester.tap(find.text('Terima'));
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/invitations/room-1/accept'), hasLength(1));
      expect(app.location, '/chat/room-1');
    });

    testWidgets('kosong: tidak ada undangan', (tester) async {
      await _open(
        tester,
        '/chat/invitations',
        routes: {'/chat/invitations': (_) => FakeResponse.json(200, pageJson(const []))},
      );
      expect(find.text('Tidak ada undangan'), findsOneWidget);
    });

    testWidgets('undangan baru lewat room.member_changed (invited) memuat ulang daftar', (tester) async {
      var items = <Map<String, Object?>>[];
      final realtime = FakeChatRealtime();
      await _open(
        tester,
        '/chat/invitations',
        realtime: realtime,
        routes: {'/chat/invitations': (_) => FakeResponse.json(200, pageJson(items))},
      );
      expect(find.text('Tidak ada undangan'), findsOneWidget);
      items = [_invitationJson('room-3', 'Alumni Riau')];
      realtime.emit(memberChanged('user-1', 'invited', roomId: 'room-3', actor: 'user-5'));
      await settle(tester);
      expect(find.text('Alumni Riau'), findsOneWidget);
    });
  });

  group('Info grup (F-11, AC F11-4, F11-5)', () {
    testWidgets('admin: anggota, undangan tertunda, bisukan, jadikan admin, keluarkan', (tester) async {
      final server = _group();
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: server,
        routes: {
          '/chat/rooms/room-1/mute': (_) => FakeResponse.json(204),
          '/chat/rooms/room-1/members/user-2': (options) => options.method == 'PATCH'
              ? FakeResponse.json(200, memberJson(userId: 'user-2', name: 'Gamerisa Dewi', role: 'admin'))
              : FakeResponse.json(204),
          '/chat/rooms/room-1/members/user-7': (_) => FakeResponse.json(204),
          '/chat/rooms/room-1/members/user-3': (_) => FakeResponse.json(204),
        },
      );
      expect(find.byType(ChatInfoScreen), findsOneWidget);
      expect(find.text('Anggota (3)'), findsOneWidget);
      expect(find.text('Ahmad Islam (Anda)'), findsOneWidget);
      expect(find.text('Undangan tertunda (1)'), findsOneWidget);
      expect(find.text('Rahmat Hidayat'), findsOneWidget);

      await tester.tap(find.text('Bisukan notifikasi'));
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/rooms/room-1/mute').single.data, {'muted': true});

      await scrollAndTap(tester, find.byTooltip('Tindakan untuk Gamerisa Dewi'));
      await settle(tester);
      await tester.tap(find.text('Jadikan admin'));
      await settle(tester);
      // PRD 4.5: perubahan izin dikonfirmasi dulu.
      expect(find.text('Jadikan Gamerisa Dewi admin?'), findsOneWidget);
      expect(app.adapter.requestsTo('/chat/rooms/room-1/members/user-2'), isEmpty);
      await tester.tap(find.widgetWithText(TextButton, 'Jadikan admin'));
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/rooms/room-1/members/user-2').single.data, {'role': 'admin'});

      await scrollAndTap(tester, find.byTooltip('Tindakan untuk Budi Santoso'));
      await settle(tester);
      await tester.tap(find.text('Keluarkan dari grup'));
      await settle(tester);
      expect(find.text('Keluarkan Budi Santoso?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Keluarkan'));
      await settle(tester);
      final removal = app.adapter.requestsTo('/chat/rooms/room-1/members/user-3').single;
      expect(removal.method, 'DELETE');
      expect(removal.headers['Idempotency-Key'], isNotNull);

      await scrollAndTap(tester, find.text('Batalkan'));
      await settle(tester);
      await tester.tap(find.widgetWithText(TextButton, 'Batalkan undangan'));
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/rooms/room-1/members/user-7').single.method, 'DELETE');
    });

    testWidgets('admin mengundang alumni lewat pemilih direktori; anggota/undangan yang ada tidak dapat dipilih', (
      tester,
    ) async {
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: _group(),
        routes: {
          '/directory': (_) => FakeResponse.json(
            200,
            directoryPageJson([
              directoryMemberJson(userId: 'user-2', name: 'Gamerisa Dewi'),
              directoryMemberJson(userId: 'user-8', name: 'Zainal Arifin'),
              directoryMemberJson(userId: 'user-9', name: 'Nur Hasanah'),
            ]),
          ),
          '/chat/rooms/room-1/invitations': (_) => FakeResponse.json(200, {
            'invited_user_ids': ['user-8'],
            'skipped': [
              {'user_id': 'user-9', 'reason': 'room_full'},
            ],
          }),
        },
      );
      await tester.tap(find.text('Undang'));
      await settle(tester);
      expect(find.text('Undang ke Angkatan 29'), findsOneWidget);
      expect(find.text('Gamerisa Dewi'), findsNothing, reason: 'sudah anggota');
      await tester.tap(find.text('Zainal Arifin'));
      await tester.tap(find.text('Nur Hasanah'));
      await tester.pump();
      await tester.tap(find.text('Selesai (2)'));
      await settle(tester);
      final invite = app.adapter.requestsTo('/chat/rooms/room-1/invitations').single;
      expect(invite.data, {
        'user_ids': ['user-8', 'user-9'],
      });
      expect(invite.headers['Idempotency-Key'], isNotNull);
      expect(find.text('1 undangan terkirim'), findsOneWidget);
      expect(find.text('Nur Hasanah: grup sudah penuh (100 anggota)'), findsOneWidget);
    });

    testWidgets('AC F12-2: laporkan grup', (tester) async {
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: _group(admin: false),
        routes: {
          '/reports': (_) =>
              FakeResponse.json(201, reportJson(targetType: 'room', targetName: null, roomName: 'Angkatan 29')),
        },
      );
      await scrollAndTap(tester, find.text('Laporkan grup'));
      await settle(tester);
      await scrollAndTap(tester, find.text('Penipuan'));
      await scrollAndTap(tester, find.text('Kirim laporan'));
      await settle(tester);
      expect(app.adapter.requestsTo('/reports').single.data, {
        'target_type': 'room',
        'room_id': 'room-1',
        'category': 'scam',
      });
    });

    testWidgets('AC F11-5: admin terakhir wajib memilih pengganti sebelum keluar', (tester) async {
      final server = _group();
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: server,
        routes: {'/chat/rooms/room-1/leave': (_) => FakeResponse.json(204)},
      );
      await scrollAndTap(tester, find.text('Keluar grup'));
      await settle(tester);
      expect(find.text('Pilih admin pengganti'), findsOneWidget);
      final leaveButton = find.widgetWithText(TextButton, 'Keluar grup');
      expect(tester.widget<TextButton>(leaveButton).onPressed, isNull, reason: 'pengganti wajib dipilih');
      await tester.tap(find.text('Gamerisa Dewi').last);
      await tester.pump();
      await tester.tap(leaveButton);
      await settle(tester);
      final leave = app.adapter.requestsTo('/chat/rooms/room-1/leave').single;
      expect(leave.data, {'successor_user_id': 'user-2'});
      expect(leave.headers['Idempotency-Key'], isNotNull);
      expect(app.location, '/network');
    });

    testWidgets('AC F11-5: masih ada admin lain -> keluar cukup dengan konfirmasi', (tester) async {
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: _group(otherAdmins: 1),
        routes: {'/chat/rooms/room-1/leave': (_) => FakeResponse.json(204)},
      );
      await scrollAndTap(tester, find.text('Keluar grup'));
      await settle(tester);
      expect(find.text('Keluar dari grup?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Keluar'));
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/rooms/room-1/leave').single.data, <String, Object?>{});
    });

    testWidgets('anggota biasa: tidak ada kelola anggota, undang atau undangan tertunda', (tester) async {
      await _open(tester, '/chat/room-1/info', server: _group(admin: false));
      expect(find.text('Undang'), findsNothing);
      expect(find.text('Ubah nama'), findsNothing);
      expect(find.textContaining('Undangan tertunda'), findsNothing);
      expect(find.text('Laporkan grup'), findsOneWidget);
    });

    testWidgets('ubah nama grup dengan If-Match; konflik versi memuat data terbaru', (tester) async {
      final server = _group();
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: server,
        routes: {
          '/chat/rooms/room-1': (options) => options.method == 'PATCH'
              ? FakeResponse.json(
                  409,
                  errorJson(
                    'VERSION_CONFLICT',
                    'Data sudah diubah anggota lain.',
                    current: roomJson(
                      kind: 'group',
                      title: 'Angkatan 29 Riau',
                      myRole: 'admin',
                      canManage: true,
                      version: '2',
                    ),
                  ),
                )
              : FakeResponse.json(200, server.room),
        },
      );
      // GET room dilayani server tiruan lebih dulu; PATCH diteruskan ke rute di atas.
      await tester.tap(find.text('Ubah nama'));
      await settle(tester);
      await tester.enterText(find.byType(TextField).last, 'Angkatan 29 Pekanbaru');
      await tester.tap(find.text('Simpan'));
      await settle(tester);
      final patch = app.adapter.requests.where((r) => r.method == 'PATCH').single;
      expect(patch.headers['If-Match'], '1');
      expect(patch.data, {'name': 'Angkatan 29 Pekanbaru'});
      expect(find.text('Data sudah diubah anggota lain.'), findsOneWidget);
    });

    testWidgets('room direct: lihat profil, blokir dan laporkan pengguna', (tester) async {
      final server = FakeChatServer();
      final app = await _open(
        tester,
        '/chat/room-1/info',
        server: server,
        routes: {'/blocks/user-2': (_) => FakeResponse.json(200, blockedJson('user-2', 'Gamerisa Dewi'))},
      );
      expect(find.text('Percakapan langsung'), findsOneWidget);
      expect(find.text('Lihat profil'), findsOneWidget);
      await tester.tap(find.text('Blokir Gamerisa Dewi'));
      await settle(tester);
      await tester.tap(find.widgetWithText(TextButton, 'Blokir'));
      await settle(tester);
      expect(app.adapter.requestsTo('/blocks/user-2').single.method, 'PUT');
      expect(find.text('Laporkan pengguna'), findsOneWidget);
    });
  });

  group('Grup baru (F-11)', () {
    testWidgets('nama wajib; grup dibuat dengan foto dan undangan; undangan yang dilewati dijelaskan', (tester) async {
      final app = await _open(
        tester,
        '/chat/new-group',
        server: FakeChatServer(
          room: roomJson(kind: 'group', title: 'Panitia Reuni', myRole: 'admin', canManage: true),
        ),
        picker: (_) async =>
            OutgoingImage(bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF]), filename: 'grup.jpg', mime: 'image/jpeg'),
        routes: {
          '/directory': (_) => FakeResponse.json(
            200,
            directoryPageJson([
              directoryMemberJson(userId: 'user-2', name: 'Gamerisa Dewi'),
              directoryMemberJson(userId: 'user-3', name: 'Budi Santoso'),
            ]),
          ),
          '/files': (_) => FakeResponse.json(201, {
            'id': 'file-avatar',
            'purpose': 'chat_image',
            'mime': 'image/jpeg',
            'bytes': 3,
            'width': 10,
            'height': 10,
            'visibility': 'private',
            'public_url': null,
            'created_at': iso(testNow),
          }),
          '/chat/rooms': (options) => options.method == 'POST'
              ? FakeResponse.json(201, {
                  'room': roomJson(kind: 'group', title: 'Panitia Reuni', myRole: 'admin', canManage: true),
                  'invitations': {
                    'invited_user_ids': ['user-2'],
                    'skipped': [
                      {'user_id': 'user-3', 'reason': 'not_invitable'},
                    ],
                  },
                })
              : FakeResponse.json(200, roomPageJson(const [])),
        },
      );
      expect(find.byType(NewGroupScreen), findsOneWidget);
      await scrollAndTap(tester, find.text('Buat grup'));
      await settle(tester);
      expect(find.text('Nama grup wajib diisi.'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextFormField, 'Contoh: Angkatan 29'), 'Panitia Reuni');
      await tester.tap(find.bySemanticsLabel('Pilih foto grup'));
      await settle(tester);
      await tester.tap(find.text('Pilih alumni'));
      await settle(tester);
      await tester.tap(find.text('Gamerisa Dewi'));
      await tester.tap(find.text('Budi Santoso'));
      await tester.pump();
      await tester.tap(find.text('Selesai (2)'));
      await settle(tester);
      expect(find.text('Undang alumni (2)'), findsOneWidget);

      await scrollAndTap(tester, find.text('Buat grup'));
      await settle(tester);
      final create = app.adapter.requestsTo('/chat/rooms').where((r) => r.method == 'POST').single;
      expect(create.data, {
        'name': 'Panitia Reuni',
        'avatar_file_id': 'file-avatar',
        'invitee_user_ids': ['user-2', 'user-3'],
      });
      expect(create.headers['Idempotency-Key'], isNotNull);
      expect(find.text('Sebagian undangan tidak terkirim'), findsOneWidget);
      expect(find.text('Budi Santoso: tidak dapat diundang'), findsOneWidget);
      await tester.tap(find.text('Tutup'));
      await settle(tester);
      expect(app.location, '/chat/room-1');
    });
  });

  group('Teks 200 % tanpa meluap (N-11)', () {
    testWidgets('info grup admin', (tester) async {
      await _open(tester, '/chat/room-1/info', server: _group(), textScale: 2);
      expect(tester.takeException(), isNull);
    });

    testWidgets('undangan grup', (tester) async {
      await _open(
        tester,
        '/chat/invitations',
        textScale: 2,
        routes: {
          '/chat/invitations': (_) =>
              FakeResponse.json(200, pageJson([_invitationJson('room-2', 'Panitia Reuni Akbar')])),
        },
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('grup baru', (tester) async {
      await _open(tester, '/chat/new-group', textScale: 2);
      expect(tester.takeException(), isNull);
    });
  });
}
