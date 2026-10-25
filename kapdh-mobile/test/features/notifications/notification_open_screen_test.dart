import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/push/push_platform.dart';
import 'package:kapdh_mobile/core/push/push_service.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../account/account_fixtures.dart';

void main() {
  group('AC F13-3: payload push ke gerbang /notifications/<id>', () {
    test('notification_id UUID membuat ketukan membuka gerbang pemeriksaan server', () {
      final message = PushMessage.fromData(
        title: 'Pembayaran disetujui',
        data: {'notification_id': notificationId1, 'category': 'payment', 'deep_link': 'kapdh://app/payments/pay-1'},
      );
      expect(message.notificationId, notificationId1);
      expect(message.openRoute, '/notifications/$notificationId1');
    });

    test('tanpa notification_id (atau tidak sah) memakai rute payload yang tetap diperiksa redirect', () {
      final legacy = PushMessage.fromData(data: {'route': '/payments/pay-1'});
      expect(legacy.openRoute, '/payments/pay-1');
      final forged = PushMessage.fromData(data: {'notification_id': '../../account', 'deep_link': '/kta'});
      expect(forged.notificationId, isNull);
      expect(forged.openRoute, '/kta');
    });

    test('ketukan notifikasi sistem membuka gerbang lewat PushService', () async {
      final platform = FakePushPlatform();
      final opened = <Uri>[];
      final service = PushService(
        platform: platform,
        registerDevice: (_) async {},
        unregisterDevice: (_) async {},
        info: testAppInfo,
        openLocation: opened.add,
        store: MemorySecureStore(),
      );
      await service.start();
      platform.opened.add(
        PushMessage.fromData(data: {'notification_id': notificationId2, 'deep_link': 'kapdh://app/kta'}),
      );
      await pumpEventQueue();
      expect(opened.single.path, '/notifications/$notificationId2');
      await service.dispose();
    });
  });

  testWidgets('AC F13-3: setelah logout, ketukan push meminta login dulu lalu membuka tujuan resmi dari server', (
    tester,
  ) async {
    final app = await pumpApp(
      tester,
      handler: apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 1}),
        '/notifications/$notificationId1': (_) => FakeResponse.json(200, inboxJson(notificationId1)),
        '/notifications/read': (_) => FakeResponse.json(200, {'updated_count': 1, 'unread_count': 0}),
      }),
    );
    app.router.go('/notifications/$notificationId1');
    await settle(tester);
    expect(app.location, startsWith('/login'));
    expect(app.adapter.requests.where((r) => r.path.startsWith('/notifications/')), isEmpty);

    await tester.enterText(
      find.descendant(of: find.byKey(const ValueKey('login-email')), matching: find.byType(EditableText)),
      'ahmad.islam@contoh.test',
    );
    await tester.enterText(
      find.descendant(of: find.byKey(const ValueKey('login-password')), matching: find.byType(EditableText)),
      'Rahasia#2026',
    );
    await tester.pump();
    await scrollAndTap(tester, find.byKey(const ValueKey('login-submit')));
    await settle(tester);

    expect(countRequests(app.adapter, '/notifications/$notificationId1'), 1);
    expectLastBody(app.adapter, '/notifications/read', {
      'ids': [notificationId1],
    });
    expect(app.location, '/payments/pay-1');
  });

  testWidgets('AC F13-5: notifikasi akun sebelumnya (404) tidak membuka objek apa pun', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/notifications/$notificationId2': (_) =>
            FakeResponse.json(404, errorJson('NOT_FOUND', 'Data tidak ditemukan.')),
        '/notifications': (_) => FakeResponse.json(200, notificationPageJson([])),
      }),
    );
    app.router.go('/notifications/$notificationId2');
    await settle(tester);
    expect(app.location, '/notifications/$notificationId2');
    expect(find.text('Notifikasi tidak tersedia'), findsOneWidget);
    expect(app.adapter.requests.where((r) => r.path == '/notifications/read'), isEmpty);
    await tester.tap(find.text('Buka kotak masuk'));
    await settle(tester);
    expect(app.location, '/notifications');
  });

  testWidgets('AC F13-3: status berubah (suspended) — notifikasi diperiksa server, tujuan dialihkan ke portal', (
    tester,
  ) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: 'suspended')),
        '/reports': (_) => FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 1}),
        '/notifications/$notificationId1': (_) => FakeResponse.json(200, inboxJson(notificationId1)),
        '/notifications/read': (_) => FakeResponse.json(200, {'updated_count': 1, 'unread_count': 0}),
      }),
    );
    app.router.go('/notifications/$notificationId1');
    await settle(tester);
    // Kotak masuk resmi tetap milik anggota suspended (kontrak C7 member_access any, AC F13-2): gerbang memeriksa
    // notifikasi ke server, tetapi tujuan pembayaran ditolak matriks status sehingga yang terbuka portal pembatasan.
    expect(countRequests(app.adapter, '/notifications/$notificationId1'), 1);
    expectLastBody(app.adapter, '/notifications/read', {
      'ids': [notificationId1],
    });
    expect(app.location, '/restricted');
    expect(app.adapter.requests.where((r) => r.path.startsWith('/payments')), isEmpty);
  });

  testWidgets('AC F13-2: notifikasi keamanan untuk anggota suspended terbuka di kotak masuk', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: 'suspended')),
        '/reports': (_) => FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/notifications/$notificationId2': (_) => FakeResponse.json(
          200,
          inboxJson(
            notificationId2,
            category: 'security',
            title: 'Login baru di perangkat lain',
            deepLink: null,
            readAt: testNow,
          ),
        ),
        '/notifications': (_) => FakeResponse.json(
          200,
          notificationPageJson([
            inboxJson(
              notificationId2,
              category: 'security',
              title: 'Login baru di perangkat lain',
              deepLink: null,
              readAt: testNow,
            ),
          ]),
        ),
      }),
    );
    app.router.go('/notifications/$notificationId2');
    await settle(tester);
    expect(app.location, '/notifications');
    expect(find.text('Login baru di perangkat lain'), findsOneWidget);
  });

  testWidgets('galat jaringan saat memeriksa notifikasi menawarkan coba lagi', (tester) async {
    var calls = 0;
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/notifications/$notificationId1': (_) {
          calls++;
          return calls == 1
              ? FakeResponse.network()
              : FakeResponse.json(200, inboxJson(notificationId1, deepLink: 'kapdh://app/kta', readAt: testNow));
        },
      }),
    );
    app.router.go('/notifications/$notificationId1');
    await settle(tester);
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(app.location, '/kta');
    // Sudah dibaca: tidak ada POST read.
    expect(app.adapter.requests.where((r) => r.path == '/notifications/read'), isEmpty);
  });
}
