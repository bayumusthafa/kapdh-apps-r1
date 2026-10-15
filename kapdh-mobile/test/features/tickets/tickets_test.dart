import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/payments/widgets/proof_upload_section.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../events/event_fixtures.dart';
import '../home/feature_harness.dart';

void main() {
  group('Tiket Saya (F-09, PRD 4.4)', () {
    testWidgets('F-09 tab Aktif: status berlabel dan batas kirim bukti; tab Riwayat memakai view=history', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets',
        routes: {
          '/me/tickets': (options) => options.queryParameters['view'] == 'history'
              ? FakeResponse.json(200, ticketPageJson([]))
              : FakeResponse.json(
                  200,
                  ticketPageJson([
                    ticketSummaryJson(
                      status: 'awaiting_payment',
                      holdExpiresAt: testNow.add(const Duration(hours: 24)),
                    ),
                    ticketSummaryJson(id: 'ticket-2', eventStatus: 'cancelled', status: 'cancelled'),
                  ]),
                ),
        },
      );
      expect(app.location, '/tickets');
      expect(lastQuery(app, '/me/tickets'), {'view': 'active', 'limit': 20});
      expect(find.textContaining('Menunggu Pembayaran'), findsOneWidget);
      expect(find.text('Kirim bukti sebelum 13 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Event dibatalkan')), findsOneWidget);

      await tester.tap(find.text('Riwayat'));
      await settle(tester);
      expect(lastQuery(app, '/me/tickets')['view'], 'history');
      expect(find.text('Belum ada riwayat tiket'), findsOneWidget);
    });

    testWidgets('N-03 tiket aktif kosong: ajakan melihat event; galat: coba lagi', (tester) async {
      var fail = true;
      final app = await pumpMemberApp(
        tester,
        location: '/tickets',
        routes: {
          '/me/tickets': (_) => fail ? FakeResponse.network() : FakeResponse.json(200, ticketPageJson([])),
          '/events': (_) => FakeResponse.json(200, eventPageJson([])),
          '/event-categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
        },
      );
      expect(find.byType(ErrorState), findsWidgets);
      fail = false;
      await tester.tap(find.text('Coba lagi').first);
      await settle(tester);
      expect(find.text('Belum ada tiket aktif'), findsOneWidget);
      await tester.tap(find.text('Lihat event'));
      await settle(tester);
      expect(app.location, '/events');
    });

    testWidgets('PRD 2.2 anggota expired tetap melihat tiket lunas, QR-nya dan detail event yang dipesan', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        status: 'expired',
        location: '/tickets',
        routes: {
          '/me/tickets': (options) => options.queryParameters['view'] == 'history'
              ? FakeResponse.json(200, ticketPageJson([]))
              : FakeResponse.json(200, ticketPageJson([ticketSummaryJson()])),
          '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson()),
          '/events/event-1': (_) => FakeResponse.json(
            200,
            eventDetailJson(canReserve: false, blockedReason: 'membership_required', myTicket: ticketSummaryJson()),
          ),
        },
      );
      expect(app.location, '/tickets');
      expect(find.textContaining('Terkonfirmasi'), findsOneWidget);
      await tester.tap(find.text('Camping Alumni KAPDH'));
      await settle(tester);
      expect(app.location, '/tickets/ticket-1');
      expect(find.byKey(const ValueKey('ticket-qr')), findsOneWidget);
      // Detail event yang pernah dipesan tetap dapat dibuka (kontrak C5 getEvent `nonsuspended`), tanpa daftar baru.
      await scrollTo(tester, find.byKey(const ValueKey('ticket-open-event')));
      await tester.tap(find.byKey(const ValueKey('ticket-open-event')));
      await settle(tester);
      expect(app.location, '/events/event-1');
      expect(find.byKey(const ValueKey('event-reserve')), findsNothing);
    });

    testWidgets('PRD 2.2 tiket expired tanpa tiket: pesan kosong tanpa ajakan mendaftar', (tester) async {
      await pumpMemberApp(
        tester,
        status: 'expired',
        location: '/tickets',
        routes: {'/me/tickets': (_) => FakeResponse.json(200, ticketPageJson([]))},
      );
      expect(find.text('Tiket yang sudah lunas tetap tampil di sini.'), findsOneWidget);
      expect(find.text('Lihat event'), findsNothing);
    });
  });

  group('Detail Tiket (F-09, AC F09-2, F09-3, F09-7, D5, D6)', () {
    testWidgets('AC F09-3 tiket paid: QR unik, jendela check-in WIB dan aturan H-3 dengan nominal refund', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {'/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson())},
      );
      expect(find.text('Detail Tiket'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-qr')), findsOneWidget);
      expect(find.textContaining('Check-in dibuka 20 Okt 2026, 07.00 WIB – 20 Okt 2026, 15.00 WIB'), findsOneWidget);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel-policy')));
      expect(
        find.textContaining('Batalkan sampai 17 Okt 2026, 09.00 WIB (H-3) untuk refund penuh Rp200.000'),
        findsOneWidget,
      );
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-open-event')), delta: -200);
      await tester.tap(find.byKey(const ValueKey('ticket-open-event')));
      await settle(tester);
      expect(app.location, '/events/event-1');
    });

    testWidgets('D5 reservasi menunggu bukti: hitung mundur hold, tanpa QR, Bayar Sekarang ke pembayaran bersama', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(hours: 24))),
          ),
          // Layar pembayaran bersama (F-04) yang dibuka "Bayar Sekarang".
          '/me/payments/payment-9': (_) =>
              FakeResponse.json(200, ticketPaymentDetailJson(holdExpiresAt: testNow.add(const Duration(hours: 24)))),
          '/payment-methods': (_) => FakeResponse.json(200, {
            'items': [paymentMethodJson()],
          }),
        },
      );
      expect(find.text('Selesaikan pembayaran dalam'), findsOneWidget);
      expect(find.byKey(const ValueKey('hold-countdown')), findsOneWidget);
      expect(find.text('24:00:00'), findsOneWidget);
      expect(find.text('Batas kirim bukti: 13 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-qr')), findsNothing);

      app.clock.advance(const Duration(hours: 1, minutes: 30));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('22:30:00'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('ticket-pay')));
      await settle(tester);
      expect(app.location, '/payments/payment-9');
      // Instruksi tiket di layar pembayaran bersama, bukan galat "tidak ditemukan".
      expect(find.byType(ErrorState), findsNothing);
      expect(find.text('Tiket Camping Alumni KAPDH'), findsWidgets);
      expect(find.textContaining('Kirim bukti sebelum 13 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(tester.widget<ProofUploadSection>(find.byType(ProofUploadSection)).onPick, isNotNull);
    });

    testWidgets('ADR-026 reservasi dibayar QRIS: tujuan pembayaran merchant dan NMID tanpa gambar; Bayar Sekarang '
        'menampilkan gambar QRIS di instruksi pembayaran', (tester) async {
      final hold = testNow.add(const Duration(hours: 24));
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            ticketDetailJson(
              status: 'awaiting_payment',
              holdExpiresAt: hold,
              payment: ticketPaymentJson(
                method: {
                  'kind': 'qris',
                  'provider': 'QRIS',
                  'account_number': 'ID1020200012345',
                  'account_holder': 'KAPDH Pusat',
                  'instructions': null,
                },
              ),
            ),
          ),
          '/me/payments/payment-9': (_) =>
              FakeResponse.json(200, ticketPaymentDetailJson(holdExpiresAt: hold, method: qrisMethodJson())),
          '/payment-methods': (_) => FakeResponse.json(200, {
            'items': [qrisMethodJson()],
          }),
        },
      );
      expect(find.textContaining('Pindai QRIS di halaman pembayaran dan masukkan nominal persis'), findsOneWidget);
      await scrollUntil(tester, find.text('Tujuan pembayaran'));
      expect(find.text('QRIS KAPDH Pusat\nNMID ID1020200012345'), findsOneWidget);
      expect(find.text('Rekening tujuan'), findsNothing);
      // Ringkasan tiket tidak memuat gambar QRIS (events.yaml TicketPaymentMethodKind); gambar dibuka dari instruksi.
      expect(find.byType(QrisImageCard), findsNothing);
      expect(requestedImages, isNot(contains('https://api.kapdh.or.id/api/v1/files/public/file-qr-1')));

      await scrollUntil(tester, find.byKey(const ValueKey('ticket-pay')), delta: -200);
      await tester.tap(find.byKey(const ValueKey('ticket-pay')));
      await settle(tester);
      expect(app.location, '/payments/payment-9');
      expect(find.byType(QrisImageCard), findsOneWidget);
      expect(find.text('NMID: ID1020200012345'), findsOneWidget);
      expect(requestedImages, contains('https://api.kapdh.or.id/api/v1/files/public/file-qr-1'));
    });

    testWidgets('AC F09-2 hold habis: layar memuat ulang status dari server dan tiket tampil expired', (tester) async {
      var expired = false;
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            expired
                ? ticketDetailJson(status: 'expired', holdExpiresAt: testNow.add(const Duration(minutes: 1)))
                : ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(minutes: 1))),
          ),
        },
      );
      expect(find.text('00:01:00'), findsOneWidget);
      expired = true;
      app.clock.advance(const Duration(minutes: 2));
      await tester.pump(const Duration(seconds: 1));
      await settle(tester);
      expect(app.adapter.requestsTo('/me/tickets/ticket-1'), hasLength(2));
      expect(find.text('Reservasi berakhir'), findsOneWidget);
      expect(find.textContaining('Jangan transfer untuk reservasi ini.'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-pay')), findsNothing);
      expect(find.byKey(const ValueKey('ticket-qr')), findsNothing);
    });

    testWidgets('AC F09-2 hold habis saat offline: batas tampil lewat, status dimuat ulang sekali (tidak berulang)', (
      tester,
    ) async {
      var online = true;
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => online
              ? FakeResponse.json(
                  200,
                  ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(seconds: 30))),
                )
              : FakeResponse.network(),
        },
      );
      online = false;
      app.clock.advance(const Duration(minutes: 1));
      await tester.pump(const Duration(seconds: 1));
      await settle(tester);
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(app.adapter.requestsTo('/me/tickets/ticket-1'), hasLength(2));
      expect(find.text('Batas waktu pembayaran lewat'), findsOneWidget);
      expect(find.byKey(const ValueKey('hold-countdown')), findsNothing);
      // Status terakhir tetap tampil dengan penjelasan bahwa belum terbaru, dan coba lagi memulihkan.
      expect(find.byKey(const ValueKey('refresh-failed')), findsOneWidget);
      expect(find.textContaining('Periksa koneksi internet Anda.'), findsOneWidget);
      online = true;
      await tester.tap(find.widgetWithText(TextButton, 'Coba lagi'));
      await settle(tester);
      expect(find.byKey(const ValueKey('refresh-failed')), findsNothing);
    });

    testWidgets('AC F09-2 batas hold lewat sebelum status terbaru: tidak menawarkan bayar/batal, jangan transfer', (
      tester,
    ) async {
      var online = true;
      var expired = false;
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => !online
              ? FakeResponse.network()
              : FakeResponse.json(
                  200,
                  ticketDetailJson(
                    status: expired ? 'expired' : 'awaiting_payment',
                    holdExpiresAt: testNow.add(const Duration(seconds: 30)),
                  ),
                ),
        },
      );
      expect(find.byKey(const ValueKey('ticket-pay')), findsOneWidget);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      online = false;
      app.clock.advance(const Duration(minutes: 1));
      await tester.pump(const Duration(seconds: 1));
      await settle(tester);

      // Server belum terjangkau: status lama tetap awaiting_payment, tetapi bayar dan batal tidak lagi ditawarkan.
      expect(find.byKey(const ValueKey('ticket-pay')), findsNothing);
      expect(find.byKey(const ValueKey('ticket-cancel')), findsNothing);
      expect(find.byKey(const ValueKey('ticket-cancel-policy')), findsNothing);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-hold-passed')), delta: -200);
      expect(find.text('Status reservasi belum terbaru'), findsOneWidget);
      expect(find.textContaining('Jangan transfer untuk reservasi ini sebelum statusnya diperbarui.'), findsOneWidget);

      online = true;
      expired = true;
      await tester.tap(find.byKey(const ValueKey('ticket-hold-reload')));
      await settle(tester);
      expect(find.text('Reservasi berakhir'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-hold-passed')), findsNothing);
      expect(find.byKey(const ValueKey('ticket-pay')), findsNothing);
    });

    testWidgets('PRD 2.2 detail tiket ditolak ACCOUNT_SUSPENDED: /me dimuat ulang lalu ke portal pembatasan', (
      tester,
    ) async {
      var status = 'verified';
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/me/tickets/ticket-1': (_) {
            status = 'suspended';
            return FakeResponse.json(403, errorJson('ACCOUNT_SUSPENDED', 'Akun Anda sedang dibatasi.'));
          },
        },
      );
      expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
      expect(app.location, '/restricted');
    });

    testWidgets('PRD 2.2 daftar tiket ditolak MEMBERSHIP_REQUIRED: /me dimuat ulang, status baru diikuti', (
      tester,
    ) async {
      var status = 'verified';
      final app = await pumpMemberApp(
        tester,
        location: '/tickets',
        push: false,
        routes: {
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/me/tickets': (_) {
            status = 'unverified';
            return FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Fitur ini memerlukan KTA aktif.'));
          },
        },
      );
      expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
      // Tiket Saya tidak termasuk rute anggota unverified (matriks PRD 2.2): diarahkan ke rute awal statusnya.
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('PRD 4.3 bukti sedang ditinjau: kursi ditahan, QR belum terbit, tidak dapat dibatalkan sendiri', (
      tester,
    ) async {
      await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) =>
              FakeResponse.json(200, ticketDetailJson(status: 'awaiting_review', canCancel: false)),
        },
      );
      expect(find.text('Menunggu verifikasi pengurus'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-qr')), findsNothing);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel-policy')));
      expect(find.textContaining('tidak dapat dibatalkan sendiri'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-cancel')), findsNothing);
    });

    testWidgets('AC F09-5 sudah check-in: waktu kehadiran tanpa QR dan tanpa pembatalan', (tester) async {
      await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            ticketDetailJson(checkedInAt: DateTime.utc(2026, 10, 20, 1, 30), canCancel: false, refundEligible: false),
          ),
        },
      );
      expect(find.text('Sudah check-in'), findsOneWidget);
      expect(find.textContaining('Anda tercatat hadir pada 20 Okt 2026, 08.30 WIB'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-qr')), findsNothing);
      expect(find.byKey(const ValueKey('ticket-cancel')), findsNothing);
    });

    testWidgets(
      'AC F09-7 event dibatalkan: QR tidak berlaku, refund penuh tercatat dan rekening diminta di pembayaran',
      (tester) async {
        final app = await pumpMemberApp(
          tester,
          location: '/tickets/ticket-1',
          routes: {
            '/me/tickets/ticket-1': (_) => FakeResponse.json(
              200,
              ticketDetailJson(
                status: 'cancelled',
                eventStatus: 'cancelled',
                cancelledBy: 'admin',
                cancelledAt: testNow.subtract(const Duration(hours: 2)),
                cancelReason: 'Cuaca buruk',
                payment: ticketPaymentJson(status: 'paid', submittedAt: testNow, decidedAt: testNow),
                refunds: [refundJson()],
              ),
            ),
          },
        );
        expect(find.text('Event dibatalkan'), findsOneWidget);
        expect(find.textContaining('seluruh QR tidak berlaku'), findsOneWidget);
        expect(find.textContaining('Alasan: Cuaca buruk.'), findsOneWidget);
        expect(find.byKey(const ValueKey('ticket-qr')), findsNothing);
        await scrollUntil(tester, find.byKey(const ValueKey('ticket-refunds')));
        expect(find.textContaining('Refund Diproses'), findsOneWidget);
        expect(find.text('Paling lambat 21 Okt 2026'), findsOneWidget);
        await scrollUntil(tester, find.text('Isi rekening tujuan refund'));
        await tester.tap(find.text('Isi rekening tujuan refund'));
        await settle(tester);
        expect(app.location, '/payments/payment-9');
      },
    );

    testWidgets('AC F09-4 bukti ditolak: tiket dibatalkan final dengan alasan dan ajakan daftar ulang', (tester) async {
      await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            ticketDetailJson(
              status: 'cancelled',
              cancelledBy: 'system',
              cancelledAt: testNow,
              payment: ticketPaymentJson(
                status: 'rejected',
                submittedAt: testNow,
                decidedAt: testNow,
                rejectionReason: 'Nominal tidak sesuai',
              ),
              canCancel: false,
              refundEligible: false,
            ),
          ),
        },
      );
      expect(find.text('Tiket dibatalkan'), findsOneWidget);
      expect(
        find.textContaining('Bukti pembayaran ditolak pengurus pada 12 Okt 2026, 14.00 WIB: Nominal tidak sesuai.'),
        findsOneWidget,
      );
      expect(find.textContaining('Daftar ulang bila kuota masih tersedia'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-cancel')), findsNothing);
    });

    testWidgets('N-03 memuat: kerangka daftar dan detail tiket selagi request berjalan', (tester) async {
      final list = Completer<FakeResponse>();
      final detail = Completer<FakeResponse>();
      await pumpMemberApp(
        tester,
        settled: false,
        location: '/tickets',
        routes: {
          '/me/tickets': (options) =>
              options.queryParameters['view'] == 'history' ? FakeResponse.json(200, ticketPageJson([])) : list.future,
          '/me/tickets/ticket-1': (_) => detail.future,
        },
      );
      expect(find.bySemanticsLabel('Memuat tiket'), findsWidgets);
      list.complete(FakeResponse.json(200, ticketPageJson([ticketSummaryJson()])));
      await settle(tester);
      await tester.tap(find.text('Camping Alumni KAPDH'));
      await pumpFrames(tester, count: 10);
      expect(find.bySemanticsLabel('Memuat tiket'), findsOneWidget);
      detail.complete(FakeResponse.json(200, ticketDetailJson()));
      await settle(tester);
      expect(find.byKey(const ValueKey('ticket-qr')), findsOneWidget);
    });

    testWidgets('AC F13-3 tiket tidak ditemukan atau milik akun lain (404)', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-x',
        routes: {
          '/me/tickets/ticket-x': (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Data tidak ditemukan.')),
          '/me/tickets': (_) => FakeResponse.json(200, ticketPageJson([])),
        },
      );
      expect(find.text('Tiket tidak ditemukan'), findsOneWidget);
      await tester.tap(find.text('Lihat tiket saya'));
      await settle(tester);
      expect(app.location, '/tickets');
    });
  });

  group('Pembatalan sendiri (D6, PRD 3.9)', () {
    testWidgets(
      'D6 sebelum H-3: konsekuensi refund penuh dikonfirmasi; If-Match dan expected_refund_eligible dikirim',
      (tester) async {
        final app = await pumpMemberApp(
          tester,
          location: '/tickets/ticket-1',
          routes: {
            '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson()),
            '/me/tickets/ticket-1/cancel': (_) => FakeResponse.json(
              200,
              ticketDetailJson(
                status: 'cancelled',
                cancelledBy: 'self',
                cancelledAt: testNow,
                cancelReason: 'Berhalangan hadir',
                payment: ticketPaymentJson(status: 'paid', submittedAt: testNow, decidedAt: testNow),
                refunds: [refundJson()],
                canCancel: false,
                refundEligible: false,
                version: '5',
              ),
            ),
          },
        );
        await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
        await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
        await settle(tester);
        expect(find.text('Batalkan tiket?'), findsOneWidget);
        expect(
          find.textContaining('Refund penuh Rp200.000 diproses bendahara paling lambat 7 hari kerja'),
          findsOneWidget,
        );
        // "Kembali" tidak mengirim apa pun.
        await tester.tap(find.text('Kembali'));
        await settle(tester);
        expect(app.adapter.requestsTo('/me/tickets/ticket-1/cancel'), isEmpty);

        await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
        await settle(tester);
        await tester.enterText(find.byKey(const ValueKey('cancel-reason')), ' Berhalangan hadir ');
        await tester.tap(find.byKey(const ValueKey('cancel-confirm')));
        await settle(tester);

        final request = app.adapter.requestsTo('/me/tickets/ticket-1/cancel').single;
        expect(request.method, 'POST');
        expect(request.data, {'expected_refund_eligible': true, 'reason': 'Berhalangan hadir'});
        expect(request.headers['If-Match'], '4');
        expect(request.headers['Idempotency-Key'], isNotEmpty);
        expect(find.textContaining('Tiket dibatalkan. Refund penuh diproses bendahara'), findsOneWidget);
        expect(find.text('Tiket dibatalkan'), findsOneWidget);
        expect(find.textContaining('Anda membatalkan tiket ini'), findsOneWidget);
        expect(find.byKey(const ValueKey('ticket-qr')), findsNothing);
      },
    );

    testWidgets('D6 sesudah H-3: konfirmasi menyatakan TANPA refund dan mengirim expected_refund_eligible=false', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson(refundEligible: false)),
          '/me/tickets/ticket-1/cancel': (_) => FakeResponse.json(
            200,
            ticketDetailJson(status: 'cancelled', cancelledBy: 'self', cancelledAt: testNow, refundEligible: false),
          ),
        },
      );
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel-policy')));
      expect(find.textContaining('Batas refund penuh (H-3) sudah lewat pada 17 Okt 2026, 09.00 WIB'), findsOneWidget);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
      await settle(tester);
      expect(find.textContaining('Pembatalan sekarang TIDAK mendapat refund'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('cancel-confirm')));
      await settle(tester);
      final request = app.adapter.requestsTo('/me/tickets/ticket-1/cancel').single;
      expect(request.data, {'expected_refund_eligible': false});
      expect(find.text('Tiket dibatalkan dan kursi Anda dilepas.'), findsOneWidget);
    });

    testWidgets('D6 batas H-3 terlewat saat konfirmasi (409 VERSION_CONFLICT): keadaan terbaru dan peringatan refund', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson()),
          '/me/tickets/ticket-1/cancel': (_) => FakeResponse.json(
            409,
            errorJson(
              'VERSION_CONFLICT',
              'Data berubah. Muat ulang.',
              current: ticketDetailJson(refundEligible: false, version: '5'),
            ),
          ),
        },
      );
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('cancel-confirm')));
      await settle(tester);
      expect(find.text('Data tiket berubah'), findsOneWidget);
      expect(find.textContaining('Pembatalan sekarang tidak mendapat refund'), findsOneWidget);
      await tester.tap(find.text('Tutup'));
      await settle(tester);
      // Tidak ada pengiriman ulang otomatis; layar menampilkan aturan terbaru.
      expect(app.adapter.requestsTo('/me/tickets/ticket-1/cancel'), hasLength(1));
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel-policy')));
      expect(find.textContaining('Batas refund penuh (H-3) sudah lewat'), findsOneWidget);
    });

    testWidgets('D6 event gratis: tanpa refund, pembatalan melepas kursi', (tester) async {
      await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {'/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson(total: '0.00'))},
      );
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel-policy')));
      expect(find.textContaining('Event gratis tidak memiliki refund'), findsWidgets);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
      await settle(tester);
      expect(find.textContaining('Kursi Anda dilepas untuk anggota lain'), findsOneWidget);
    });

    testWidgets('D5 batalkan reservasi yang belum dibayar: kursi dilepas, jangan transfer', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(hours: 24))),
          ),
          '/me/tickets/ticket-1/cancel': (_) => FakeResponse.json(
            200,
            ticketDetailJson(
              status: 'cancelled',
              cancelledBy: 'self',
              cancelledAt: testNow,
              payment: ticketPaymentJson(status: 'cancelled'),
              refundEligible: false,
            ),
          ),
        },
      );
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      expect(find.text('Batalkan Reservasi'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
      await settle(tester);
      expect(find.text('Batalkan reservasi?'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('cancel-confirm')));
      await settle(tester);
      expect(app.adapter.requestsTo('/me/tickets/ticket-1/cancel').single.data, {'expected_refund_eligible': false});
      expect(find.text('Reservasi dibatalkan dan kursi dilepas. Jangan transfer untuk reservasi ini.'), findsOneWidget);
    });

    testWidgets('PRD 4.3 bukti sedang ditinjau saat membatalkan (409 PAYMENT_STATE_CONFLICT): penjelasan', (
      tester,
    ) async {
      await pumpMemberApp(
        tester,
        location: '/tickets/ticket-1',
        routes: {
          '/me/tickets/ticket-1': (_) => FakeResponse.json(
            200,
            ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(hours: 24))),
          ),
          '/me/tickets/ticket-1/cancel': (_) => FakeResponse.json(
            409,
            errorJson(
              'PAYMENT_STATE_CONFLICT',
              'Bukti sedang ditinjau pengurus.',
              current: ticketDetailJson(status: 'awaiting_review', canCancel: false),
            ),
          ),
        },
      );
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('cancel-confirm')));
      await settle(tester);
      expect(find.text('Tiket tidak dapat dibatalkan'), findsOneWidget);
      expect(find.text('Bukti sedang ditinjau pengurus.'), findsOneWidget);
      await tester.tap(find.text('Tutup'));
      await settle(tester);
      expect(find.text('Menunggu verifikasi pengurus'), findsOneWidget);
    });

    testWidgets('N-11 detail tiket dan dialog pembatalan pada teks 200 % tanpa meluap', (tester) async {
      await pumpMemberApp(
        tester,
        textScale: 2,
        location: '/tickets/ticket-1',
        routes: {'/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson())},
      );
      expect(tester.takeException(), isNull);
      await scrollUntil(tester, find.byKey(const ValueKey('ticket-cancel')));
      await tester.tap(find.byKey(const ValueKey('ticket-cancel')));
      await settle(tester);
      expect(tester.takeException(), isNull);
    });
  });
}
