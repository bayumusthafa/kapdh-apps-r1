import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

void main() {
  Future<AppHarness> openSessions(
    WidgetTester tester, {
    FakeHandler? list,
    Map<String, FakeHandler> extra = const {},
    double textScale = 1,
  }) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/auth/sessions':
            list ??
            (_) => FakeResponse.json(200, {
              'items': [
                sessionJson('fam-2', deviceName: 'iPhone 13', platform: 'ios', appVersion: '1.1.0'),
                sessionJson('fam-1', current: true),
              ],
              'next_cursor': null,
            }),
        ...extra,
      }),
    );
    app.router.go('/account');
    await settle(tester);
    app.router.push('/account/sessions');
    await settle(tester);
    return app;
  }

  testWidgets('F-02: perangkat ini di atas, perangkat lain dengan platform, versi dan aktivitas terakhir', (
    tester,
  ) async {
    await openSessions(tester);
    expect(find.text('PERANGKAT INI'), findsOneWidget);
    expect(find.text('Samsung A54'), findsOneWidget);
    expect(find.text('Aktif sekarang'), findsOneWidget);
    expect(find.text('iPhone 13'), findsOneWidget);
    expect(find.text('iOS · versi 1.1.0'), findsOneWidget);
    expect(find.text('Terakhir aktif 2 jam lalu'), findsOneWidget);
    // Urutan: perangkat ini lebih dulu walau server mengurutkan menurut created_at.
    expect(tester.getTopLeft(find.text('Samsung A54')).dy, lessThan(tester.getTopLeft(find.text('iPhone 13')).dy));
  });

  testWidgets('F-02: cabut perangkat lain setelah konfirmasi (DELETE /auth/sessions/{id})', (tester) async {
    final app = await openSessions(tester, extra: {'/auth/sessions/fam-2': (_) => FakeResponse.json(204)});
    await tester.tap(find.byKey(const ValueKey('session-revoke-fam-2')));
    await settle(tester);
    expect(find.text('Keluarkan perangkat?'), findsOneWidget);
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Keluarkan')));
    await settle(tester);
    expect(countRequests(app.adapter, '/auth/sessions/fam-2', method: 'DELETE'), 1);
    expect(find.text('iPhone 13'), findsNothing);
    expect(find.text('iPhone 13 sudah dikeluarkan.'), findsOneWidget);
  });

  testWidgets('batal konfirmasi tidak mencabut sesi', (tester) async {
    final app = await openSessions(tester);
    await tester.tap(find.byKey(const ValueKey('session-revoke-fam-2')));
    await settle(tester);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(app.adapter.requests.where((r) => r.method == 'DELETE'), isEmpty);
    expect(find.text('iPhone 13'), findsOneWidget);
  });

  testWidgets('sesi yang sudah dicabut (404) dihapus dari daftar tanpa galat', (tester) async {
    await openSessions(
      tester,
      extra: {'/auth/sessions/fam-2': (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan.'))},
    );
    await tester.tap(find.byKey(const ValueKey('session-revoke-fam-2')));
    await settle(tester);
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Keluarkan')));
    await settle(tester);
    expect(find.text('iPhone 13'), findsNothing);
    expect(find.text('Sesi perangkat itu sudah tidak berlaku.'), findsOneWidget);
  });

  testWidgets('AC F02-6: keluar dari semua perangkat mencabut seluruh sesi lalu kembali ke login', (tester) async {
    final app = await openSessions(tester, extra: {'/auth/logout-all': (_) => FakeResponse.json(204)});
    await scrollAndTap(tester, find.byKey(const ValueKey('sessions-logout-all')));
    await settle(tester);
    expect(find.text('Keluar dari semua perangkat?'), findsOneWidget);
    await tester.tap(find.text('Keluar semua'));
    await settle(tester);
    expect(countRequests(app.adapter, '/auth/logout-all', method: 'POST'), 1);
    expect(app.location, '/login');
    expect(app.container.read(sessionProvider).hasSession, isFalse);
    expect(await app.container.read(tokenStoreProvider).read(), isNull);
  });

  testWidgets('AC F02-6: keluar semua gagal (offline) tidak mengubah sesi lokal dan memberi tahu', (tester) async {
    final app = await openSessions(tester, extra: {'/auth/logout-all': (_) => FakeResponse.network()});
    await scrollAndTap(tester, find.byKey(const ValueKey('sessions-logout-all')));
    await settle(tester);
    await tester.tap(find.text('Keluar semua'));
    await settle(tester);
    expect(app.location, '/account/sessions');
    expect(app.container.read(sessionProvider).hasSession, isTrue);
    expect(find.text('Tidak dapat terhubung. Periksa koneksi internet lalu coba lagi.'), findsOneWidget);
  });

  testWidgets('keluar dari perangkat ini lewat baris perangkat sendiri', (tester) async {
    final app = await openSessions(tester, extra: {'/auth/logout': (_) => FakeResponse.json(204)});
    await tester.tap(find.byKey(const ValueKey('session-revoke-fam-1')));
    await settle(tester);
    expect(find.text('Keluar dari perangkat ini?'), findsOneWidget);
    await tester.tap(find.text('Keluar').last);
    await settle(tester);
    expect(countRequests(app.adapter, '/auth/logout', method: 'POST'), 1);
    expect(app.location, '/login');
  });

  testWidgets('paging: perangkat berikutnya dimuat dengan cursor', (tester) async {
    final app = await openSessions(
      tester,
      list: (options) {
        if (options.queryParameters['cursor'] == 'c-2') {
          return FakeResponse.json(200, {
            'items': [sessionJson('fam-3', deviceName: 'Tablet Lama')],
            'next_cursor': null,
          });
        }
        return FakeResponse.json(200, {
          'items': [sessionJson('fam-1', current: true)],
          'next_cursor': 'c-2',
        });
      },
    );
    expect(find.text('Tidak ada perangkat lain yang masuk ke akun Anda.'), findsOneWidget);
    await scrollAndTap(tester, find.text('Muat perangkat lain'));
    await settle(tester);
    expect(find.text('Tablet Lama'), findsOneWidget);
    expect(app.adapter.requests.where((r) => r.queryParameters['cursor'] == 'c-2'), hasLength(1));
  });

  testWidgets('PRD 4.5: galat memuat daftar dengan coba lagi', (tester) async {
    var calls = 0;
    await openSessions(
      tester,
      list: (_) {
        calls++;
        return calls == 1
            ? FakeResponse.json(500, errorJson('INTERNAL_ERROR', 'Terjadi kesalahan. Coba lagi.'))
            : FakeResponse.json(200, {
                'items': [sessionJson('fam-1', current: true)],
                'next_cursor': null,
              });
      },
    );
    expect(find.text('Terjadi kesalahan'), findsOneWidget);
    expect(find.text('Kode bantuan: req-uji-1'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Samsung A54'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openSessions(tester, textScale: 2);
    expect(tester.takeException(), isNull);
  });
}
