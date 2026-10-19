import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/app_services.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/push/push_service.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/core/realtime/realtime_socket.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

/// Soket realtime yang tidak pernah tersambung (uji tanpa jaringan).
class _SilentSocket implements RealtimeSocket {
  @override
  void connect() {}

  @override
  void emit(String event, Object? data) {}

  @override
  void dispose() {}
}

RealtimeSocket _silentSocket({
  required Uri uri,
  required String path,
  required RealtimeAuthProvider auth,
  required RealtimeSocketListener listener,
}) => _SilentSocket();

void main() {
  Future<AppHarness> openAccount(
    WidgetTester tester, {
    String status = 'verified',
    int unread = 0,
    double textScale = 1,
    Map<String, FakeHandler> extra = const {},
  }) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: status, expiresAt: DateTime.utc(2027, 3, 1))),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': unread}),
        ...extra,
      }),
    );
    app.router.go('/account');
    await settle(tester);
    return app;
  }

  testWidgets('F-10 PRD 4.6: kartu ringkasan profil menampilkan nama, email, nomor anggota dan status berlabel', (
    tester,
  ) async {
    final app = await openAccount(tester);
    expect(app.location, '/account');
    expect(find.text('Ahmad Islam'), findsOneWidget);
    expect(find.text('ahmad.islam@contoh.test'), findsOneWidget);
    expect(find.text('No. anggota 29.01.01.7'), findsOneWidget);
    expect(find.text('KAPDH 29 · Pekanbaru'), findsOneWidget);
    expect(find.bySemanticsLabel('Status: KTA Aktif'), findsOneWidget);
    expect(find.text('Berlaku sampai 1 Mar 2027'), findsOneWidget);
    expect(find.text('KAPDH Apps versi 1.2.0 (7)'), findsOneWidget);
  });

  testWidgets('F-13: lencana jumlah notifikasi belum dibaca pada menu Notifikasi', (tester) async {
    await openAccount(tester, unread: 3);
    expect(find.bySemanticsLabel(RegExp(r'^Notifikasi, Kotak masuk resmi, 3 belum dibaca')), findsOneWidget);
  });

  testWidgets('menu membuka sesi perangkat, preferensi, ganti password dan halaman legal', (tester) async {
    final app = await openAccount(
      tester,
      extra: {
        '/auth/sessions': (_) => FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
        '/notifications/preferences': (_) => FakeResponse.json(200, preferencesJson()),
      },
    );
    for (final (label, location) in [
      ('Sesi perangkat', '/account/sessions'),
      ('Preferensi notifikasi', '/account/notifications'),
      ('Ganti password', '/account/password'),
      ('Kebijakan privasi', '/legal/kebijakan-privasi'),
      ('Ketentuan komunitas', '/legal/ketentuan-komunitas'),
    ]) {
      await scrollAndTap(tester, find.bySemanticsLabel(RegExp('^$label')));
      await settle(tester);
      expect(app.location, location, reason: label);
      app.router.go('/account');
      await settle(tester);
    }
  });

  testWidgets('PRD 2.2: menu komunitas terkunci untuk KTA tidak aktif dan menjelaskan cara membukanya', (tester) async {
    final app = await openAccount(tester, status: 'unverified');
    expect(find.bySemanticsLabel('Anggota diblokir, terkunci'), findsOneWidget);
    expect(find.bySemanticsLabel('Tiket saya, terkunci'), findsOneWidget);
    await scrollAndTap(tester, find.bySemanticsLabel('Anggota diblokir, terkunci'));
    await settle(tester);
    expect(find.text('Anggota diblokir terkunci'), findsOneWidget);
    expect(find.text('Bayar iuran'), findsOneWidget);
    expect(app.location, '/account');
  });

  testWidgets('PRD 4.5: saat pemeliharaan, menu khusus perubahan dijelaskan sebagai pemeliharaan, bukan status akun', (
    tester,
  ) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: 'unverified')),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
      }, config: publicConfigJson(maintenance: true, maintenanceUntil: DateTime.utc(2026, 10, 14, 9))),
    );
    app.router.go('/account');
    await settle(tester);
    expect(app.location, '/account');

    // Ganti password dan hapus akun diizinkan status unverified, hanya ditahan mode baca.
    expect(find.bySemanticsLabel('Ganti password, Ditunda selama pemeliharaan'), findsOneWidget);
    expect(find.bySemanticsLabel('Hapus akun, Ditunda selama pemeliharaan'), findsOneWidget);
    // Menu yang memang ditolak status tetap dijelaskan lewat status.
    expect(find.bySemanticsLabel('Anggota diblokir, terkunci'), findsOneWidget);

    await scrollAndTap(tester, find.byKey(const ValueKey('account-menu-/account/password')));
    await settle(tester);
    expect(find.text('Ganti password ditunda sementara'), findsOneWidget);
    expect(find.textContaining('Perkiraan selesai: 14 Okt 2026'), findsOneWidget);
    expect(find.textContaining('Selesaikan iuran'), findsNothing);
    expect(find.text('Bayar iuran'), findsNothing);
    expect(app.location, '/account');

    // Layar pemeliharaan: coba lagi, kanal dukungan, dan tujuan menu dilanjutkan setelah selesai.
    await tester.tap(find.byKey(const ValueKey('account-maintenance-details')));
    await settle(tester);
    expect(app.location, '/maintenance?from=%2Faccount%2Fpassword');
    expect(find.text('Layanan sedang dalam pemeliharaan'), findsOneWidget);
  });

  testWidgets('F-14: menu Hapus akun membuka alur penghapusan', (tester) async {
    final app = await openAccount(
      tester,
      extra: {'/me/deletion/disclosure': (_) => FakeResponse.json(200, disclosureJson())},
    );
    await scrollAndTap(tester, find.byKey(const ValueKey('account-menu-delete')));
    await settle(tester);
    expect(app.location, '/account/delete');
    expect(find.text('Penghapusan akun bersifat permanen'), findsOneWidget);
  });

  testWidgets('AC F13-5: keluar mencabut sesi di server, menghapus token lokal dan token FCM perangkat', (
    tester,
  ) async {
    final platform = FakePushPlatform();
    final store = MemorySecureStore();
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      store: store,
      overrides: [
        pushPlatformProvider.overrideWithValue(platform),
        connectivityOnlineProvider.overrideWith((ref) => const Stream<bool>.empty()),
        realtimeClientProvider.overrideWith(
          (ref) => RealtimeClient(
            config: ref.watch(apiConfigProvider),
            coordinator: ref.watch(refreshCoordinatorProvider),
            socketFactory: _silentSocket,
          ),
        ),
      ],
      // Sama dengan KapdhApp(enableSessionServices: true): layanan sesi didengarkan selama aplikasi hidup.
      beforeStart: (container) async => container.listen(sessionServicesProvider, (_, _) {}),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/devices': (_) => FakeResponse.json(204),
        '/auth/logout': (_) => FakeResponse.json(204),
      }),
    );
    await drainPushQueue(tester);
    // Masuk: izin push diminta lalu token perangkat didaftarkan untuk akun ini.
    expect(platform.permissionRequests, 1);
    expect(countRequests(app.adapter, '/devices', method: 'PUT'), 1);
    expect(await PushRegistrationStore(store).read(), isNotNull);

    app.router.go('/account');
    await settle(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('account-logout')));
    await settle(tester);
    await drainPushQueue(tester);

    expect(app.location, '/login');
    expect(app.container.read(sessionProvider).phase, SessionPhase.anonymous);
    expect(countRequests(app.adapter, '/auth/logout', method: 'POST'), 1);
    expect(await app.container.read(tokenStoreProvider).read(), isNull);
    // Token FCM dihapus sehingga perangkat tidak lagi menerima notifikasi akun ini.
    expect(platform.deletes, 1);
    expect(await PushRegistrationStore(store).read(), isNull);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openAccount(tester, textScale: 2);
    expect(tester.takeException(), isNull);
    await scrollTo(tester, find.byKey(const ValueKey('account-logout')));
    expect(tester.takeException(), isNull);
  });
}
