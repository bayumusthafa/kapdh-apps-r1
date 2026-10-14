import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/idempotency_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/notifications/notification_unread_count.dart';
import 'package:kapdh_mobile/features/notifications/notifications_repository.dart';
import 'package:kapdh_mobile/features/payments/payment_presentation.dart';
import 'package:kapdh_mobile/features/payments/proof_file.dart';
import 'package:kapdh_mobile/features/payments/widgets/proof_preview.dart';
import 'package:kapdh_mobile/features/payments/widgets/proof_upload_section.dart';

import '../../support/a11y.dart';
import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'payments_fixtures.dart';

Future<AppHarness> openPayment(
  WidgetTester tester,
  Map<String, FakeHandler> routes, {
  String status = 'unverified',
  Map<String, Object?>? me,
  FakeProofPicker? picker,
  double textScale = 1,
  bool tall = true,
  bool settleAfter = true,
  Stream<NotificationCreatedPayload>? updates,
  MemorySecureStore? store,
  List<Override> overrides = const [],
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    store: store,
    textScale: textScale,
    overrides: [
      proofPickerProvider.overrideWithValue(picker ?? FakeProofPicker()),
      notificationCreatedEventsProvider.overrideWithValue(updates ?? const Stream.empty()),
      ...overrides,
    ],
    handler: apiRoutes({
      '/me': (_) => FakeResponse.json(200, me ?? meJson(status: status)),
      '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      '/me/membership': (_) => FakeResponse.json(200, membershipJson(status: status)),
      '/payment-methods': (_) => FakeResponse.json(200, methodsJson()),
      ...routes,
    }),
  );
  if (tall) await useTallScreen(tester);
  app.router.go('/payments/pay-1');
  if (settleAfter) {
    await settle(tester);
  } else {
    // Kerangka pemuatan beranimasi sehingga tidak pernah "tenang"; cukup beberapa frame.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }
  return app;
}

Finder get submitButton => find.byKey(const ValueKey('proof-submit'));

Future<void> pickFromGallery(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('proof-upload-tile')));
  await settle(tester);
  await tester.tap(find.text('Pilih dari galeri'));
  await settle(tester);
}

Future<void> submit(WidgetTester tester) async {
  await tester.tap(submitButton);
  await settle(tester);
}

void main() {
  group('Instruksi bayar dan unggah bukti (prototipe layar 3)', () {
    testWidgets('AC F03-1: nominal server, rekening tujuan terpilih dengan salin, rekening lain dan langkah '
        'Pembayaran', (tester) async {
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
      });
      final copied = captureClipboard(tester);

      expect(app.location, '/payments/pay-1');
      expect(find.text('Pembayaran'), findsWidgets);
      expect(find.bySemanticsLabel('Langkah 4 dari 4: Pembayaran'), findsOneWidget);
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);
      expect(find.text('Rp60.000'), findsOneWidget);
      expect(find.text('Rekening tujuan'), findsOneWidget);
      expect(find.text('BSI'), findsOneWidget);
      expect(find.text('7123456789'), findsOneWidget);
      expect(find.text('a.n. KAPDH Pusat'), findsOneWidget);
      expect(find.text('DANA'), findsOneWidget);
      expect(find.text('081234567890'), findsNothing);
      expect(find.text('Ketuk untuk melihat nomor tujuan'), findsOneWidget);
      expect(find.text('Bukti transfer'), findsOneWidget);
      expect(find.text(proofRulesCaption), findsOneWidget);
      expect(tester.widget<KapdhButton>(submitButton).onPressed, isNull);
      expect(find.text('Batalkan instruksi'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel('Salin nomor rekening BSI'));
      await settle(tester);
      await tester.tap(find.bySemanticsLabel('Salin nominal Rp60.000'));
      await settle(tester);
      expect(copied, ['7123456789', '60000']);
    });

    testWidgets('PRD 4.3: ganti rekening tujuan sebelum bukti pertama dengan If-Match versi terbaru', (tester) async {
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
        '/me/payments/pay-1/method': (_) =>
            FakeResponse.json(200, paymentJson(method: methodDana, version: '2', events: null)),
      });

      await tester.tap(find.text('DANA'));
      await settle(tester);

      final put = app.adapter.requestsTo('/me/payments/pay-1/method').single;
      expect(put.method, 'PUT');
      expect(put.headers['If-Match'], '1');
      expect(bodyOf(put), {'payment_method_id': 'method-2'});
      expect(find.text('081234567890'), findsOneWidget);
      expect(find.text('7123456789'), findsNothing);
      expect(find.textContaining('Rekening tujuan diganti ke DANA'), findsOneWidget);
    });

    testWidgets('PRD 4.5: objek diubah dari perangkat lain (VERSION_CONFLICT): status terbaru dari current dan muat '
        'ulang', (tester) async {
      await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
        '/me/payments/pay-1/method': (_) => FakeResponse.json(
          409,
          errorJson(
            'VERSION_CONFLICT',
            'Data sudah diubah. Muat ulang untuk melihat versi terbaru.',
            current: paymentJson(method: methodDana, version: '3'),
          ),
        ),
      });

      await tester.tap(find.text('DANA'));
      await settle(tester);

      expect(find.text('081234567890'), findsOneWidget);
      expect(find.text('Data sudah diubah. Muat ulang untuk melihat versi terbaru.'), findsOneWidget);
      expect(find.text('Muat ulang'), findsOneWidget);
    });

    testWidgets('AC F03-2: pilih bukti lalu kirim: unggah payment_proof, kirim dengan Idempotency-Key, layar Menunggu '
        'Verifikasi (prototipe layar 4)', (tester) async {
      final picker = FakeProofPicker();
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
        '/files': (_) => FakeResponse.json(201, fileRefJson()),
        '/me/payments/pay-1/proof': (_) => FakeResponse.json(200, awaitingReviewJson(proofFileId: 'file-2')),
      }, picker: picker);
      final meCalls = app.adapter.requestsTo('/me').length;

      await pickFromGallery(tester);
      expect(picker.sources, [ProofSource.gallery]);
      expect(find.text('bukti-transfer.jpg'), findsOneWidget);
      expect(find.text('1,2 MB'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('proof-note')).hitTestable().first, 'dari BSI a.n. Ahmad');
      await submit(tester);

      final put = app.adapter.requestsTo('/me/payments/pay-1/proof').single;
      expect(bodyOf(put), {'file_id': 'file-2', 'transfer_note': 'dari BSI a.n. Ahmad', 'expected_proof_version': 0});
      expect(idempotencyKeyOf(put), isNotEmpty);
      expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
      expect(find.textContaining('Biasanya selesai dalam 1 hari kerja'), findsOneWidget);
      expect(find.text('Iuran pendaftaran'), findsOneWidget);
      expect(find.text('Dikirim'), findsOneWidget);
      expect(find.text('12 Okt 2026, 14.00 WIB'), findsWidgets);
      expect(find.text('Riwayat'), findsOneWidget);
      expect(find.text('Menunggu verifikasi pengurus'), findsOneWidget);
      expect(find.text('Bukti transfer dikirim (bukti ke-1)'), findsOneWidget);
      expect(find.text('Email terverifikasi, KTA dibuat'), findsOneWidget);
      expect(find.text('Ganti bukti'), findsOneWidget);
      expect(find.text('Ke Beranda'), findsOneWidget);
      expect(find.text("Assalamu'alaikum,"), findsOneWidget);
      expect(find.text('Ahmad Islam'), findsOneWidget);
      // Status keanggotaan dan penunjuk iuran di /me ikut diperbarui.
      expect(app.adapter.requestsTo('/me').length, greaterThan(meCalls));

      await tester.tap(find.text('Ke Beranda'));
      await settle(tester);
      expect(app.location, '/home');
    });

    testWidgets('PRD 4.5, AC F03-4: jaringan putus saat kirim bukti: "Memeriksa status", tidak diminta transfer '
        'ulang, lalu dikirim ulang dengan key yang sama', (tester) async {
      var online = true;
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => online ? FakeResponse.json(200, awaitingTransferJson()) : FakeResponse.network(),
        '/files': (_) => FakeResponse.json(201, fileRefJson()),
        '/me/payments/pay-1/proof': (_) =>
            online ? FakeResponse.json(200, awaitingReviewJson(proofFileId: 'file-2')) : FakeResponse.network(),
      });

      await pickFromGallery(tester);
      online = false;
      await submit(tester);

      expect(find.byKey(const ValueKey('proof-checking-status')), findsOneWidget);
      expect(find.text('Memeriksa status'), findsOneWidget);
      expect(find.textContaining('Anda tidak perlu transfer ulang'), findsOneWidget);
      expect(find.text('Periksa status pengiriman'), findsOneWidget);
      final puts = app.adapter.requestsTo('/me/payments/pay-1/proof');
      expect(puts, hasLength(1));

      online = true;
      await submit(tester);

      expect(app.adapter.requestsTo('/me/payments/pay-1/proof'), hasLength(2));
      final keys = app.adapter.requestsTo('/me/payments/pay-1/proof').map(idempotencyKeyOf).toSet();
      expect(keys, hasLength(1));
      // Berkas tidak diunggah ulang.
      expect(app.adapter.requestsTo('/files'), hasLength(1));
      expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
    });

    testWidgets('N-10, PRD 4.5: bukti tidak valid menampilkan tipe/ukuran yang diterima dan kesempatan koreksi', (
      tester,
    ) async {
      final picker = FakeProofPicker(
        const ProofPickRejected('Foto maksimal 5 MB. Ambil ulang foto atau kirim tangkapan layar dari aplikasi bank.'),
      );
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
        '/files': (_) => FakeResponse.json(422, errorJson('FILE_INVALID', 'Berkas tidak dapat diterima.')),
      }, picker: picker);

      await pickFromGallery(tester);
      expect(find.textContaining('Foto maksimal 5 MB'), findsOneWidget);
      expect(tester.widget<KapdhButton>(submitButton).onPressed, isNull);

      picker.result = ProofPicked(jpegProof());
      await pickFromGallery(tester);
      await submit(tester);

      expect(find.text('Berkas tidak dapat diterima.'), findsOneWidget);
      expect(find.text(proofRulesCaption), findsOneWidget);
      expect(app.adapter.requestsTo('/me/payments/pay-1/proof'), isEmpty);
      // Koreksi tetap tersedia: berkas dapat dipilih ulang.
      expect(tester.widget<UploadTile>(find.byKey(const ValueKey('proof-upload-tile'))).onPick, isNotNull);
    });

    testWidgets('PRD 4.5: batalkan instruksi dengan konfirmasi, If-Match dan Idempotency-Key; PRD 4.3: key pembuatan '
        'instruksi yang tertinggal ikut dilepas', (tester) async {
      final store = MemorySecureStore();
      // Key pembuatan instruksi tertinggal dari permintaan yang terputus (retensi 24 jam).
      await IdempotencyStore(
        store,
      ).keyFor('payment.create.registration', {'type': 'registration', 'payment_method_id': 'method-1'});
      final app = await openPayment(store: store, tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
        '/me/payments/pay-1/cancel': (_) => FakeResponse.json(
          200,
          paymentJson(
            status: 'cancelled',
            stage: 'cancelled',
            cancelledAt: testNow,
            version: '2',
            canSubmitProof: false,
            canChangeMethod: false,
            canCancel: false,
            events: [
              paymentEventJson('created', at: testNow.subtract(const Duration(minutes: 30))),
              paymentEventJson('cancelled', at: testNow),
            ],
          ),
        ),
      });

      await tester.tap(find.text('Batalkan instruksi'));
      await settle(tester);
      expect(find.text('Batalkan instruksi pembayaran?'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Batalkan instruksi')));
      await settle(tester);

      final cancel = app.adapter.requestsTo('/me/payments/pay-1/cancel').single;
      expect(cancel.headers['If-Match'], '1');
      expect(idempotencyKeyOf(cancel), isNotEmpty);
      expect(find.text('Instruksi pembayaran dibatalkan'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Dibatalkan'), findsOneWidget);
      expect(find.text('Buat instruksi baru'), findsOneWidget);
      // Instruksi baru tidak boleh me-replay respons instruksi yang baru dibatalkan.
      expect(store.values[IdempotencyStore.storageKey] ?? '', isNot(contains('payment.create.registration')));
    });

    testWidgets('D13: bukti sedang diperiksa dari platform tersembunyi: status tetap tampil tanpa Ganti bukti', (
      tester,
    ) async {
      await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, {...awaitingReviewJson(), 'instructions_hidden': true}),
      });

      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
      expect(find.byKey(const ValueKey('proof-replace')), findsNothing);
      expect(find.text('Ke Beranda'), findsOneWidget);
    });

    testWidgets('D13: instruksi iuran disembunyikan untuk platform ini: tanpa rekening dan unggah bukti, hanya status '
        'dan kontak pengurus', (tester) async {
      await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(
          200,
          paymentJson(instructionsHidden: true, canSubmitProof: false, canChangeMethod: false),
        ),
      });

      expect(find.byKey(const ValueKey('dues-hidden')), findsOneWidget);
      expect(find.text(duesHiddenMessage), findsOneWidget);
      expect(find.text('Hubungi pengurus'), findsOneWidget);
      expect(find.text('7123456789'), findsNothing);
      expect(submitButton, findsNothing);
      expect(find.byType(UploadTile), findsNothing);
    });

    testWidgets(
      'PRD 4.5: tiket: batas kirim bukti; RESERVATION_EXPIRED menampilkan reservasi berakhir dan status terbaru',
      (tester) async {
        final hold = testNow.add(const Duration(hours: 5));
        Map<String, Object?> ticketRef(String status) => {
          'ticket_id': 'tk-1',
          'event_id': 'ev-1',
          'event_title': 'Silaturahmi Akbar',
          'event_starts_at': iso(testNow.add(const Duration(days: 10))),
          'event_timezone': 'Asia/Jakarta',
          'ticket_status': status,
          'hold_expires_at': status == 'awaiting_payment' ? iso(hold) : null,
          'event_status': 'open',
          'ticket_cancelled_by': null,
        };
        await openPayment(tester, status: 'verified', {
          '/me/payments/pay-1': (_) => FakeResponse.json(
            200,
            paymentJson(type: 'ticket', ticket: ticketRef('awaiting_payment'), canCancel: false),
          ),
          '/files': (_) => FakeResponse.json(201, fileRefJson()),
          '/me/payments/pay-1/proof': (_) => FakeResponse.json(
            409,
            errorJson(
              'RESERVATION_EXPIRED',
              'Batas waktu reservasi sudah lewat.',
              current: paymentJson(
                type: 'ticket',
                status: 'cancelled',
                stage: 'cancelled',
                ticket: ticketRef('expired'),
                canSubmitProof: false,
                canChangeMethod: false,
                canCancel: false,
              ),
            ),
          ),
        });

        expect(find.text('Tiket Silaturahmi Akbar'), findsOneWidget);
        expect(find.textContaining('Kirim bukti sebelum 12 Okt 2026, 19.00 WIB'), findsOneWidget);
        await pickFromGallery(tester);
        await submit(tester);

        expect(find.text('Reservasi berakhir'), findsOneWidget);
        await tester.tap(find.text('Tutup'));
        await settle(tester);
        expect(find.text('Instruksi pembayaran dibatalkan'), findsOneWidget);
        expect(find.text('Lihat event'), findsOneWidget);
      },
    );
  });

  group('Menunggu verifikasi dan ganti bukti (prototipe layar 4)', () {
    testWidgets('AC F03-2: ganti bukti sebelum keputusan memakai expected_proof_version bukti aktif', (tester) async {
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
        '/files': (_) => FakeResponse.json(201, fileRefJson(id: 'file-3')),
        '/me/payments/pay-1/proof': (_) =>
            FakeResponse.json(200, awaitingReviewJson(proofVersion: 2, proofFileId: 'file-3', version: '3')),
      });

      await tester.tap(find.byKey(const ValueKey('proof-replace')));
      await settle(tester);
      expect(find.text('Ganti bukti'), findsWidgets);
      expect(find.text('Bukti transfer pengganti'), findsOneWidget);
      expect(find.textContaining('Bukti ke-1 akan diganti'), findsOneWidget);
      // Rekening tujuan tidak dapat diganti setelah bukti dikirim (PRD 4.3).
      expect(find.text('Ketuk untuk melihat nomor tujuan'), findsNothing);
      await pickFromGallery(tester);
      await submit(tester);

      final put = app.adapter.requestsTo('/me/payments/pay-1/proof').single;
      expect(bodyOf(put)['expected_proof_version'], 1);
      expect(bodyOf(put)['file_id'], 'file-3');
      expect(find.text('Bukti transfer diganti (bukti ke-2)'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
    });

    testWidgets('AC F04-4: bukti sudah diganti dari perangkat lain (PROOF_VERSION_CONFLICT): versi terbaru tampil', (
      tester,
    ) async {
      await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
        '/files': (_) => FakeResponse.json(201, fileRefJson(id: 'file-3')),
        '/me/payments/pay-1/proof': (_) => FakeResponse.json(
          409,
          errorJson(
            'PROOF_VERSION_CONFLICT',
            'Bukti sudah diganti dari perangkat lain.',
            current: awaitingReviewJson(proofVersion: 2, proofFileId: 'file-lain', version: '3'),
          ),
        ),
      });

      await tester.tap(find.byKey(const ValueKey('proof-replace')));
      await settle(tester);
      await pickFromGallery(tester);
      await submit(tester);

      expect(find.text('Bukti sudah diganti dari perangkat lain.'), findsOneWidget);
      expect(find.textContaining('Bukti ke-2 akan diganti'), findsOneWidget);
    });

    testWidgets('AC F03-3, F04-2: pengurus menolak bukti saat anggota sedang mengganti bukti: mode ganti ditutup, '
        'catatan pengurus tampil dan tetap terlihat saat unggah ulang; berkas yang dipilih tidak hilang', (
      tester,
    ) async {
      const reason = 'Foto bukti buram sehingga nominal tidak terbaca.';
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var rejected = false;
      await openPayment(tester, {
        '/me/payments/pay-1': (_) =>
            FakeResponse.json(200, rejected ? needsFixJson(reason: reason) : awaitingReviewJson()),
      }, updates: updates.stream);

      await tester.tap(find.byKey(const ValueKey('proof-replace')));
      await settle(tester);
      await pickFromGallery(tester);
      expect(find.text('Bukti transfer pengganti'), findsOneWidget);

      rejected = true;
      updates.add(notificationOf('payment', title: 'Bukti pembayaran perlu diperbaiki'));
      await settle(tester);

      // Tidak diam-diam berganti judul menjadi "Unggah ulang bukti": layar status penolakan dengan alasannya.
      expect(find.text('Bukti pembayaran belum dapat diterima'), findsOneWidget);
      expect(find.byKey(const ValueKey('rejection-note')), findsOneWidget);
      expect(
        find.descendant(of: find.byKey(const ValueKey('rejection-note')), matching: find.text(reason)),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('proof-reupload')));
      await settle(tester);
      expect(find.text('Unggah ulang bukti'), findsWidgets);
      expect(
        find.descendant(of: find.byKey(const ValueKey('rejection-note')), matching: find.text(reason)),
        findsOneWidget,
      );
      expect(find.text('bukti-transfer.jpg'), findsOneWidget);
      expect(tester.widget<KapdhButton>(submitButton).onPressed, isNotNull);
    });

    testWidgets('F-13, ARCHITECTURE §4.9: satu event notification.created memuat ulang pembayaran dan memperbarui '
        'lencana belum dibaca bersama', (tester) async {
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var approved = false;
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) =>
            FakeResponse.json(200, approved ? paymentJson(status: 'paid', stage: 'paid') : awaitingReviewJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
      }, updates: updates.stream);
      final badge = app.container.listen(notificationUnreadCountProvider, (_, _) {});
      addTearDown(badge.close);
      await settle(tester);
      expect(badge.read(), 0);
      final loads = app.adapter.requestsTo('/me/payments/pay-1').length;

      approved = true;
      updates.add(notificationOf('payment', title: 'Pembayaran disetujui', unreadCount: 3));
      await settle(tester);

      expect(app.adapter.requestsTo('/me/payments/pay-1').length, loads + 1);
      expect(badge.read(), 3);
    });

    testWidgets(
      'PRD 2.2: ACCOUNT_SUSPENDED saat kirim bukti: status dimuat ulang dan diarahkan ke portal pembatasan (PRD 2.2)',
      (tester) async {
        var status = 'unverified';
        final app = await openPayment(tester, {
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
          '/files': (_) => FakeResponse.json(201, fileRefJson()),
          '/me/payments/pay-1/proof': (_) {
            status = 'suspended';
            return FakeResponse.json(403, errorJson('ACCOUNT_SUSPENDED', 'Akun Anda sedang dibatasi.'));
          },
        });

        await pickFromGallery(tester);
        await submit(tester);

        expect(app.location, '/restricted');
      },
    );
  });

  group('Bukti ditolak (prototipe layar 5)', () {
    testWidgets('AC F03-3, F04-2: catatan pengurus dan status dapat diperbaiki; unggah ulang pada payment yang sama, '
        'alasan lama tetap di riwayat', (tester) async {
      const reason = 'Foto bukti buram sehingga nominal tidak terbaca.';
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, needsFixJson(reason: reason)),
        '/files': (_) => FakeResponse.json(201, fileRefJson(id: 'file-3')),
        '/me/payments/pay-1/proof': (_) => FakeResponse.json(
          200,
          paymentJson(
            stage: 'awaiting_review',
            proofVersion: 2,
            proofFileId: 'file-3',
            submittedAt: testNow,
            version: '4',
            canChangeMethod: false,
            canCancel: false,
            events: [
              paymentEventJson('created', at: testNow.subtract(const Duration(days: 1, hours: 1))),
              paymentEventJson('proof_submitted', at: testNow.subtract(const Duration(days: 1)), proofVersion: 1),
              paymentEventJson('rejected', at: testNow, actor: 'admin', proofVersion: 1, reason: reason),
              paymentEventJson('proof_replaced', at: testNow.add(const Duration(minutes: 5)), proofVersion: 2),
            ],
          ),
        ),
      });

      expect(find.bySemanticsLabel('Status: Perlu Perbaikan'), findsOneWidget);
      expect(find.text('Bukti pembayaran belum dapat diterima'), findsOneWidget);
      expect(find.textContaining('Anda tidak perlu transfer ulang'), findsOneWidget);
      expect(find.text('Catatan dari pengurus'), findsOneWidget);
      expect(find.text(reason), findsOneWidget);
      expect(find.text('Ditolak, dapat diperbaiki'), findsOneWidget);
      expect(find.text('Bukti ke-'), findsOneWidget);
      expect(find.text('Hubungi pengurus'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('proof-reupload')));
      await settle(tester);
      expect(find.text('Unggah ulang bukti'), findsWidgets);
      await pickFromGallery(tester);
      await submit(tester);

      final put = app.adapter.requestsTo('/me/payments/pay-1/proof').single;
      expect(bodyOf(put)['expected_proof_version'], 1);
      // Payment yang sama kembali menunggu verifikasi tanpa instruksi baru, alasan lama tetap tercatat (AC F03-3).
      expect(app.adapter.requestsTo('/me/payments').where((r) => r.method == 'POST'), isEmpty);
      expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
      expect(find.textContaining('Alasan: $reason'), findsOneWidget);
    });

    testWidgets('PRD 4.5: Hubungi pengurus membuka email bantuan tanpa data pribadi di subjek', (tester) async {
      final app = await openPayment(tester, {'/me/payments/pay-1': (_) => FakeResponse.json(200, needsFixJson())});

      await tester.tap(find.text('Hubungi pengurus'));
      await settle(tester);

      expect(app.launched.single.toString(), 'mailto:bantuan@kapdh.or.id?subject=Iuran%20keanggotaan%20KAPDH');
    });
  });

  group('Hasil akhir dan penyesuaian', () {
    testWidgets('AC F05-1, PRD 4.1: keputusan pengurus tiba lewat notifikasi realtime: layar menunggu menjadi lunas '
        'dan status keanggotaan dimuat ulang', (tester) async {
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var approved = false;
      final paid = paymentJson(
        status: 'paid',
        stage: 'paid',
        proofVersion: 1,
        proofFileId: 'file-1',
        decidedAt: testNow,
        period: {'starts_at': iso(testNow), 'expires_at': iso(DateTime.utc(2027, 10, 12, 7))},
        canSubmitProof: false,
        canChangeMethod: false,
        canCancel: false,
      );
      final app = await openPayment(tester, {
        '/me': (_) => FakeResponse.json(200, {
          ...meJson(status: approved ? 'verified' : 'unverified'),
          'registration_payment': approved ? null : meMembershipPaymentJson(),
        }),
        '/me/payments/pay-1': (_) => FakeResponse.json(200, approved ? paid : awaitingReviewJson()),
      }, updates: updates.stream);
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
      final meCalls = app.adapter.requestsTo('/me').length;

      // Notifikasi kategori lain tidak memicu muat ulang.
      updates.add(notificationOf('news', title: 'Berita baru'));
      await settle(tester);
      expect(app.adapter.requestsTo('/me/payments/pay-1'), hasLength(1));

      approved = true;
      updates.add(notificationOf('payment'));
      await settle(tester);

      expect(find.text('Iuran pendaftaran diterima'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Lunas'), findsOneWidget);
      expect(app.adapter.requestsTo('/me').length, greaterThan(meCalls));
      expect(app.location, '/payments/pay-1');
    });

    testWidgets('AC F03-4: pembayaran sudah diputus saat bukti hendak diganti: ditolak server, status terbaru tampil '
        'tanpa pengulangan', (tester) async {
      final paid = paymentJson(
        status: 'paid',
        stage: 'paid',
        proofVersion: 1,
        proofFileId: 'file-1',
        decidedAt: testNow,
        canSubmitProof: false,
        canChangeMethod: false,
        canCancel: false,
      );
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
        '/files': (_) => FakeResponse.json(201, fileRefJson(id: 'file-3')),
        '/me/payments/pay-1/proof': (_) => FakeResponse.json(
          409,
          errorJson('PAYMENT_STATE_CONFLICT', 'Pembayaran sudah diputus pengurus.', current: paid),
        ),
      });

      await tester.tap(find.byKey(const ValueKey('proof-replace')));
      await settle(tester);
      await pickFromGallery(tester);
      await submit(tester);

      expect(app.adapter.requestsTo('/me/payments/pay-1/proof'), hasLength(1));
      expect(find.text('Pembayaran sudah diputus pengurus.'), findsOneWidget);
      expect(find.text('Iuran pendaftaran diterima'), findsOneWidget);
      expect(find.byType(UploadTile), findsNothing);
      expect(find.text('Ganti bukti'), findsNothing);
    });

    testWidgets('AC F05-1: iuran pendaftaran lunas: periode keanggotaan dan Lihat KTA', (tester) async {
      final app = await openPayment(tester, status: 'verified', {
        '/me/payments/pay-1': (_) => FakeResponse.json(
          200,
          paymentJson(
            status: 'paid',
            stage: 'paid',
            proofVersion: 1,
            decidedAt: testNow,
            period: {'starts_at': iso(testNow), 'expires_at': iso(DateTime.utc(2027, 10, 12, 7))},
            canSubmitProof: false,
            canChangeMethod: false,
            canCancel: false,
            events: [
              paymentEventJson('created', at: testNow.subtract(const Duration(days: 1))),
              paymentEventJson('approved', at: testNow, actor: 'admin', proofVersion: 1),
            ],
          ),
        ),
      });

      expect(find.bySemanticsLabel('Status: Lunas'), findsOneWidget);
      expect(find.text('Iuran pendaftaran diterima'), findsOneWidget);
      expect(find.text('Masa aktif'), findsOneWidget);
      expect(find.text('12 Okt 2026 - 12 Okt 2027'), findsOneWidget);
      expect(find.text('Dana diverifikasi pengurus'), findsOneWidget);
      // AC F03-4: transaksi paid tidak menawarkan penggantian bukti.
      expect(find.byType(UploadTile), findsNothing);
      expect(find.text('Ganti bukti'), findsNothing);
      await tester.tap(find.text('Lihat KTA'));
      await settle(tester);
      expect(app.location, '/kta');
    });

    testWidgets('D6: refund menunggu rekening tujuan: formulir dikirim dengan If-Match, nilai tidak ditampilkan '
        'kembali', (tester) async {
      Map<String, Object?> adjustment({required bool given, String version = '1'}) => {
        'id': 'adj-1',
        'kind': 'refund',
        'amount': '75000.00',
        'status': 'pending',
        'has_refund_destination': given,
        'destination_required': !given,
        'due_at': iso(testNow.add(const Duration(days: 9))),
        'completed_at': null,
        'cancelled_at': null,
        'created_at': iso(testNow),
        'version': version,
      };
      final ticket = {
        'ticket_id': 'tk-1',
        'event_id': 'ev-1',
        'event_title': 'Silaturahmi Akbar',
        'event_starts_at': iso(testNow.add(const Duration(days: 10))),
        'event_timezone': 'Asia/Jakarta',
        'ticket_status': 'cancelled',
        'hold_expires_at': null,
        'event_status': 'cancelled',
        'ticket_cancelled_by': 'system',
      };
      Map<String, Object?> paid(Map<String, Object?> adj) => paymentJson(
        type: 'ticket',
        status: 'paid',
        stage: 'paid',
        proofVersion: 1,
        decidedAt: testNow,
        ticket: ticket,
        canSubmitProof: false,
        canChangeMethod: false,
        canCancel: false,
        adjustments: [adj],
      );
      final app = await openPayment(tester, status: 'verified', {
        '/me/payments/pay-1': (_) => FakeResponse.json(200, paid(adjustment(given: false))),
        '/me/payments/pay-1/adjustments/adj-1/refund-destination': (_) =>
            FakeResponse.json(200, paid(adjustment(given: true, version: '2'))),
      });

      expect(find.text('Pembayaran tiket diterima'), findsOneWidget);
      expect(find.text('Pengembalian dana'), findsOneWidget);
      expect(find.text('Belum ada'), findsOneWidget);
      Finder field(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextField));
      expect(find.bySemanticsLabel('Bank atau e-wallet, wajib'), findsOneWidget);
      await tester.enterText(field('refund-provider'), 'BRI');
      await tester.enterText(field('refund-account-number'), '0123456789012');
      await tester.enterText(field('refund-account-holder'), 'Ahmad Islam');
      await tester.tap(find.text('Kirim rekening tujuan'));
      await settle(tester);

      final put = app.adapter.requestsTo('/me/payments/pay-1/adjustments/adj-1/refund-destination').single;
      expect(put.headers['If-Match'], '1');
      expect(bodyOf(put), {'provider': 'BRI', 'account_number': '0123456789012', 'account_holder': 'Ahmad Islam'});
      expect(find.text('Sudah diterima'), findsOneWidget);
      expect(find.text('0123456789012'), findsNothing);
    });
  });

  group('Keadaan layar', () {
    testWidgets('PRD 4.5: pemeliharaan: instruksi tetap terbaca dengan pita Pemeliharaan di lembar; kirim bukti '
        'ditolak tanpa mengubah status', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        overrides: [
          proofPickerProvider.overrideWithValue(FakeProofPicker()),
          notificationCreatedEventsProvider.overrideWithValue(const Stream.empty()),
        ],
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
          '/me/fees': (_) => FakeResponse.json(200, feesJson()),
          '/me/membership': (_) => FakeResponse.json(200, membershipJson()),
          '/payment-methods': (_) => FakeResponse.json(200, methodsJson()),
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
          '/files': (_) => FakeResponse.json(503, errorJson('MAINTENANCE', 'Sistem sedang dalam pemeliharaan.')),
        }, config: publicConfigJson(maintenance: true, maintenanceUntil: DateTime.utc(2026, 10, 12, 9))),
      );
      await useTallScreen(tester);
      app.router.go('/payments/pay-1');
      await settle(tester);

      expect(app.location, '/payments/pay-1');
      expect(find.byType(MaintenanceBanner), findsOneWidget);
      expect(find.textContaining('Perubahan data ditunda sampai sekitar 12 Okt 2026, 16.00 WIB'), findsOneWidget);
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);

      await pickFromGallery(tester);
      await submit(tester);

      expect(app.adapter.requestsTo('/me/payments/pay-1/proof'), isEmpty);
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);
      expect(find.byKey(const ValueKey('proof-checking-status')), findsNothing);
    });

    testWidgets('PRD 4.5: memuat: kerangka pemuatan dengan judul layar', (tester) async {
      final pending = Completer<FakeResponse>();
      await openPayment(tester, {'/me/payments/pay-1': (_) => pending.future}, settleAfter: false);
      expect(find.bySemanticsLabel('Memuat status pembayaran'), findsOneWidget);
      expect(find.text('Status Pembayaran'), findsOneWidget);
      pending.complete(FakeResponse.json(200, awaitingTransferJson()));
      await settle(tester);
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);
    });

    testWidgets('N-09: pembayaran milik pengguna lain: tidak ditemukan tanpa tombol coba lagi', (tester) async {
      await openPayment(tester, {
        '/me/payments/pay-1': (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Pembayaran tidak ditemukan.')),
      });
      expect(find.text('Data tidak ditemukan'), findsOneWidget);
      expect(find.text('Pembayaran tidak ditemukan.'), findsOneWidget);
      expect(find.text('Coba lagi'), findsNothing);
    });

    testWidgets('PRD 4.5: tarik untuk memuat ulang gagal (5xx) saat status tampil: pemberitahuan "Status terbaru belum '
        'dapat dimuat" dengan Coba lagi; muat ulang latar yang gagal tetap diam', (tester) async {
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var failing = false;
      var rejected = false;
      final app = await openPayment(tester, {
        '/me/payments/pay-1': (_) => failing
            ? FakeResponse.json(500, errorJson('INTERNAL_ERROR', 'Server sedang bermasalah.'))
            : FakeResponse.json(200, rejected ? needsFixJson() : awaitingReviewJson()),
      }, updates: updates.stream);
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);

      failing = true;
      // Muat ulang latar (notifikasi realtime) yang gagal tidak menampilkan apa pun.
      updates.add(notificationOf('payment'));
      await settle(tester);
      final calls = app.adapter.requestsTo('/me/payments/pay-1').length;
      expect(calls, greaterThan(1));
      expect(find.byKey(const ValueKey('refresh-failed')), findsNothing);

      unawaited(tester.state<RefreshIndicatorState>(find.byType(RefreshIndicator)).show());
      await settle(tester);

      expect(app.adapter.requestsTo('/me/payments/pay-1').length, greaterThan(calls));
      expect(find.byKey(const ValueKey('refresh-failed')), findsOneWidget);
      expect(find.text('Status terbaru belum dapat dimuat'), findsOneWidget);
      expect(find.textContaining('Server sedang bermasalah.'), findsOneWidget);
      // Status lama tetap terbaca.
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);

      failing = false;
      rejected = true;
      await tester.tap(
        find.descendant(of: find.byKey(const ValueKey('refresh-failed')), matching: find.text('Coba lagi')),
      );
      await settle(tester);

      expect(find.byKey(const ValueKey('refresh-failed')), findsNothing);
      expect(find.text('Bukti pembayaran belum dapat diterima'), findsOneWidget);
    });

    testWidgets('PRD 4.5: offline saat membuka: Tidak ada koneksi, lalu coba lagi memuat status', (tester) async {
      var online = false;
      await openPayment(tester, {
        '/me/payments/pay-1': (_) => online ? FakeResponse.json(200, awaitingReviewJson()) : FakeResponse.network(),
      });
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      online = true;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(find.bySemanticsLabel('Status: Menunggu Verifikasi'), findsOneWidget);
    });

    testWidgets('N-11: pedoman aksesibilitas otomatis (target sentuh, label, kontras) pada instruksi bayar dan unggah '
        'bukti', (tester) async {
      await openPayment(tester, {'/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson())});
      await expectMeetsAccessibilityGuidelines(tester);
      await pickFromGallery(tester);
      expect(submitButton, findsOneWidget);
      await expectMeetsAccessibilityGuidelines(tester);
    });

    testWidgets('N-11: pedoman aksesibilitas otomatis pada menunggu verifikasi', (tester) async {
      await openPayment(tester, {'/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson())});
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
      await expectMeetsAccessibilityGuidelines(tester);
    });

    testWidgets('N-11: pedoman aksesibilitas otomatis pada bukti ditolak (unggah ulang)', (tester) async {
      await openPayment(tester, {'/me/payments/pay-1': (_) => FakeResponse.json(200, needsFixJson())});
      expect(find.byKey(const ValueKey('rejection-note')), findsOneWidget);
      await expectMeetsAccessibilityGuidelines(tester);
    });

    testWidgets('N-11: teks 200 % pada instruksi bayar tanpa meluap', (tester) async {
      await openPayment(
        tester,
        {'/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson())},
        textScale: 2,
        tall: false,
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);
    });

    testWidgets('N-11: teks 200 % pada layar menunggu tanpa meluap', (tester) async {
      await openPayment(
        tester,
        {'/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson())},
        textScale: 2,
        tall: false,
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
    });
  });

  group('Lihat bukti yang dikirim (payments.yaml proof_file_id, files.yaml getFileAccess; AC F03-2, F03-3)', () {
    const accessPath = '/files/file-1/access';
    const freshUrl = 'https://api.kapdh.or.id/api/v1/files/content/token-bukti-baru';
    const expiredUrl = 'https://api.kapdh.or.id/api/v1/files/content/token-bukti-expired';

    Map<String, Object?> accessJson({String url = freshUrl, String mime = 'image/jpeg'}) => {
      'url': url,
      'expires_at': iso(testNow.add(const Duration(minutes: 10))),
      'mime': mime,
    };

    /// URL bertanda tangan yang sudah kedaluwarsa gagal dimuat; URL lain menjadi gambar memori.
    final images = privateImageProviderFactoryProvider.overrideWithValue(
      (url) => url == expiredUrl ? _BrokenImage(url) : MemoryImage(_transparentPng),
    );

    Finder proofImage(String url) => find.byKey(ValueKey('proof-image-$url'));

    testWidgets('AC F03-2: bukti yang sedang diperiksa dibuka layar penuh; URL baca diminta baru setiap dibuka', (
      tester,
    ) async {
      final app = await openPayment(
        tester,
        {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
          accessPath: (_) => FakeResponse.json(200, accessJson()),
        },
        overrides: [images],
      );
      expect(app.adapter.requestsTo(accessPath), isEmpty, reason: 'URL baca hanya diminta saat anggota membukanya');
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-view')));
      await settle(tester);
      expect(find.byType(ProofImageViewer), findsOneWidget);
      expect(proofImage(freshUrl), findsOneWidget);
      expect(find.text('Bukti transfer ke-1'), findsOneWidget);
      expect(app.adapter.requestsTo(accessPath), hasLength(1));
      await expectMeetsAccessibilityGuidelines(tester);

      await tester.tap(find.byKey(const ValueKey('proof-viewer-close')));
      await settle(tester);
      expect(find.byType(ProofImageViewer), findsNothing);
      expect(app.location, '/payments/pay-1');
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-view')));
      await settle(tester);
      expect(app.adapter.requestsTo(accessPath), hasLength(2));
    });

    testWidgets('AC F03-3: bukti yang ditolak dapat dilihat sebelum unggah ulang; URL kedaluwarsa dimuat ulang', (
      tester,
    ) async {
      var calls = 0;
      final app = await openPayment(
        tester,
        {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, needsFixJson()),
          accessPath: (_) => FakeResponse.json(200, accessJson(url: calls++ == 0 ? expiredUrl : freshUrl)),
        },
        overrides: [images],
      );
      expect(find.byKey(const ValueKey('proof-reupload')), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-view')));
      await settle(tester);
      expect(find.textContaining('Bukti tidak dapat dimuat'), findsOneWidget);
      await expectMeetsAccessibilityGuidelines(tester);
      await tester.tap(find.byKey(const ValueKey('proof-viewer-reload')));
      await settle(tester);
      expect(app.adapter.requestsTo(accessPath), hasLength(2));
      expect(proofImage(freshUrl), findsOneWidget);
      expect(find.textContaining('Bukti tidak dapat dimuat'), findsNothing);
    });

    testWidgets('bukti PDF dibuka aplikasi penampil perangkat sesuai mime', (tester) async {
      final app = await openPayment(
        tester,
        {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
          accessPath: (_) => FakeResponse.json(200, accessJson(mime: 'application/pdf')),
        },
        overrides: [images],
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-view')));
      await settle(tester);
      expect(find.byType(ProofImageViewer), findsNothing);
      expect(app.launched, [Uri.parse(freshUrl)]);
    });

    testWidgets('N-09: berkas yang tidak tersedia lagi (404) dijelaskan tanpa membedakan alasan', (tester) async {
      await openPayment(
        tester,
        {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
          accessPath: (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Berkas tidak ditemukan.')),
        },
        overrides: [images],
      );
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-view')));
      await settle(tester);
      expect(find.byType(ProofImageViewer), findsNothing);
      expect(find.text(proofUnavailableMessage), findsOneWidget);
    });

    testWidgets('tanpa proof_file_id (belum ada bukti, atau bukti dicatat pengurus) tautan tidak tampil', (
      tester,
    ) async {
      final app = await openPayment(
        tester,
        {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
          // Bukti dicatat pengurus (POST /admin/payments, D13): server tidak mengirim proof_file_id (N-09).
          '/me/payments/pay-2': (_) => FakeResponse.json(
            200,
            paymentJson(
              id: 'pay-2',
              stage: 'awaiting_review',
              proofVersion: 1,
              submittedAt: testNow,
              canChangeMethod: false,
              canCancel: false,
            ),
          ),
        },
        overrides: [images],
      );
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);
      expect(find.byKey(const ValueKey('proof-view')), findsNothing);

      unawaited(app.router.push('/payments/pay-2'));
      await settle(tester);
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
      expect(find.byKey(const ValueKey('proof-view')), findsNothing);
      expect(app.adapter.requestsTo('/files/file-1/access'), isEmpty);
    });

    testWidgets('N-11: teks 200 % pada layar menunggu dengan tautan bukti tanpa meluap', (tester) async {
      await openPayment(
        tester,
        {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
          accessPath: (_) => FakeResponse.json(200, accessJson()),
        },
        overrides: [images],
        textScale: 2,
        tall: false,
      );
      // Daftar dibangun malas: gulir sampai tautan dibangun dan terlihat.
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('proof-view')),
        200,
        scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first,
      );
      await settle(tester);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('proof-view')));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(find.byType(ProofImageViewer), findsOneWidget);
    });
  });
}

/// PNG transparan 1×1 pengganti gambar bukti.
final Uint8List _transparentPng = Uint8List.fromList(const [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, //
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, //
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, //
  0x42, 0x60, 0x82,
]);

/// Gambar yang selalu gagal dimuat (URL bertanda tangan kedaluwarsa: server menjawab 404).
class _BrokenImage extends ImageProvider<_BrokenImage> {
  const _BrokenImage(this.url);

  final String url;

  @override
  Future<_BrokenImage> obtainKey(ImageConfiguration configuration) => SynchronousFuture(this);

  @override
  ImageStreamCompleter loadImage(_BrokenImage key, ImageDecoderCallback decode) =>
      OneFrameImageStreamCompleter(Future<ImageInfo>.error(StateError('URL bukti kedaluwarsa (uji)')));

  @override
  bool operator ==(Object other) => other is _BrokenImage && other.url == url;

  @override
  int get hashCode => url.hashCode;
}
