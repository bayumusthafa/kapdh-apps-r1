import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/chat/chat_realtime.dart';
import 'package:kapdh_mobile/features/network/member_profile_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../chat/chat_fixtures.dart';
import 'network_fixtures.dart';

Future<AppHarness> _openProfile(
  WidgetTester tester, {
  required Map<String, FakeHandler> routes,
  String userId = 'user-2',
  double textScale = 1,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    textScale: textScale,
    handler: apiRoutes({
      ...networkBaseRoutes(),
      '/chat/rooms/room-9': (_) => FakeResponse.json(200, roomJson(id: 'room-9')),
      '/chat/rooms/room-9/messages': (_) => FakeResponse.json(200, pageJson(const [])),
      ...routes,
    }),
    overrides: [chatRealtimeProvider.overrideWithValue(FakeChatRealtime())],
  );
  app.router.go('/network');
  await settle(tester);
  app.router.push('/network/members/$userId');
  await settle(tester);
  return app;
}

void main() {
  group('Profil alumni (F-10, AC F10-2, F10-4)', () {
    testWidgets('AC F10-2: flag privasi mati -> kunci kontak tidak ada sehingga bagian kontak tidak tampil', (
      tester,
    ) async {
      await _openProfile(tester, routes: {'/directory/user-2': (_) => FakeResponse.json(200, profileJson())});
      expect(find.byType(MemberProfileScreen), findsOneWidget);
      expect(find.text('Ahmad Islam'), findsOneWidget);
      expect(find.text('Angkatan'), findsOneWidget);
      expect(find.text('#KAPDH01 · Lulus 1997'), findsOneWidget);
      expect(find.text('Universitas Indonesia • Jakarta'), findsOneWidget);
      expect(find.text('Guru'), findsOneWidget);
      // AC F10-4: master nonaktif tetap tampil sebagai label historis.
      expect(find.text('Berhitung Cepat'), findsOneWidget);
      expect(find.text('Nomor Telpon'), findsNothing);
      expect(find.text('Social Media'), findsNothing);
      expect(find.byIcon(Icons.mail_outline), findsNothing);
      expect(find.text('Kirim Pesan'), findsOneWidget);
    });

    testWidgets('AC F10-2: kontak yang diizinkan pemilik tampil dan dapat dibuka (https saja)', (tester) async {
      final app = await _openProfile(
        tester,
        routes: {
          '/directory/user-2': (_) => FakeResponse.json(
            200,
            profileJson(
              email: 'ahmadislam@gmail.com',
              phone: '+62 87 873 465 3623',
              social: {'instagram': '@ahmadislam', 'x': 'AhIslam', 'facebook': null, 'linkedin': 'javascript:alert(1)'},
            ),
          ),
        },
      );
      expect(find.text('ahmadislam@gmail.com'), findsOneWidget);
      expect(find.text('Nomor Telpon'), findsOneWidget);
      expect(find.text('+62 87 873 465 3623'), findsOneWidget);
      expect(find.text('Social Media'), findsOneWidget);
      expect(find.bySemanticsLabel('Instagram: @ahmadislam'), findsOneWidget);
      expect(find.bySemanticsLabel('Facebook: null'), findsNothing);

      await scrollAndTap(tester, find.bySemanticsLabel('Instagram: @ahmadislam'));
      await settle(tester);
      expect(app.launched.last, Uri.parse('https://instagram.com/ahmadislam'));
      // Nilai yang bukan nama pengguna/https tidak pernah dibuka.
      expect(SocialNetwork.linkedin.linkFor('javascript:alert(1)'), isNull);
      expect(
        SocialNetwork.linkedin.linkFor('https://www.linkedin.com/in/ahmad'),
        Uri.parse('https://www.linkedin.com/in/ahmad'),
      );
    });

    testWidgets('F-10, N-11: ketuk nomor telpon membuka panggilan; tekan lama menyalin', (tester) async {
      final semantics = tester.ensureSemantics();
      final app = await _openProfile(
        tester,
        routes: {'/directory/user-2': (_) => FakeResponse.json(200, profileJson(phone: '+62 87 873 465 3623'))},
      );
      await scrollTo(tester, find.text('+62 87 873 465 3623'));
      expect(
        tester.getSemantics(find.bySemanticsLabel('Telepon +62 87 873 465 3623')),
        isSemantics(isLink: true, hasTapAction: true, hasLongPressAction: true),
      );
      expect(tester.getSize(find.bySemanticsLabel('Telepon +62 87 873 465 3623')).height, greaterThanOrEqualTo(48));

      await tester.tap(find.text('+62 87 873 465 3623'));
      await settle(tester);
      expect(app.launched, [Uri.parse('tel:+62878734653623')]);

      final copied = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await tester.longPress(find.text('+62 87 873 465 3623'));
      await settle(tester);
      expect(copied, ['+62 87 873 465 3623']);
      expect(find.text('Nomor telpon disalin.'), findsOneWidget);
      expect(app.launched, hasLength(1));
      semantics.dispose();
    });

    testWidgets('AC F11-1: Kirim Pesan tanpa room membuat/mengambil room direct kanonik lalu membukanya', (
      tester,
    ) async {
      final app = await _openProfile(
        tester,
        routes: {
          '/directory/user-2': (_) => FakeResponse.json(200, profileJson()),
          '/chat/direct': (_) => FakeResponse.json(201, roomJson(id: 'room-9')),
        },
      );
      await tester.tap(find.text('Kirim Pesan'));
      await settle(tester);
      final request = app.adapter.requestsTo('/chat/direct').single;
      expect(request.data, {'user_id': 'user-2'});
      expect(app.location, '/chat/room-9');
    });

    testWidgets('Kirim Pesan dengan direct_room_id langsung membuka room tanpa POST', (tester) async {
      final app = await _openProfile(
        tester,
        routes: {'/directory/user-2': (_) => FakeResponse.json(200, profileJson(directRoomId: 'room-9'))},
      );
      await tester.tap(find.text('Kirim Pesan'));
      await settle(tester);
      expect(app.adapter.requestsTo('/chat/direct'), isEmpty);
      expect(app.location, '/chat/room-9');
    });

    testWidgets('AC F12-1: blokir dari menu (konfirmasi) lalu profil menawarkan buka blokir', (tester) async {
      var blocked = false;
      final app = await _openProfile(
        tester,
        routes: {
          '/directory/user-2': (_) => FakeResponse.json(200, profileJson(isBlockedByMe: blocked, canMessage: !blocked)),
          '/blocks/user-2': (options) {
            blocked = options.method == 'PUT';
            return options.method == 'PUT'
                ? FakeResponse.json(200, blockedJson('user-2', 'Ahmad Islam'))
                : FakeResponse.json(204);
          },
        },
      );
      await tester.tap(find.byTooltip('Tindakan lain'));
      await settle(tester);
      await tester.tap(find.text('Blokir').last);
      await settle(tester);
      expect(find.text('Blokir Ahmad Islam?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Blokir'));
      await settle(tester);
      expect(app.adapter.requestsTo('/blocks/user-2').single.method, 'PUT');
      expect(find.textContaining('Anda memblokir Ahmad Islam'), findsOneWidget);
      expect(find.text('Kirim Pesan'), findsNothing);

      await tester.tap(find.widgetWithText(TextButton, 'Buka blokir'));
      await settle(tester);
      await tester.tap(find.widgetWithText(TextButton, 'Buka blokir').last);
      await settle(tester);
      expect(app.adapter.requestsTo('/blocks/user-2').last.method, 'DELETE');
      expect(find.text('Kirim Pesan'), findsOneWidget);
    });

    testWidgets('AC F12-1, N-09: can_message false tanpa blokir sendiri -> alasan tidak dibedakan', (tester) async {
      await _openProfile(
        tester,
        routes: {'/directory/user-2': (_) => FakeResponse.json(200, profileJson(canMessage: false))},
      );
      expect(find.text('Pesan langsung belum tersedia untuk anggota ini.'), findsOneWidget);
      expect(find.text('Kirim Pesan'), findsNothing);
    });

    testWidgets('AC F12-2: laporkan pengguna dengan kategori; Idempotency-Key dikirim', (tester) async {
      final app = await _openProfile(
        tester,
        routes: {
          '/directory/user-2': (_) => FakeResponse.json(200, profileJson()),
          '/reports': (_) => FakeResponse.json(201, reportJson(targetName: 'Ahmad Islam')),
        },
      );
      await tester.tap(find.byTooltip('Tindakan lain'));
      await settle(tester);
      await tester.tap(find.text('Laporkan'));
      await settle(tester);
      expect(find.text('Laporkan pengguna'), findsOneWidget);
      // Kategori wajib.
      await scrollAndTap(tester, find.text('Kirim laporan'));
      await settle(tester);
      expect(find.text('Pilih kategori laporan.'), findsOneWidget);
      // Lainnya wajib penjelasan minimal 10 karakter.
      await scrollAndTap(tester, find.text('Lainnya'));
      await scrollAndTap(tester, find.text('Kirim laporan'));
      await settle(tester);
      expect(find.text('Jelaskan masalahnya minimal 10 karakter.'), findsOneWidget);
      await scrollAndTap(tester, find.text('Pelecehan atau perundungan'));
      await tester.enterText(find.byType(TextField).last, 'Mengirim pesan kasar berulang kali.');
      await scrollAndTap(tester, find.text('Kirim laporan'));
      await settle(tester);
      final request = app.adapter.requestsTo('/reports').single;
      expect(request.data, {
        'target_type': 'user',
        'target_user_id': 'user-2',
        'category': 'harassment',
        'description': 'Mengirim pesan kasar berulang kali.',
      });
      expect(request.headers['Idempotency-Key'], isNotNull);
      expect(find.text('Laporan terkirim. Pengurus akan meninjaunya.'), findsOneWidget);
    });

    testWidgets('N-09: profil tidak tersedia (404) tanpa membedakan alasan', (tester) async {
      await _openProfile(
        tester,
        routes: {'/directory/user-2': (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan'))},
      );
      expect(find.text('Profil tidak tersedia'), findsOneWidget);
    });

    testWidgets('profil sendiri: pratinjau tanpa tombol pesan dan menu blokir', (tester) async {
      await _openProfile(
        tester,
        userId: 'user-1',
        routes: {
          '/directory/user-1': (_) =>
              FakeResponse.json(200, profileJson(userId: 'user-1', isMe: true, canMessage: false)),
        },
      );
      expect(find.text('Ini pratinjau profil Anda seperti dilihat alumni lain.'), findsOneWidget);
      expect(find.text('Kirim Pesan'), findsNothing);
      expect(find.byTooltip('Tindakan lain'), findsNothing);
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await _openProfile(
        tester,
        textScale: 2,
        routes: {
          '/directory/user-2': (_) => FakeResponse.json(
            200,
            profileJson(
              email: 'ahmadislam@gmail.com',
              phone: '0812',
              social: {'instagram': 'ahmad', 'x': null, 'facebook': null, 'linkedin': null},
            ),
          ),
        },
      );
      expect(tester.takeException(), isNull);
    });
  });
}
