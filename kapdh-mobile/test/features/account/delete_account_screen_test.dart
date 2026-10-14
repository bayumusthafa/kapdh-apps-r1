import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/features/status/deletion_portal.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

void main() {
  Future<AppHarness> openDelete(
    WidgetTester tester, {
    String status = 'verified',
    FakeHandler? disclosure,
    FakeHandler? request,
    FakeHandler? reauth,
    double textScale = 1,
  }) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: status)),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/me/deletion/disclosure': disclosure ?? (_) => FakeResponse.json(200, disclosureJson()),
        '/auth/reauth':
            reauth ??
            (_) => FakeResponse.json(200, {
              'reauth_token': 'reauth-1',
              'expires_at': iso(testNow.add(const Duration(minutes: 10))),
            }),
        '/me/deletion': request ?? (_) => FakeResponse.json(202, accountDeletionJson()),
        // Sesi sudah dicabut server setelah permintaan: logout dan refresh ditolak.
        '/auth/logout': (_) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.')),
        '/auth/refresh': (_) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.')),
      }),
    );
    app.router.push('/account/delete');
    await settle(tester);
    return app;
  }

  Future<void> confirmAll(WidgetTester tester) async {
    await scrollAndTap(tester, find.byKey(const ValueKey('deletion-confirm-data')));
    await tester.pump();
    if (find.byKey(const ValueKey('deletion-confirm-warnings')).evaluate().isNotEmpty) {
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-confirm-warnings')));
      await tester.pump();
    }
  }

  Future<void> submitWithPassword(WidgetTester tester, {String password = 'Rahasia#2026'}) async {
    await scrollAndTap(tester, find.byKey(const ValueKey('deletion-submit')));
    await settle(tester);
    expect(find.text('Konfirmasi identitas'), findsOneWidget);
    await tester.enterText(
      find.descendant(of: find.byType(AlertDialog), matching: find.byType(EditableText)),
      password,
    );
    await tester.pump();
    await tester.tap(find.text('Konfirmasi'));
    await settle(tester);
  }

  testWidgets('N-15 D2: retensi dijelaskan sebelum persetujuan (data dihapus, anonim, 7 hari, backup 30 hari)', (
    tester,
  ) async {
    await openDelete(tester);
    expect(find.text('Hapus Akun'), findsOneWidget);
    expect(find.text('Profil, foto dan kontak Anda.'), findsOneWidget);
    expect(find.text('Catatan pembayaran anonim (jumlah, tanggal, status).'), findsOneWidget);
    expect(find.textContaining('paling lambat 7 hari kalender'), findsOneWidget);
    expect(find.textContaining('Backup harian berotasi 30 hari'), findsOneWidget);
    expect(find.text('Baca kebijakan privasi (versi 2)'), findsOneWidget);
  });

  testWidgets('F-14: konfirmasi eksplisit wajib sebelum reautentikasi', (tester) async {
    final app = await openDelete(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('deletion-submit')));
    await settle(tester);
    expect(find.text('Konfirmasi identitas'), findsNothing);
    expect(app.adapter.requests.where((r) => r.path == '/auth/reauth'), isEmpty);
  });

  testWidgets('AC F14-1: reautentikasi lalu permintaan dibuat; nomor permintaan tampil dan data lokal dihapus', (
    tester,
  ) async {
    final app = await openDelete(tester);
    await confirmAll(tester);
    await submitWithPassword(tester);

    expectLastBody(app.adapter, '/auth/reauth', {'password': 'Rahasia#2026'});
    final requests = app.adapter.requests.where((r) => r.path == '/me/deletion' && r.method == 'POST').toList();
    expect(requests, hasLength(1));
    expect(headerOf(requests.single, 'X-Reauth-Token'), 'reauth-1');
    expect(headerOf(requests.single, 'Idempotency-Key'), isNotNull);
    expect(bodyOf(requests.single), {'confirm': true, 'acknowledged_disclosure_version': 'disc-v1'});

    expect(app.location, '/deletion-status');
    expect(find.text('Penghapusan akun sedang diproses'), findsOneWidget);
    expect(find.byKey(const ValueKey('deletion-just-requested')), findsOneWidget);
    expect(find.text('DEL-2026-7K3Q9X'), findsOneWidget);
    expect(find.text('19 Okt 2026, 14.00 WIB'), findsOneWidget);
    expect(app.container.read(sessionProvider).hasSession, isFalse);
    expect(await app.container.read(tokenStoreProvider).read(), isNull);
    expect(app.container.read(deletionPortalProvider).deletion?.requestNumber, 'DEL-2026-7K3Q9X');
  });

  testWidgets('F-14: reautentikasi dibatalkan tidak membuat permintaan', (tester) async {
    final app = await openDelete(tester);
    await confirmAll(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('deletion-submit')));
    await settle(tester);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(app.adapter.requests.where((r) => r.path == '/me/deletion'), isEmpty);
    expect(app.location, '/account/delete');
  });

  testWidgets('F-14: password reautentikasi salah ditampilkan di dialog', (tester) async {
    final app = await openDelete(
      tester,
      reauth: (_) => FakeResponse.json(
        400,
        errorJson(
          'VALIDATION_ERROR',
          'Periksa kembali isian.',
          fieldErrors: {
            'password': ['Password salah.'],
          },
        ),
      ),
    );
    await confirmAll(tester);
    await submitWithPassword(tester, password: 'salah');
    expect(find.text('Password salah.'), findsOneWidget);
    expect(app.adapter.requests.where((r) => r.path == '/me/deletion'), isEmpty);
  });

  testWidgets('PRD 3.9 D6 PRD 4.4: peringatan tiket aktif, refund belum ditransfer, pembayaran terbuka dan grup', (
    tester,
  ) async {
    await openDelete(
      tester,
      disclosure: (_) => FakeResponse.json(
        200,
        disclosureJson(
          tickets: [ticketWarningJson()],
          refunds: [refundWarningJson()],
          payments: [paymentWarningJson()],
          soleAdminGroups: 2,
          linkedAdmin: true,
        ),
      ),
    );
    expect(find.text('Tiket aktif: Reuni Akbar 2026'), findsOneWidget);
    expect(find.text('Rp75.000'), findsOneWidget);
    expect(
      find.textContaining('Batalkan tiket paling lambat 29 Okt 2026, 09.00 WIB untuk refund penuh'),
      findsOneWidget,
    );
    expect(find.text('Refund belum ditransfer'), findsOneWidget);
    expect(find.text('Kajian Akhir Tahun'), findsOneWidget);
    expect(find.textContaining('data rekening tujuan ikut dihapus'), findsOneWidget);
    expect(find.text('Pembayaran belum selesai: Iuran perpanjangan'), findsOneWidget);
    expect(find.textContaining('dana mungkin sudah terkirim'), findsOneWidget);
    expect(find.textContaining('admin tunggal di 2 grup chat'), findsOneWidget);
    expect(find.textContaining('terhubung dengan akun pengurus'), findsOneWidget);
    // Peringatan wajib dikonfirmasi tersendiri.
    expect(find.byKey(const ValueKey('deletion-confirm-warnings')), findsOneWidget);
  });

  testWidgets('kebijakan refund: event dibatalkan, tanpa refund, kasus per kasus, pembayaran belum selesai', (
    tester,
  ) async {
    await openDelete(
      tester,
      disclosure: (_) => FakeResponse.json(
        200,
        disclosureJson(
          tickets: [
            {...ticketWarningJson(cancelled: true), 'ticket_id': 'tk-a'},
            {...ticketWarningJson(policy: 'no_refund'), 'ticket_id': 'tk-b'},
            {...ticketWarningJson(policy: 'case_by_case'), 'ticket_id': 'tk-c'},
            {...ticketWarningJson(policy: 'payment_pending'), 'ticket_id': 'tk-d', 'status': 'awaiting_review'},
          ],
        ),
      ),
    );
    expect(find.textContaining('Event dibatalkan pengurus sehingga Anda berhak refund penuh'), findsOneWidget);
    expect(find.textContaining('Tiket hangus tanpa refund'), findsOneWidget);
    expect(find.textContaining('refund diputuskan pengurus per kasus'), findsOneWidget);
    expect(find.textContaining('Pembayaran tiket belum selesai dan akan dibatalkan'), findsOneWidget);
    expect(find.text('Menunggu verifikasi'), findsOneWidget);
  });

  testWidgets('409 VERSION_CONFLICT: pengungkapan terbaru ditampilkan dan konfirmasi diulang', (tester) async {
    var calls = 0;
    final app = await openDelete(
      tester,
      request: (_) {
        calls++;
        if (calls == 1) {
          return FakeResponse.json(
            409,
            errorJson(
              'VERSION_CONFLICT',
              'Pengungkapan berubah.',
              current: disclosureJson(version: 'disc-v2', tickets: [ticketWarningJson()]),
            ),
          );
        }
        return FakeResponse.json(202, accountDeletionJson());
      },
    );
    await confirmAll(tester);
    await submitWithPassword(tester);
    expect(find.byKey(const ValueKey('deletion-disclosure-changed')), findsOneWidget);
    expect(find.text('Tiket aktif: Reuni Akbar 2026'), findsOneWidget);
    expect(app.location, '/account/delete');

    // Konfirmasi ulang memakai versi baru dan token reautentikasi yang masih berlaku (tanpa dialog kedua).
    await confirmAll(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('deletion-submit')));
    await settle(tester);
    final requests = app.adapter.requests.where((r) => r.path == '/me/deletion').toList();
    expect(requests, hasLength(2));
    expect(bodyOf(requests.last)['acknowledged_disclosure_version'], 'disc-v2');
    expect(countRequests(app.adapter, '/auth/reauth', method: 'POST'), 1);
    expect(app.location, '/deletion-status');
  });

  testWidgets('PRD 4.3: jaringan putus memakai Idempotency-Key yang sama saat diulang', (tester) async {
    var calls = 0;
    final app = await openDelete(
      tester,
      request: (_) {
        calls++;
        return calls == 1 ? FakeResponse.network() : FakeResponse.json(202, accountDeletionJson());
      },
    );
    await confirmAll(tester);
    await submitWithPassword(tester);
    expect(find.text('Tidak dapat terhubung. Periksa koneksi internet lalu coba lagi.'), findsOneWidget);
    tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger).first).clearSnackBars();
    await settle(tester);
    await scrollAndTap(tester, find.byKey(const ValueKey('deletion-submit')));
    await settle(tester);
    final requests = app.adapter.requests.where((r) => r.path == '/me/deletion').toList();
    expect(requests, hasLength(2));
    expect(headerOf(requests.first, 'Idempotency-Key'), headerOf(requests.last, 'Idempotency-Key'));
    expect(app.location, '/deletion-status');
  });

  testWidgets('PRD 2.2 F-14: anggota suspended dapat membuka alur hapus akun dari portal pembatasan', (tester) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson(status: 'suspended')),
        '/reports': (_) => FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
        '/me/deletion/disclosure': (_) => FakeResponse.json(200, disclosureJson()),
      }),
    );
    expect(app.location, '/restricted');
    await scrollAndTap(tester, find.byKey(const ValueKey('restricted-delete-account')));
    await settle(tester);
    expect(app.location, '/account/delete');
    expect(find.text('Penghapusan akun bersifat permanen'), findsOneWidget);
  });

  testWidgets('PRD 4.5: pengungkapan gagal dimuat menampilkan galat dengan coba lagi', (tester) async {
    var calls = 0;
    await openDelete(
      tester,
      disclosure: (_) {
        calls++;
        return calls == 1 ? FakeResponse.network() : FakeResponse.json(200, disclosureJson());
      },
    );
    expect(find.text('Tidak ada koneksi'), findsOneWidget);
    await tester.tap(find.text('Coba lagi'));
    await settle(tester);
    expect(find.text('Penghapusan akun bersifat permanen'), findsOneWidget);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openDelete(
      tester,
      textScale: 2,
      disclosure: (_) => FakeResponse.json(200, disclosureJson(tickets: [ticketWarningJson()])),
    );
    expect(tester.takeException(), isNull);
    await scrollTo(tester, find.byKey(const ValueKey('deletion-submit')));
    expect(tester.takeException(), isNull);
  });
}
