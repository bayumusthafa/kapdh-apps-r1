import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/app_services.dart';
import 'package:kapdh_mobile/core/push/push_platform.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

void main() {
  Future<AppHarness> openPreferences(
    WidgetTester tester, {
    FakePushPlatform? platform,
    FakeHandler? prefs,
    Map<String, FakeHandler> extra = const {},
    double textScale = 1,
  }) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      overrides: [pushPlatformProvider.overrideWithValue(platform ?? FakePushPlatform())],
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/notifications/preferences':
            prefs ??
            (options) => options.method == 'PUT'
                ? FakeResponse.json(200, {
                    ...bodyOf(options),
                    'mandatory_categories': ['security', 'account'],
                    'updated_at': iso(testNow),
                  })
                : FakeResponse.json(200, preferencesJson()),
        '/devices': (_) => FakeResponse.json(204),
        ...extra,
      }),
    );
    app.router.go('/account');
    await settle(tester);
    app.router.push('/account/notifications');
    await settle(tester);
    await drainPushQueue(tester);
    return app;
  }

  bool value(WidgetTester tester, String key) => tester.widget<SwitchListTile>(find.byKey(ValueKey('pref-$key'))).value;

  testWidgets('F-13: saklar push dan email per kategori; keamanan dan akun selalu aktif dan terkunci', (tester) async {
    await openPreferences(tester);
    for (final key in ['push-payment', 'push-membership', 'push-event', 'push-news', 'push-chat']) {
      expect(value(tester, key), isTrue, reason: key);
    }
    for (final key in ['email-payment', 'email-membership', 'email-event']) {
      expect(value(tester, key), isTrue, reason: key);
    }
    // Kategori wajib tidak memiliki saklar (ARCHITECTURE §4.7).
    expect(find.text('Keamanan akun'), findsOneWidget);
    expect(find.text('Akun'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Selalu aktif')), findsWidgets);
    expect(find.byType(SwitchListTile), findsNWidgets(8));
    expect(find.textContaining('Kotak masuk di aplikasi selalu menyimpan seluruh notifikasi'), findsOneWidget);
  });

  testWidgets('F-13: mematikan berita mengirim penggantian penuh preferensi (PUT)', (tester) async {
    final app = await openPreferences(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('pref-push-news')));
    await settle(tester);
    expect(value(tester, 'push-news'), isFalse);
    expectLastBody(app.adapter, '/notifications/preferences', method: 'PUT', {
      'push': {'payment': true, 'membership': true, 'event': true, 'news': false, 'chat': true},
      'email': {'payment': true, 'membership': true, 'event': true},
    });
  });

  testWidgets('penyimpanan gagal mengembalikan saklar dan menampilkan galat', (tester) async {
    await openPreferences(
      tester,
      prefs: (options) => options.method == 'PUT'
          ? FakeResponse.json(503, errorJson('MAINTENANCE', 'Layanan sedang dalam pemeliharaan.'))
          : FakeResponse.json(200, preferencesJson()),
    );
    await scrollAndTap(tester, find.byKey(const ValueKey('pref-email-event')));
    await settle(tester);
    expect(value(tester, 'email-event'), isTrue);
    expect(find.text('Layanan sedang dalam pemeliharaan.'), findsOneWidget);
  });

  testWidgets('AC F13-2: izin push OS ditolak — penjelasan, aplikasi tetap berfungsi dan kotak masuk terbuka', (
    tester,
  ) async {
    final platform = FakePushPlatform()..permission = PushPermission.denied;
    final app = await openPreferences(
      tester,
      platform: platform,
      extra: {
        '/notifications': (_) => FakeResponse.json(200, notificationPageJson([inboxJson(notificationId1)])),
      },
    );
    expect(find.text('Izinkan notifikasi push'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('push-permission-request')));
    await settle(tester);
    await drainPushQueue(tester);
    expect(platform.permissionRequests, 1);
    expect(find.text('Izin notifikasi ditolak'), findsOneWidget);
    expect(find.textContaining('semua notifikasi tersimpan di kotak masuk'), findsOneWidget);
    // Tanpa izin tidak ada token yang didaftarkan.
    expect(app.adapter.requests.where((r) => r.path == '/devices'), isEmpty);

    await scrollAndTap(tester, find.text('Buka kotak masuk'));
    await settle(tester);
    expect(app.location, '/notifications');
    expect(find.text('Pembayaran disetujui'), findsOneWidget);
  });

  testWidgets('AC F13-5: izin diberikan mendaftarkan token perangkat untuk sesi ini (PUT /devices)', (tester) async {
    final platform = FakePushPlatform();
    final app = await openPreferences(tester, platform: platform);
    await tester.tap(find.byKey(const ValueKey('push-permission-request')));
    await settle(tester);
    await drainPushQueue(tester);
    expect(find.text('Notifikasi push aktif'), findsOneWidget);
    final registrations = app.adapter.requests.where((r) => r.path == '/devices' && r.method == 'PUT').toList();
    expect(registrations, hasLength(1));
    expect(bodyOf(registrations.single), {'platform': 'android', 'token': 'fcm-1', 'app_version': '1.2.0'});
  });

  testWidgets('AC F13-2: perangkat tanpa push tetap dapat mengatur preferensi dan memakai kotak masuk', (tester) async {
    await openPreferences(tester, platform: FakePushPlatform()..available = false);
    expect(find.text('Push tidak tersedia di perangkat ini'), findsOneWidget);
    expect(find.byType(SwitchListTile), findsNWidgets(8));
  });

  testWidgets('PRD 4.5: preferensi gagal dimuat menampilkan galat dengan coba lagi', (tester) async {
    var calls = 0;
    await openPreferences(
      tester,
      prefs: (_) {
        calls++;
        return calls == 1 ? FakeResponse.network() : FakeResponse.json(200, preferencesJson(pushChat: false));
      },
    );
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(value(tester, 'push-chat'), isFalse);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openPreferences(tester, textScale: 2);
    expect(tester.takeException(), isNull);
  });
}
