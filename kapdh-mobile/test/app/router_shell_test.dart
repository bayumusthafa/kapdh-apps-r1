import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/app_services.dart';
import 'package:kapdh_mobile/app/app_shell.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/system/not_found_screen.dart';

import '../support/app_harness.dart';
import '../support/fakes.dart';

/// Semua rute ARCHITECTURE §8.4 di luar sistem/auth/portal, dengan judul layar yang diharapkan.
const memberRoutes = {
  '/onboarding/fees': 'Biaya KTA',
  '/payments': 'Riwayat Pembayaran',
  '/payments/new/registration': 'Pembayaran',
  '/payments/pay-1': 'Status Pembayaran',
  '/home': 'Beranda',
  '/events': 'Event',
  '/kta': 'Kartu Tanda Anggota',
  '/network': 'Jejaring',
  '/account': 'Akun',
  '/news': 'Berita',
  '/news/silaturahmi': 'Detail Berita',
  '/events/ev-1': 'Detail Event',
  '/tickets': 'Tiket Saya',
  '/tickets/tk-1': 'Detail Tiket',
  '/renewal': 'Perpanjang KTA',
  '/network/members/user-2': 'Profil Alumni',
  '/chat/room-1': 'Percakapan',
  '/chat/room-1/info': 'Info Percakapan',
  '/chat/new-group': 'Grup Baru',
  '/chat/invitations': 'Undangan Grup',
  '/notifications': 'Notifikasi',
  '/account/profile': 'Profil',
  '/account/privacy': 'Privasi',
  '/account/notifications': 'Preferensi Notifikasi',
  '/account/sessions': 'Sesi Perangkat',
  '/account/password': 'Ganti Password',
  '/account/blocked': 'Pengguna Diblokir',
  '/account/reports': 'Laporan Saya',
  '/account/delete': 'Hapus Akun',
  '/legal/ketentuan': 'Informasi',
};

void main() {
  testWidgets('setiap rute ARCHITECTURE §8.4 terdaftar dan memakai layar yang benar', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}),
    );
    for (final MapEntry(key: path, value: title) in memberRoutes.entries) {
      if (path == '/onboarding/fees') continue; // khusus unverified, diuji terpisah
      app.router.go(path);
      await settle(tester);
      expect(app.location, path, reason: path);
      expect(find.byType(NotFoundScreen), findsNothing, reason: path);
      expect(find.text(title), findsWidgets, reason: path);
    }
  });

  testWidgets('rute sistem, auth dan portal terdaftar', (tester) async {
    final app = await pumpApp(tester, handler: apiRoutes({}));
    for (final path in ['/register', '/forgot', '/legal/bantuan']) {
      app.router.go(path);
      await settle(tester);
      expect(app.location, path);
      expect(find.byType(NotFoundScreen), findsNothing, reason: path);
    }
  });

  testWidgets('unverified: rute onboarding terbuka dan rute status awal Biaya KTA', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'unverified'))}),
    );
    expect(app.location, '/onboarding/fees');
    expect(find.text('Biaya KTA'), findsWidgets);
  });

  testWidgets('shell: lima tab berlabel Indonesia, pindah tab mempertahankan cangkang', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}),
    );
    expect(find.byType(AppShell), findsOneWidget);
    final nav = find.byType(NavigationBar);
    for (final label in ['Beranda', 'Event', 'KTA', 'Jejaring', 'Akun']) {
      expect(find.descendant(of: nav, matching: find.text(label)), findsOneWidget);
    }
    await tester.tap(find.descendant(of: nav, matching: find.text('Jejaring')));
    await settle(tester);
    expect(app.location, '/network');
    await tester.tap(find.descendant(of: nav, matching: find.text('KTA')));
    await settle(tester);
    expect(app.location, '/kta');
    expect(tester.getSize(nav).height, greaterThanOrEqualTo(48));
  });

  testWidgets('unverified: tab Event dan Jejaring terkunci dengan ajakan bayar iuran (PRD 2.2)', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'unverified'))}),
    );
    app.router.go('/home');
    await settle(tester);
    final nav = find.byType(NavigationBar);
    expect(find.byTooltip('Event, terkunci'), findsOneWidget);
    expect(find.byTooltip('Jejaring, terkunci'), findsOneWidget);
    expect(find.byTooltip('KTA'), findsOneWidget);

    await tester.tap(find.descendant(of: nav, matching: find.text('Event')));
    await settle(tester);
    expect(find.text('Event terkunci'), findsOneWidget);
    expect(app.location, '/home');
    await tester.tap(find.text('Bayar iuran'));
    await settle(tester);
    expect(app.location, '/onboarding/fees');
  });

  testWidgets('expired: tab terkunci menawarkan perpanjangan', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'expired'))}),
    );
    app.router.go('/home');
    await settle(tester);
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text('Jejaring')));
    await settle(tester);
    expect(find.text('Perpanjang KTA'), findsOneWidget);
  });

  testWidgets('Akun: keluar dari aplikasi tersedia', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meJson()),
        '/auth/logout': (_) => FakeResponse.json(204),
      }),
    );
    app.router.go('/account');
    await settle(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('account-logout')));
    await settle(tester);
    expect(app.location, '/login');
    expect(find.byType(KapdhButton), findsWidgets);
  });

  test('push dan realtime hanya untuk sesi aktif yang sesuai status', () {
    SessionState authed(String status) => SessionState.authenticated(meOf(status: status), syncedAt: testNow);
    expect(shouldConnectRealtime(authed('verified')), isTrue);
    expect(shouldConnectRealtime(authed('expired')), isTrue);
    expect(shouldConnectRealtime(authed('suspended')), isFalse);
    expect(shouldConnectRealtime(SessionState.offlineLastKnown(meOf(), syncedAt: testNow)), isFalse);
    expect(shouldConnectRealtime(const SessionState.anonymous()), isFalse);
    expect(shouldRegisterPush(authed('suspended')), isTrue);
    expect(shouldRegisterPush(authed('deletion_pending')), isFalse);
    expect(shouldRegisterPush(authed('pending_otp')), isFalse);
  });
}
