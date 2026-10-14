import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

void main() {
  Future<AppHarness> openPrivacy(
    WidgetTester tester, {
    String status = 'verified',
    Map<String, Object?>? me,
    FakeHandler? patch,
    double textScale = 1,
  }) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, me ?? meFullJson(status: status)),
        '/me/profile': patch ?? (_) => FakeResponse.json(200, meFullJson(version: '4', showPhone: true)),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
      }),
    );
    app.router.go('/account');
    await settle(tester);
    app.router.push('/account/privacy');
    await settle(tester);
    return app;
  }

  bool switchValue(WidgetTester tester, String key) =>
      tester.widget<SwitchListTile>(find.byKey(ValueKey('privacy-$key'))).value;

  testWidgets('N-15 AC F10-2: bawaan melindungi kontak; penjelasan setiap saklar', (tester) async {
    await openPrivacy(tester);
    expect(find.text('Privasi Profil'), findsOneWidget);
    expect(switchValue(tester, 'directory'), isTrue);
    expect(switchValue(tester, 'phone'), isFalse);
    expect(switchValue(tester, 'email'), isFalse);
    expect(switchValue(tester, 'social'), isFalse);
    expect(find.textContaining('tidak dikirim ke perangkat anggota lain'), findsOneWidget);
    expect(find.textContaining('Anda belum mengisi nomor telepon.'), findsOneWidget);
    expect(find.text('Bawaan: semua tersembunyi untuk melindungi kontak Anda.'), findsOneWidget);
  });

  testWidgets('AC F15-4: saklar disimpan lewat PATCH privasi dengan If-Match lalu memakai versi baru', (tester) async {
    var version = 3;
    final app = await openPrivacy(
      tester,
      patch: (options) {
        version++;
        final privacy = bodyOf(options)['privacy']! as Map;
        return FakeResponse.json(
          200,
          meFullJson(
            version: '$version',
            showPhone: privacy['show_phone'] == true,
            showInDirectory: privacy['show_in_directory'] != false,
          ),
        );
      },
    );
    await tester.tap(find.byKey(const ValueKey('privacy-phone')));
    await settle(tester);
    expect(switchValue(tester, 'phone'), isTrue);
    await scrollAndTap(tester, find.byKey(const ValueKey('privacy-directory')));
    await settle(tester);

    final patches = app.adapter.requests.where((r) => r.path == '/me/profile' && r.method == 'PATCH').toList();
    expect(patches, hasLength(2));
    expect(bodyOf(patches[0]), {
      'privacy': {'show_phone': true},
    });
    expect(headerOf(patches[0], 'If-Match'), '3');
    expect(bodyOf(patches[1]), {
      'privacy': {'show_in_directory': false},
    });
    expect(headerOf(patches[1], 'If-Match'), '4');
  });

  testWidgets('galat jaringan: saklar tetap pada nilai server dan galat ditampilkan', (tester) async {
    await openPrivacy(tester, patch: (_) => FakeResponse.network());
    await tester.tap(find.byKey(const ValueKey('privacy-email')));
    await settle(tester);
    expect(switchValue(tester, 'email'), isFalse);
    expect(find.text('Tidak dapat terhubung. Periksa koneksi internet lalu coba lagi.'), findsOneWidget);
  });

  testWidgets('AC F15-4: konflik versi menampilkan pengaturan terbaru dari server', (tester) async {
    await openPrivacy(
      tester,
      patch: (_) => FakeResponse.json(
        409,
        errorJson('VERSION_CONFLICT', 'Data sudah diubah.', current: meFullJson(version: '9', showSocial: true)),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('privacy-phone')));
    await settle(tester);
    expect(find.textContaining('Pengaturan terbaru ditampilkan'), findsOneWidget);
    expect(switchValue(tester, 'social'), isTrue);
    expect(switchValue(tester, 'phone'), isFalse);
  });

  testWidgets('PRD 2.2: KTA belum aktif diberi tahu bahwa profil belum tampil di direktori', (tester) async {
    await openPrivacy(tester, status: 'unverified');
    expect(find.textContaining('Direktori hanya menampilkan anggota dengan KTA aktif'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openPrivacy(tester, textScale: 2);
    expect(tester.takeException(), isNull);
  });
}
