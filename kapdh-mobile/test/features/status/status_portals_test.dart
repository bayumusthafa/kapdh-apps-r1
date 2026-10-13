import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/features/status/deletion_portal.dart';
import 'package:kapdh_mobile/features/status/deletion_status_screen.dart';
import 'package:kapdh_mobile/features/status/restricted_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../account/account_fixtures.dart';

void main() {
  group('Portal pembatasan (suspended, PRD 2.2)', () {
    Future<AppHarness> openRestricted(
      WidgetTester tester, {
      String? reason = 'Akun dibatasi sementara karena laporan pelanggaran.',
      FakeHandler? reports,
      FakeHandler? appeals,
      FakeHandler? me,
      Map<String, FakeHandler> extra = const {},
      double textScale = 1,
    }) => pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      handler: apiRoutes({
        '/me': me ?? (_) => FakeResponse.json(200, meFullJson(status: 'suspended', suspensionMessage: reason)),
        '/reports': reports ?? (_) => FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
        '/appeals': appeals ?? (_) => FakeResponse.json(201, appealJson()),
        ...extra,
      }),
    );

    testWidgets('alasan aman dari server, kontak pengurus, ketentuan komunitas dan hapus akun', (tester) async {
      final app = await openRestricted(tester);
      expect(app.location, '/restricted');
      expect(find.byType(RestrictedScreen), findsOneWidget);
      expect(find.text('Akun Anda sedang dibatasi'), findsOneWidget);
      expect(find.text('Akun dibatasi sementara karena laporan pelanggaran.'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Dibatasi'), findsOneWidget);
      expect(find.text('Ahmad Islam'), findsOneWidget);
      expect(find.text('Hubungi pengurus'), findsOneWidget);

      await scrollAndTap(tester, find.text('Ketentuan komunitas'));
      await settle(tester);
      expect(app.location, '/legal/ketentuan-komunitas');
      app.router.go('/restricted');
      await settle(tester);

      await scrollAndTap(tester, find.byKey(const ValueKey('restricted-delete-account')));
      await settle(tester);
      expect(app.location, '/account/delete');
    });

    testWidgets('tanpa alasan: arahan menghubungi pengurus; KTA dan fitur lain tidak dapat dibuka', (tester) async {
      final app = await openRestricted(tester, reason: null);
      expect(find.textContaining('Hubungi pengurus untuk mengetahui alasan'), findsOneWidget);
      for (final path in ['/kta', '/home', '/notifications', '/payments']) {
        app.router.go(path);
        await settle(tester);
        expect(app.location, '/restricted', reason: path);
      }
    });

    testWidgets('PRD 3.12: banding dikirim dari portal pembatasan dan statusnya tampil', (tester) async {
      final app = await openRestricted(tester);
      expect(find.text('Ajukan banding'), findsOneWidget);
      await scrollTo(tester, find.byKey(const ValueKey('appeal-reason')));
      await tester.enterText(
        find.descendant(of: find.byKey(const ValueKey('appeal-reason')), matching: find.byType(EditableText)),
        '  Saya mohon peninjauan ulang karena laporan itu keliru.  ',
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('appeal-submit')));
      await settle(tester);
      final request = app.adapter.requests.singleWhere((r) => r.path == '/appeals');
      expect(bodyOf(request), {'description': 'Saya mohon peninjauan ulang karena laporan itu keliru.'});
      expect(headerOf(request, 'Idempotency-Key'), isNotNull);
      expect(find.text('Banding sudah diterima'), findsOneWidget);
      expect(find.text('Target tanggapan 14 Okt 2026, 14.00 WIB.'), findsOneWidget);
      expect(find.text('Ajukan banding'), findsNothing);
    });

    testWidgets('PRD 3.12: alasan banding minimal 10 karakter diperiksa sebelum mengirim', (tester) async {
      final app = await openRestricted(tester);
      await scrollTo(tester, find.byKey(const ValueKey('appeal-reason')));
      await tester.enterText(
        find.descendant(of: find.byKey(const ValueKey('appeal-reason')), matching: find.byType(EditableText)),
        'mohon',
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('appeal-submit')));
      await settle(tester);
      expect(find.text('Tuliskan alasan banding minimal 10 karakter.'), findsOneWidget);
      expect(app.adapter.requests.where((r) => r.path == '/appeals'), isEmpty);
    });

    testWidgets('banding aktif: status ditampilkan tanpa formulir banding kedua', (tester) async {
      await openRestricted(
        tester,
        reports: (_) => FakeResponse.json(200, {
          'items': [appealJson(status: 'in_review')],
          'next_cursor': null,
        }),
      );
      expect(find.text('Banding sedang ditinjau'), findsOneWidget);
      expect(find.text('Sedang ditinjau'), findsOneWidget);
      expect(find.text('Ajukan banding'), findsNothing);
    });

    testWidgets('banding ditolak: pesan pengurus tampil dan banding baru boleh diajukan', (tester) async {
      await openRestricted(
        tester,
        reports: (_) => FakeResponse.json(200, {
          'items': [
            appealJson(
              status: 'dismissed',
              outcome: 'no_action',
              decisionMessage: 'Bukti pelanggaran sudah dikonfirmasi.',
              resolvedAt: testNow.subtract(const Duration(hours: 1)),
            ),
          ],
          'next_cursor': null,
        }),
      );
      expect(find.text('Banding ditolak'), findsOneWidget);
      expect(find.text('Pesan pengurus: Bukti pelanggaran sudah dikonfirmasi.'), findsOneWidget);
      expect(find.text('Ajukan banding'), findsOneWidget);
    });

    testWidgets('banding ditolak 403 karena pembatasan sudah dicabut: status dimuat ulang ke Beranda', (tester) async {
      var status = 'suspended';
      final app = await openRestricted(
        tester,
        me: (_) => FakeResponse.json(200, meFullJson(status: status)),
        appeals: (_) {
          status = 'verified';
          return FakeResponse.json(403, errorJson('FORBIDDEN', 'Tidak ada pembatasan yang berlaku.'));
        },
      );
      await scrollTo(tester, find.byKey(const ValueKey('appeal-reason')));
      await tester.enterText(
        find.descendant(of: find.byKey(const ValueKey('appeal-reason')), matching: find.byType(EditableText)),
        'Mohon dibuka kembali, terima kasih.',
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('appeal-submit')));
      await settle(tester);
      expect(app.location, '/home');
    });

    testWidgets('status banding gagal dimuat: peringatan dengan coba lagi', (tester) async {
      var calls = 0;
      await openRestricted(
        tester,
        reports: (_) {
          calls++;
          return calls == 1
              ? FakeResponse.network()
              : FakeResponse.json(200, {
                  'items': [appealJson()],
                  'next_cursor': null,
                });
        },
      );
      expect(find.text('Status banding belum dapat dimuat'), findsOneWidget);
      await scrollAndTap(tester, find.text('Coba lagi'));
      await settle(tester);
      expect(find.text('Banding sudah diterima'), findsOneWidget);
    });

    testWidgets('periksa status: pemulihan oleh pengurus membawa ke Beranda', (tester) async {
      var status = 'suspended';
      final app = await openRestricted(tester, me: (_) => FakeResponse.json(200, meFullJson(status: status)));
      status = 'verified';
      await scrollAndTap(tester, find.text('Periksa status'));
      await settle(tester);
      expect(app.location, '/home');
    });

    testWidgets('keluar: sesi dan data lokal dihapus, kembali ke login', (tester) async {
      final app = await openRestricted(tester, extra: {'/auth/logout': (_) => FakeResponse.json(204)});
      await scrollAndTap(tester, find.text('Keluar'));
      await settle(tester);
      expect(app.location, '/login');
      expect(app.container.read(sessionProvider).phase, SessionPhase.anonymous);
      expect(await app.container.read(tokenStoreProvider).read(), isNull);
      expect(app.adapter.requestsTo('/auth/logout'), hasLength(1));
    });

    testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
      await openRestricted(tester, textScale: 2);
      expect(tester.takeException(), isNull);
      await scrollTo(tester, find.text('Keluar'));
      expect(tester.takeException(), isNull);
    });
  });

  group('Portal status penghapusan tanpa sesi (F-14, PRD 2.2)', () {
    LoginResult pending({String status = 'pending'}) => LoginResult(
      LoginOutcome.deletionPending,
      deletion: AccountDeletion.fromJson(accountDeletionJson(status: status)),
    );

    Future<AppHarness> openPortal(
      WidgetTester tester, {
      LoginResult? login,
      Map<String, FakeHandler> extra = const {},
      Map<String, Object?>? config,
      double textScale = 1,
    }) async {
      final app = await pumpApp(
        tester,
        textScale: textScale,
        handler: apiRoutes({
          '/public/deletion/challenge': (_) => FakeResponse.json(202, otpChallengeJson(purpose: 'deletion')),
          '/public/deletion/verify': (_) =>
              FakeResponse.json(200, verificationJson(deletion: accountDeletionJson(status: 'processing'))),
          ...extra,
        }, config: config),
      );
      if (login != null) {
        app.container.read(deletionPortalProvider.notifier).showLoginResult(login, email: 'ahmad.islam@email.com');
      }
      app.router.go('/deletion-status');
      await settle(tester);
      return app;
    }

    Future<void> requestAndEnterCode(WidgetTester tester, {String code = '123456'}) async {
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-check-send')));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('otp-input')), code);
      await settle(tester);
    }

    testWidgets('AC F14-1: nomor permintaan, status dan batas penyelesaian WIB tampil tanpa sesi', (tester) async {
      final app = await openPortal(tester, login: pending());
      expect(app.location, '/deletion-status');
      expect(find.byType(DeletionStatusScreen), findsOneWidget);
      expect(app.container.read(sessionProvider).hasSession, isFalse);
      expect(find.text('Penghapusan akun sedang diproses'), findsOneWidget);
      expect(find.text('DEL-2026-7K3Q9X'), findsOneWidget);
      expect(find.text('19 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(find.text('Aplikasi'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Permintaan Diterima'), findsOneWidget);
      expect(find.text('Hubungi pengurus'), findsOneWidget);
      expect(find.textContaining('Backup harian berotasi 30 hari'), findsOneWidget);
      // Tidak ada request API anggota.
      expect(app.adapter.requests.where((r) => r.path == '/me'), isEmpty);
    });

    testWidgets('AC F14-2: langkah gagal ditampilkan sebagai sedang diproses ulang', (tester) async {
      await openPortal(tester, login: pending(status: 'failed'));
      expect(find.bySemanticsLabel('Status: Sedang Diproses Ulang'), findsOneWidget);
      expect(find.textContaining('diulang otomatis'), findsOneWidget);
    });

    testWidgets('PRD 2.2: status diperbarui lewat challenge OTP email (POST /public/deletion/challenge, verify)', (
      tester,
    ) async {
      final app = await openPortal(tester, login: pending());
      await requestAndEnterCode(tester);
      expectLastBody(app.adapter, '/public/deletion/challenge', {'email': 'ahmad.islam@email.com'});
      expectLastBody(app.adapter, '/public/deletion/verify', {'challenge_id': 'challenge-1', 'code': '123456'});
      expect(find.bySemanticsLabel('Status: Sedang Diproses'), findsOneWidget);
      expect(find.text('Sedang Diproses'), findsOneWidget);
      // Tetap tanpa sesi: token penghapusan web tidak dipakai dan tidak disimpan.
      expect(app.container.read(sessionProvider).hasSession, isFalse);
      expect(await app.container.read(tokenStoreProvider).read(), isNull);
    });

    testWidgets('PRD 2.5: respons challenge tidak mengungkap apakah email terdaftar', (tester) async {
      await openPortal(tester);
      expect(find.text('Periksa status penghapusan akun'), findsOneWidget);
      await tester.enterText(
        find.descendant(of: find.byKey(const ValueKey('deletion-check-email')), matching: find.byType(EditableText)),
        'siapa@email.com',
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-check-send')));
      await settle(tester);
      expect(
        find.textContaining('Bila email ahmad.islam@email.com terdaftar, kode 6 digit sudah dikirim.'),
        findsOneWidget,
      );
      expect(find.text('Sisa percobaan 5 dari 5'), findsOneWidget);
    });

    testWidgets('kode salah menampilkan sisa percobaan dari server', (tester) async {
      await openPortal(
        tester,
        login: pending(),
        extra: {
          '/public/deletion/verify': (_) => FakeResponse.json(
            400,
            errorJson(
              'VALIDATION_ERROR',
              'Kode salah.',
              fieldErrors: {
                'code': ['Kode salah. Sisa percobaan 3.'],
              },
            ),
          ),
        },
      );
      await requestAndEnterCode(tester, code: '000000');
      expect(find.text('Kode salah. Sisa percobaan 3.'), findsOneWidget);
    });

    testWidgets('410 OTP_EXPIRED: kode tidak berlaku dan penjelasan bila penghapusan sudah selesai', (tester) async {
      await openPortal(
        tester,
        login: pending(),
        extra: {
          '/public/deletion/verify': (_) => FakeResponse.json(410, errorJson('OTP_EXPIRED', 'Kode tidak berlaku.')),
        },
      );
      await requestAndEnterCode(tester);
      expect(find.text('Kode tidak berlaku lagi.'), findsOneWidget);
      expect(find.textContaining('akun tidak lagi terdaftar'), findsOneWidget);
    });

    testWidgets('kirim ulang kode setelah hitung mundur 60 detik (POST /auth/otp/resend)', (tester) async {
      final app = await openPortal(
        tester,
        login: pending(),
        extra: {
          '/auth/otp/resend': (_) => FakeResponse.json(200, otpChallengeJson(id: 'challenge-2', purpose: 'deletion')),
        },
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-check-send')));
      await settle(tester);
      expect(find.text('Kirim ulang dalam 0:42'), findsOneWidget);
      app.clock.advance(const Duration(seconds: 43));
      await tester.pump(const Duration(seconds: 1));
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-check-resend')));
      await settle(tester);
      expectLastBody(app.adapter, '/auth/otp/resend', {'challenge_id': 'challenge-1'});
    });

    testWidgets('akun disabled: kontak bantuan dan pemulihan hanya oleh pengurus', (tester) async {
      await openPortal(tester, login: const LoginResult(LoginOutcome.accountDisabled));
      expect(find.text('Akun tidak aktif'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Nonaktif'), findsOneWidget);
      expect(find.textContaining('hanya dapat dilakukan pengurus'), findsOneWidget);
    });

    testWidgets('verifikasi menunjukkan akun aktif tanpa permintaan penghapusan: ajakan masuk', (tester) async {
      final app = await openPortal(
        tester,
        extra: {
          '/public/deletion/verify': (_) =>
              FakeResponse.json(200, verificationJson(deletable: true, blockedReason: null)),
        },
      );
      await tester.enterText(
        find.descendant(of: find.byKey(const ValueKey('deletion-check-email')), matching: find.byType(EditableText)),
        'ahmad.islam@email.com',
      );
      await requestAndEnterCode(tester);
      expect(find.text('Tidak ada permintaan penghapusan'), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-status-login')));
      await settle(tester);
      expect(app.location, '/login');
    });

    testWidgets('kembali ke halaman masuk menghapus status portal dari memori', (tester) async {
      final app = await openPortal(tester, login: pending());
      await scrollAndTap(tester, find.byKey(const ValueKey('deletion-status-login')));
      await settle(tester);
      expect(app.location, '/login');
      expect(app.container.read(deletionPortalProvider).hasStatus, isFalse);
    });

    testWidgets('sesi baru menghapus status portal akun sebelumnya (N-09)', (tester) async {
      final app = await pumpApp(
        tester,
        handler: apiRoutes({
          '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
          '/me': (_) => FakeResponse.json(200, meFullJson()),
          '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        }),
      );
      app.container.read(deletionPortalProvider.notifier).showLoginResult(pending(), email: 'lama@email.com');
      // Request palsu memakai timer dio: dijalankan bersama pompa frame, bukan di-await langsung.
      final login = app.container.read(sessionProvider.notifier).login(email: 'ahmad.islam@email.com', password: 'x');
      await settle(tester);
      expect((await login).outcome, LoginOutcome.signedIn);
      expect(app.container.read(deletionPortalProvider).hasStatus, isFalse);
    });

    testWidgets('PRD 4.5: saat pemeliharaan portal tetap dapat dibaca tanpa sesi', (tester) async {
      final app = await openPortal(tester, login: pending(), config: publicConfigJson(maintenance: true));
      expect(app.location, '/deletion-status');
      expect(find.text('DEL-2026-7K3Q9X'), findsOneWidget);
    });

    testWidgets('sesi lama berstatus deletion_pending (GET /me) tetap diarahkan ke portal', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'deletion_pending'))}),
      );
      expect(app.location, '/deletion-status');
      expect(find.text('Penghapusan akun sedang diproses'), findsOneWidget);
      app.router.go('/home');
      await settle(tester);
      expect(app.location, '/deletion-status');
    });

    testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
      await openPortal(tester, login: pending(), textScale: 2);
      expect(tester.takeException(), isNull);
      await scrollTo(tester, find.byKey(const ValueKey('deletion-status-login')));
      expect(tester.takeException(), isNull);
    });
  });
}
