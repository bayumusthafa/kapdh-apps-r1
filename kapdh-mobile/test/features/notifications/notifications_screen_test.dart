import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/notifications/notifications_repository.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../account/account_fixtures.dart';

void main() {
  Future<AppHarness> openInbox(
    WidgetTester tester, {
    String status = 'verified',
    FakeHandler? list,
    FakeHandler? read,
    Stream<NotificationCreatedPayload>? realtime,
    Map<String, FakeHandler> extra = const {},
    double textScale = 1,
  }) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      overrides: [
        notificationCreatedEventsProvider.overrideWithValue(
          realtime ?? const Stream<NotificationCreatedPayload>.empty(),
        ),
      ],
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: status)),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 1}),
        '/notifications':
            list ??
            (_) => FakeResponse.json(
              200,
              notificationPageJson([
                inboxJson(notificationId1),
                inboxJson(
                  notificationId2,
                  category: 'news',
                  title: 'Berita baru: Silaturahmi',
                  body: null,
                  deepLink: 'kapdh://app/news/silaturahmi',
                  readAt: testNow.subtract(const Duration(hours: 1)),
                  createdAt: testNow.subtract(const Duration(days: 1)),
                ),
              ]),
            ),
        '/notifications/read': read ?? (options) => FakeResponse.json(200, {'updated_count': 1, 'unread_count': 0}),
        ...extra,
      }),
    );
    app.router.go('/notifications');
    await settle(tester);
    return app;
  }

  testWidgets('AC F13-2: kotak masuk resmi menampilkan kategori, waktu dan penanda belum dibaca berlabel', (
    tester,
  ) async {
    await openInbox(tester);
    expect(find.text('Pembayaran disetujui'), findsOneWidget);
    expect(find.text('Iuran pendaftaran Anda sudah diverifikasi pengurus.'), findsOneWidget);
    expect(find.text('Pembayaran · 5 menit lalu'), findsOneWidget);
    expect(find.text('Berita baru: Silaturahmi'), findsOneWidget);
    expect(find.text('Baru'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Belum dibaca, Pembayaran, Pembayaran disetujui')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Berita, Berita baru: Silaturahmi')), findsOneWidget);
    expect(find.text('Belum dibaca (1)'), findsOneWidget);
  });

  testWidgets('keadaan kosong menjelaskan bahwa kotak masuk tetap menyimpan notifikasi', (tester) async {
    await openInbox(tester, list: (_) => FakeResponse.json(200, notificationPageJson([])));
    expect(find.text('Belum ada notifikasi'), findsOneWidget);
    expect(find.textContaining('termasuk saat notifikasi push dimatikan'), findsOneWidget);
  });

  testWidgets('filter Belum dibaca memuat ulang dengan unread_only', (tester) async {
    final app = await openInbox(
      tester,
      list: (options) => options.queryParameters['unread_only'] == true
          ? FakeResponse.json(200, notificationPageJson([], unreadCount: 0))
          : FakeResponse.json(200, notificationPageJson([inboxJson(notificationId1)])),
    );
    await tester.tap(find.byKey(const ValueKey('notifications-filter-unread')));
    await settle(tester);
    expect(app.adapter.requests.where((r) => r.path == '/notifications').last.queryParameters['unread_only'], true);
    expect(find.text('Semua notifikasi sudah dibaca'), findsOneWidget);
  });

  testWidgets('F-13: tandai semua dibaca terbatas pada notifikasi yang sudah dimuat (up_to)', (tester) async {
    final app = await openInbox(tester);
    await tester.tap(find.byKey(const ValueKey('notifications-mark-all')));
    await settle(tester);
    final request = app.adapter.requests.lastWhere((r) => r.path == '/notifications/read');
    expect(bodyOf(request), {'all': true, 'up_to': iso(testNow.subtract(const Duration(minutes: 5)))});
    expect(find.text('Baru'), findsNothing);
    expect(find.text('Belum dibaca'), findsOneWidget);
  });

  testWidgets('AC F13-3: ketuk notifikasi menandai dibaca lalu membuka deep link lewat router', (tester) async {
    final app = await openInbox(tester);
    await tester.tap(find.text('Pembayaran disetujui'));
    await settle(tester);
    expectLastBody(app.adapter, '/notifications/read', {
      'ids': [notificationId1],
    });
    expect(app.location, '/payments/pay-1');
  });

  testWidgets('AC F13-3: hak berubah — deep link ke fitur anggota aktif dialihkan redirect sesuai status', (
    tester,
  ) async {
    final app = await openInbox(
      tester,
      status: 'expired',
      list: (_) => FakeResponse.json(
        200,
        notificationPageJson([
          inboxJson(
            notificationId3,
            category: 'chat',
            title: 'Pesan baru',
            body: null,
            deepLink: 'kapdh://app/chat/room-1',
          ),
        ]),
      ),
    );
    await tester.tap(find.text('Pesan baru'));
    await settle(tester);
    // Anggota expired tidak boleh membuka chat (PRD 2.2): diarahkan ke perpanjangan, bukan ke room.
    expect(app.location, '/renewal');
  });

  testWidgets('rute yang belum dikenal aplikasi tetap di kotak masuk', (tester) async {
    final app = await openInbox(
      tester,
      list: (_) => FakeResponse.json(
        200,
        notificationPageJson([
          inboxJson(notificationId1, title: 'Fitur baru', deepLink: 'kapdh://app/fitur-masa-depan/1'),
        ]),
      ),
    );
    await tester.tap(find.text('Fitur baru'));
    await settle(tester);
    expect(app.location, '/notifications');
    expect(find.text('Tujuan notifikasi ini belum didukung versi aplikasi Anda.'), findsOneWidget);
  });

  testWidgets('realtime notification.created menambah notifikasi di atas dan memperbarui jumlah', (tester) async {
    final events = StreamController<NotificationCreatedPayload>.broadcast();
    addTearDown(events.close);
    await openInbox(tester, realtime: events.stream);
    events.add(
      NotificationCreatedPayload.fromJson({
        'id': notificationId3,
        'category': 'membership',
        'title': 'KTA Anda aktif',
        'body': null,
        'deep_link': 'kapdh://app/kta',
        'created_at': iso(testNow),
        'unread_count': 2,
      }),
    );
    await settle(tester);
    expect(find.text('KTA Anda aktif'), findsOneWidget);
    expect(find.text('Belum dibaca (2)'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('KTA Anda aktif')).dy,
      lessThan(tester.getTopLeft(find.text('Pembayaran disetujui')).dy),
    );
  });

  testWidgets('paging keyset: halaman berikut dimuat dengan cursor', (tester) async {
    final app = await openInbox(
      tester,
      list: (options) => options.queryParameters['cursor'] == 'n-2'
          ? FakeResponse.json(200, notificationPageJson([inboxJson(notificationId3, title: 'Notifikasi lama')]))
          : FakeResponse.json(200, notificationPageJson([inboxJson(notificationId1)], nextCursor: 'n-2')),
    );
    await scrollAndTap(tester, find.text('Muat lebih banyak'));
    await settle(tester);
    expect(find.text('Notifikasi lama'), findsOneWidget);
    expect(app.adapter.requests.where((r) => r.queryParameters['cursor'] == 'n-2'), hasLength(1));
  });

  testWidgets('PRD 4.5: galat memuat kotak masuk dengan coba lagi', (tester) async {
    var calls = 0;
    await openInbox(
      tester,
      list: (_) {
        calls++;
        return calls == 1
            ? FakeResponse.network()
            : FakeResponse.json(200, notificationPageJson([inboxJson(notificationId1)]));
      },
    );
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Pembayaran disetujui'), findsOneWidget);
  });

  testWidgets('PRD 2.2: anggota unverified tetap dapat membuka kotak masuk', (tester) async {
    final app = await openInbox(tester, status: 'unverified');
    expect(app.location, '/notifications');
    expect(find.text('Pembayaran disetujui'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openInbox(tester, textScale: 2);
    expect(tester.takeException(), isNull);
  });
}
