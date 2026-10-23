import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/payments/widgets/proof_upload_section.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../home/content_fixtures.dart';
import '../home/feature_harness.dart';
import 'event_fixtures.dart';

Map<String, Object?> _categories() => {
  'items': [eventCategoryJson(), eventCategoryJson(id: 'cat-workshop', slug: 'workshop', label: 'Workshop')],
};

FakeResponse _participants(_) => FakeResponse.json(
  200,
  eventPageJson([participantJson(), participantJson(userId: 'user-3', fullName: 'Siti Aminah', cohort: 2)]),
);

FakeResponse _methods(_) => FakeResponse.json(200, {
  'items': [
    paymentMethodJson(),
    paymentMethodJson(id: 'method-dana', kind: 'ewallet', provider: 'DANA', accountNumber: '081234567890'),
  ],
});

/// Rute detail event standar untuk anggota aktif.
Map<String, FakeHandler> _detailRoutes(Map<String, Object?> detail, {Map<String, FakeHandler> extra = const {}}) => {
  '/events/event-1': (_) => FakeResponse.json(200, detail),
  '/events/event-1/participants': _participants,
  '/payment-methods': _methods,
  ...extra,
};

KapdhButton _button(WidgetTester tester, String key) => tester.widget<KapdhButton>(find.byKey(ValueKey(key)));

void main() {
  group('Daftar Event (F-09, guideline hal. 8)', () {
    testWidgets('F-09 tab Semua/Reuni/Workshop dari server; kartu berkategori, tanggal zona event, label pendaftaran', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events',
        push: false,
        routes: {
          '/event-categories': (_) => FakeResponse.json(200, _categories()),
          '/events': (options) => FakeResponse.json(
            200,
            eventPageJson([
              if (options.queryParameters['category_id'] != 'cat-workshop') eventSummaryJson(myTicketStatus: 'paid'),
              eventSummaryJson(
                id: 'event-2',
                title: 'Workshop Kewirausahaan',
                category: eventCategoryJson(id: 'cat-workshop', slug: 'workshop', label: 'Workshop'),
                registrationState: 'closed',
                price: '0.00',
              ),
            ]),
          ),
        },
      );
      expect(app.location, '/events');
      expect(find.text('Semua'), findsOneWidget);
      expect(find.text('Reuni'), findsWidgets);
      expect(find.text('Workshop'), findsWidgets);
      expect(lastQuery(app, '/events'), {'period': 'upcoming', 'limit': 20});
      expect(find.text('Camping Alumni KAPDH'), findsOneWidget);
      expect(find.text('Selasa, 20 Okt 2026'), findsWidgets);
      expect(find.textContaining('Pendaftaran Dibuka'), findsOneWidget);
      expect(find.textContaining('Pendaftaran Ditutup'), findsOneWidget);
      expect(find.text('Rp200.000'), findsOneWidget);
      expect(find.text('Gratis'), findsOneWidget);
      // Status tiket milik sendiri pada kartu.
      expect(find.textContaining('Terkonfirmasi'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Tiket Anda: Terkonfirmasi')), findsOneWidget);

      await tester.tap(find.text('Workshop').first);
      await settle(tester);
      expect(lastQuery(app, '/events')['category_id'], 'cat-workshop');
      expect(find.text('Camping Alumni KAPDH'), findsNothing);
      expect(find.text('Workshop Kewirausahaan'), findsOneWidget);

      await tester.tap(find.text('Workshop Kewirausahaan'));
      await settle(tester);
      expect(app.location, '/events/event-2');
    });

    testWidgets('F-09 cari event dan event lampau; hasil kosong menawarkan hapus filter', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events',
        push: false,
        routes: {
          '/event-categories': (_) => FakeResponse.json(200, _categories()),
          '/events': (options) => options.queryParameters.containsKey('q')
              ? FakeResponse.json(200, eventPageJson([]))
              : FakeResponse.json(200, eventPageJson([eventSummaryJson()])),
        },
      );
      await tester.enterText(find.byKey(const ValueKey('events-search')), '  pengajian ');
      await tester.pump(const Duration(milliseconds: 450));
      await settle(tester);
      expect(lastQuery(app, '/events')['q'], 'pengajian');
      expect(find.text('Event tidak ditemukan'), findsOneWidget);
      await tester.tap(find.text('Hapus filter'));
      await settle(tester);
      expect(lastQuery(app, '/events').containsKey('q'), isFalse);
      expect(find.text('Camping Alumni KAPDH'), findsOneWidget);

      await tester.tap(find.text('Lampau'));
      await settle(tester);
      expect(lastQuery(app, '/events')['period'], 'past');
    });

    testWidgets('AC F08-4/N-03 belum ada event: keadaan kosong; galat: coba lagi yang memulihkan', (tester) async {
      var fail = true;
      final app = await pumpMemberApp(
        tester,
        location: '/events',
        push: false,
        routes: {
          '/event-categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
          '/events': (_) => fail ? FakeResponse.network() : FakeResponse.json(200, eventPageJson([])),
        },
      );
      expect(find.byType(ErrorState), findsOneWidget);
      expect(find.text('Tidak ada koneksi'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Coba lagi'));
      await settle(tester);
      expect(find.text('Belum ada event mendatang'), findsOneWidget);
      // Tidak menjanjikan notifikasi event baru: API tidak mengirimnya saat event diterbitkan.
      expect(find.text('Event dari pengurus akan tampil di sini.'), findsOneWidget);
      // Tiket Saya selalu dapat dibuka dari tab Event.
      await tester.tap(find.byTooltip('Tiket Saya'));
      await settle(tester);
      expect(app.location, '/tickets');
    });
  });

  group('Detail Event (F-09, guideline hal. 8)', () {
    testWidgets(
      'F-09 cover, jadwal WIB, lokasi, kuota "20/36 Kuota Peserta", jendela, aturan D6, peserta, Daftar Sekarang',
      (tester) async {
        final app = await pumpMemberApp(tester, location: '/events/event-1', routes: _detailRoutes(eventDetailJson()));
        expect(find.text('Detail Event'), findsOneWidget);
        expect(find.bySemanticsLabel('Cover event Camping Alumni KAPDH'), findsOneWidget);
        expect(find.text('Camping Alumni KAPDH'), findsOneWidget);
        expect(find.textContaining('mempererat silaturahmi'), findsOneWidget);
        expect(find.text('Selasa, 20 Okt 2026 · 09.00–15.00 WIB'), findsOneWidget);
        expect(find.textContaining('Bumi Perkemahan Cibubur'), findsOneWidget);
        expect(find.byKey(const ValueKey('event-quota')), findsOneWidget);
        expect(find.text('20/36'), findsOneWidget);
        expect(find.text('Kuota Peserta'), findsOneWidget);
        expect(find.bySemanticsLabel('Kuota peserta: 20 kursi tersedia dari 36'), findsOneWidget);
        expect(_button(tester, 'event-reserve').label, 'Daftar Sekarang');
        expect(_button(tester, 'event-reserve').onPressed, isNotNull);

        await scrollUntil(tester, find.textContaining('(H-3) untuk refund penuh'));
        expect(find.text('Pembatalan dan refund'), findsOneWidget);
        await scrollUntil(tester, find.text('Peserta (16)'));
        await scrollUntil(tester, find.text('Siti Aminah'));
        expect(find.text('Ahmad Yusiana'), findsOneWidget);
        expect(find.text('#KAPDH01'), findsOneWidget);
        await tester.tap(find.text('Ahmad Yusiana'));
        await settle(tester);
        expect(app.location, '/network/members/user-2');
      },
    );

    testWidgets('PRD 5.2, 5.4, N-09: foto peserta (URL bertanda tangan) dimuat di memori saja, tidak lewat cache disk '
        'gambar publik yang bertahan setelah logout', (tester) async {
      const avatar = 'https://api.kapdh.or.id/api/v1/files/content/token-avatar-ahmad';
      await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/events/event-1/participants': (_) => FakeResponse.json(
              200,
              eventPageJson([
                {...participantJson(), 'avatar_url': avatar},
                participantJson(userId: 'user-3', fullName: 'Siti Aminah', cohort: 2),
              ]),
            ),
          },
        ),
      );
      await scrollUntil(tester, find.text('Siti Aminah'));
      expect(find.text('Ahmad Yusiana'), findsOneWidget);
      // Cover event publik tetap lewat RemoteImage (cache disk untuk Beranda offline, AC F08-4) ...
      expect(requestedImages, contains('https://files.kapdh.or.id/events/event-1.jpg'));
      // ... tetapi foto anggota lain tidak pernah masuk pembuat gambar ber-cache disk.
      expect(requestedImages, isNot(contains(avatar)));
      final images = tester.widgetList<Image>(find.byType(Image)).map((image) => image.image);
      expect(images.whereType<NetworkImage>().map((provider) => provider.url), contains(avatar));
      // Peserta tanpa foto memakai inisial.
      expect(find.text('SA'), findsOneWidget);
    });

    testWidgets('N-03 memuat: kerangka daftar dan detail event selagi request berjalan', (tester) async {
      final list = Completer<FakeResponse>();
      final detail = Completer<FakeResponse>();
      await pumpMemberApp(
        tester,
        settled: false,
        location: '/events',
        push: false,
        routes: {
          '/event-categories': (_) => FakeResponse.json(200, _categories()),
          '/events': (_) => list.future,
          '/events/event-1': (_) => detail.future,
          '/events/event-1/participants': _participants,
        },
      );
      expect(find.bySemanticsLabel('Memuat event'), findsOneWidget);
      list.complete(FakeResponse.json(200, eventPageJson([eventSummaryJson()])));
      await settle(tester);
      await tester.tap(find.text('Camping Alumni KAPDH'));
      await pumpFrames(tester, count: 10);
      expect(find.bySemanticsLabel('Memuat event'), findsOneWidget);
      // Tombol daftar baru muncul setelah server menentukan `can_reserve`.
      expect(find.byKey(const ValueKey('event-reserve')), findsNothing);
      detail.complete(FakeResponse.json(200, eventDetailJson()));
      await settle(tester);
      expect(find.byKey(const ValueKey('event-reserve')), findsOneWidget);
    });

    testWidgets('PRD 4.5 muat ulang gagal: detail terakhir tetap tampil dengan penjelasan dan coba lagi', (
      tester,
    ) async {
      var online = true;
      await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/events/event-1': (_) => online ? FakeResponse.json(200, eventDetailJson()) : FakeResponse.network(),
          },
        ),
      );
      online = false;
      await tester.drag(find.byKey(const ValueKey('event-detail')), const Offset(0, 400));
      await settle(tester);
      expect(find.byKey(const ValueKey('refresh-failed')), findsOneWidget);
      expect(find.text('Camping Alumni KAPDH'), findsOneWidget);
      online = true;
      await tester.tap(find.widgetWithText(TextButton, 'Coba lagi'));
      await settle(tester);
      expect(find.byKey(const ValueKey('refresh-failed')), findsNothing);
    });

    testWidgets('PRD 3.8 tautan peta lokasi ditandai tautan luar dan dikonfirmasi', (tester) async {
      final app = await pumpMemberApp(tester, location: '/events/event-1', routes: _detailRoutes(eventDetailJson()));
      await scrollUntil(tester, find.text('Buka peta lokasi (tautan luar)'));
      await tester.tap(find.text('Buka peta lokasi (tautan luar)'));
      await settle(tester);
      expect(find.text('Buka tautan luar?'), findsOneWidget);
      await tester.tap(find.text('Buka'));
      await settle(tester);
      expect(app.launched, [Uri.parse('https://maps.example.com/cibubur')]);
    });

    testWidgets('AC F13-3 event tidak ditemukan (404): pesan dan kembali ke daftar event', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-x',
        routes: {
          '/events/event-x': (_) => FakeResponse.json(404, errorJson('NOT_FOUND', 'Data tidak ditemukan.')),
          '/events': (_) => FakeResponse.json(200, eventPageJson([])),
          '/event-categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
        },
      );
      expect(find.text('Event tidak tersedia'), findsOneWidget);
      await tester.tap(find.text('Lihat event lain'));
      await settle(tester);
      expect(app.location, '/events');
    });

    testWidgets('AC F09-1 alasan server: belum dibuka, kuota penuh dan sudah punya tiket (tombol buka tiket)', (
      tester,
    ) async {
      var detail = eventDetailJson(
        registrationState: 'not_yet_open',
        canReserve: false,
        blockedReason: 'not_yet_open',
        registrationOpensAt: DateTime.utc(2026, 10, 14, 1),
      );
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: {
          '/events/event-1': (_) => FakeResponse.json(200, detail),
          '/events/event-1/participants': _participants,
          '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson()),
        },
      );
      expect(_button(tester, 'event-reserve-disabled').label, 'Pendaftaran Belum Dibuka');
      expect(_button(tester, 'event-reserve-disabled').onPressed, isNull);
      expect(find.text('Pendaftaran dibuka 14 Okt 2026, 08.00 WIB.'), findsOneWidget);

      detail = eventDetailJson(
        registrationState: 'sold_out',
        seatsAvailable: 0,
        canReserve: false,
        blockedReason: 'sold_out',
      );
      await tester.drag(find.byKey(const ValueKey('event-detail')), const Offset(0, 400));
      await settle(tester);
      expect(_button(tester, 'event-reserve-disabled').label, 'Kuota Penuh');
      expect(find.text('0/36'), findsOneWidget);
      expect(find.textContaining('Kursi dapat tersedia kembali'), findsOneWidget);

      detail = eventDetailJson(canReserve: false, blockedReason: 'has_active_ticket', myTicket: ticketSummaryJson());
      await tester.drag(find.byKey(const ValueKey('event-detail')), const Offset(0, 400));
      await settle(tester);
      await scrollUntil(tester, find.text('Tiket Anda'));
      await tester.tap(find.byKey(const ValueKey('event-open-ticket')));
      await settle(tester);
      expect(app.location, '/tickets/ticket-1');
    });

    testWidgets('AC F09-7 event dibatalkan: alasan, QR tidak berlaku, refund penuh, pendaftaran tertutup', (
      tester,
    ) async {
      await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(
            status: 'cancelled',
            registrationState: 'cancelled',
            canReserve: false,
            blockedReason: 'cancelled',
            cancelReason: 'Cuaca buruk',
          ),
        ),
      );
      expect(find.text('Event dibatalkan'), findsOneWidget);
      expect(find.textContaining('Alasan: Cuaca buruk.'), findsOneWidget);
      expect(find.textContaining('Seluruh QR tiket tidak berlaku'), findsOneWidget);
      expect(_button(tester, 'event-reserve-disabled').label, 'Event Dibatalkan');
    });

    testWidgets('PRD 4.5 pemeliharaan: Daftar Sekarang ditunda dengan penjelasan', (tester) async {
      final app = await pumpMemberApp(
        tester,
        config: publicConfigJson(maintenance: true),
        routes: _detailRoutes(eventDetailJson()),
      );
      expect(app.location, '/maintenance');
      app.router.go('/events/event-1');
      await settle(tester);
      expect(app.location, '/events/event-1');
      expect(_button(tester, 'event-reserve').onPressed, isNull);
      expect(find.textContaining('Pendaftaran ditunda selama pemeliharaan'), findsOneWidget);
    });
  });

  group('Reservasi satu kursi (F-09, AC F09-1, F09-3)', () {
    testWidgets('AC F09-3 event gratis: konfirmasi lalu tiket langsung paid dengan QR, tanpa metode bayar', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(price: '0.00'),
          extra: {
            '/events/event-1/reservations': (_) =>
                FakeResponse.json(201, ticketDetailJson(total: '0.00', qrCode: 'qr-gratis')),
            '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson(total: '0.00', qrCode: 'qr-gratis')),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      expect(find.text('Daftar event gratis?'), findsOneWidget);
      expect(find.textContaining('Satu tiket untuk Anda sendiri'), findsOneWidget);
      await tester.tap(find.text('Daftar'));
      await settle(tester);

      final request = app.adapter.requestsTo('/events/event-1/reservations').single;
      expect(request.method, 'POST');
      expect(request.data, {'expected_price': '0.00'});
      expect(request.headers['Idempotency-Key'], isNotEmpty);
      expect(app.location, '/tickets/ticket-1');
      expect(find.text('Pendaftaran berhasil. Tiket Anda sudah terbit.'), findsOneWidget);
      expect(find.byKey(const ValueKey('ticket-qr')), findsOneWidget);
    });

    testWidgets('PRD 3.9 event berbayar: satu orang tanpa jumlah/tipe tiket; pilih metode lalu ke pembayaran bersama', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/events/event-1/reservations': (_) => FakeResponse.json(
              201,
              ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(hours: 24))),
            ),
            // Layar pembayaran bersama (F-04) yang dibuka sesudah reservasi.
            '/me/payments/payment-9': (_) =>
                FakeResponse.json(200, ticketPaymentDetailJson(holdExpiresAt: testNow.add(const Duration(hours: 24)))),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      expect(find.text('Konfirmasi Pendaftaran'), findsOneWidget);
      expect(find.textContaining('Satu tiket untuk Anda sendiri'), findsOneWidget);
      expect(find.text('Tiket untuk 1 orang (Anda sendiri)'), findsOneWidget);
      expect(find.textContaining('Jumlah'), findsNothing);
      expect(find.textContaining('Tipe Tiket'), findsNothing);
      expect(find.text('Bank Syariah Indonesia'), findsOneWidget);
      expect(find.text('DANA'), findsOneWidget);
      // Metode wajib dipilih lebih dahulu.
      expect(_button(tester, 'reservation-submit').onPressed, isNull);

      await tester.tap(find.byKey(const ValueKey('method-method-bsi')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await settle(tester);

      final request = app.adapter.requestsTo('/events/event-1/reservations').single;
      expect(request.data, {'expected_price': '200000.00', 'payment_method_id': 'method-bsi'});
      expect(app.location, '/payments/payment-9');
      expect(find.textContaining('Kursi Anda ditahan sampai 13 Okt 2026, 14.00 WIB'), findsOneWidget);
      // Kembali ke detail event: kuota dan tombol mengikuti keadaan server terbaru.
      expect(app.adapter.requestsTo('/events/event-1').length, greaterThanOrEqualTo(2));

      // Serah terima ke pembayaran bersama (F-04): instruksi tiket dengan batas kirim bukti dan unggah bukti aktif.
      expect(app.adapter.requestsTo('/me/payments/payment-9'), isNotEmpty);
      expect(find.byType(ErrorState), findsNothing);
      expect(find.text('Tiket Camping Alumni KAPDH'), findsWidgets);
      expect(find.textContaining('Kirim bukti sebelum 13 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(tester.widget<ProofUploadSection>(find.byType(ProofUploadSection)).onPick, isNotNull);
      expect(find.byKey(const ValueKey('proof-submit')), findsOneWidget);
    });

    testWidgets('AC F09-1 kuota habis saat mendaftar (409 EVENT_SOLD_OUT): alasan dijelaskan, detail diperbarui', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/events/event-1/reservations': (_) => FakeResponse.json(
              409,
              errorJson(
                'EVENT_SOLD_OUT',
                'Kuota event sudah penuh.',
                current: eventDetailJson(
                  registrationState: 'sold_out',
                  seatsAvailable: 0,
                  canReserve: false,
                  blockedReason: 'sold_out',
                ),
              ),
            ),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('method-method-bsi')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await settle(tester);
      expect(find.text('Kuota penuh'), findsOneWidget);
      expect(find.textContaining('Kuota event sudah penuh.'), findsOneWidget);
      await tester.tap(find.text('Tutup'));
      await settle(tester);
      // Tidak ada hold: tetap di konfirmasi dengan alasan dari server, kembali ke detail yang sudah diperbarui.
      await scrollUntil(tester, find.textContaining('Pendaftaran tidak dapat dilanjutkan: Kuota Penuh'));
      expect(_button(tester, 'reservation-submit').onPressed, isNull);
      await tester.tap(find.byTooltip('Kembali'));
      await settle(tester);
      expect(app.location, '/events/event-1');
      expect(find.text('0/36'), findsOneWidget);
      expect(_button(tester, 'event-reserve-disabled').label, 'Kuota Penuh');
    });

    testWidgets('PRD 4.4 harga berubah (409 VERSION_CONFLICT): tanpa hold, harga baru dikonfirmasi lalu dikirim', (
      tester,
    ) async {
      var conflict = true;
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/events/event-1/reservations': (_) {
              if (conflict) {
                conflict = false;
                return FakeResponse.json(
                  409,
                  errorJson(
                    'VERSION_CONFLICT',
                    'Data berubah. Muat ulang.',
                    current: eventDetailJson(price: '250000.00'),
                  ),
                );
              }
              return FakeResponse.json(
                201,
                ticketDetailJson(
                  status: 'awaiting_payment',
                  total: '250000.00',
                  holdExpiresAt: testNow.add(const Duration(hours: 24)),
                ),
              );
            },
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('method-method-bsi')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await settle(tester);
      expect(find.text('Harga tiket berubah'), findsOneWidget);
      expect(find.text('Rp250.000'), findsWidgets);
      expect(_button(tester, 'reservation-submit').label, 'Setuju Harga Baru dan Daftar');

      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await settle(tester);
      final requests = app.adapter.requestsTo('/events/event-1/reservations');
      expect(requests, hasLength(2));
      expect((requests.last.data as Map)['expected_price'], '250000.00');
      // Payload berbeda memakai Idempotency-Key baru (PRD 4.3).
      expect(requests.last.headers['Idempotency-Key'], isNot(requests.first.headers['Idempotency-Key']));
      expect(app.location, '/payments/payment-9');
    });

    testWidgets('PRD 3.9 satu tiket aktif per event (409 has_active_ticket): tiket yang ada dibuka', (tester) async {
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(price: '0.00'),
          extra: {
            '/events/event-1/reservations': (_) => FakeResponse.json(
              409,
              errorJson(
                'VERSION_CONFLICT',
                'Anda sudah punya tiket aktif.',
                current: eventDetailJson(
                  price: '0.00',
                  canReserve: false,
                  blockedReason: 'has_active_ticket',
                  myTicket: ticketSummaryJson(total: '0.00'),
                ),
              ),
            ),
            '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson(total: '0.00')),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.text('Daftar'));
      await settle(tester);
      expect(app.location, '/tickets/ticket-1');
      expect(find.text('Anda sudah terdaftar di event ini. Tiket Anda dibuka.'), findsOneWidget);
    });

    testWidgets('PRD 4.3 jaringan putus: status diperiksa dulu, lalu kirim ulang memakai Idempotency-Key yang sama', (
      tester,
    ) async {
      var online = false;
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(price: '0.00'),
          extra: {
            '/events/event-1/reservations': (_) =>
                online ? FakeResponse.json(201, ticketDetailJson(total: '0.00')) : FakeResponse.network(),
            '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson(total: '0.00')),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.text('Daftar'));
      await settle(tester);
      expect(app.location, '/events/event-1');
      expect(find.textContaining('Anda tidak terdaftar dua kali'), findsOneWidget);
      // Detail event dimuat ulang untuk memeriksa apakah permintaan pertama sudah diproses.
      expect(app.adapter.requestsTo('/events/event-1').length, greaterThanOrEqualTo(2));

      online = true;
      await tester.tap(find.widgetWithText(SnackBarAction, 'Coba lagi'));
      await settle(tester);
      final requests = app.adapter.requestsTo('/events/event-1/reservations');
      expect(requests, hasLength(2));
      expect(requests.last.headers['Idempotency-Key'], requests.first.headers['Idempotency-Key']);
      expect(app.location, '/tickets/ticket-1');
    });

    testWidgets('PRD 4.5 jaringan putus tetapi tiket sudah tercatat: tiket dibuka tanpa kirim ulang', (tester) async {
      var reserved = false;
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: {
          '/events/event-1': (_) => FakeResponse.json(
            200,
            reserved
                ? eventDetailJson(
                    price: '0.00',
                    canReserve: false,
                    blockedReason: 'has_active_ticket',
                    myTicket: ticketSummaryJson(total: '0.00'),
                  )
                : eventDetailJson(price: '0.00'),
          ),
          '/events/event-1/participants': _participants,
          '/events/event-1/reservations': (_) {
            reserved = true;
            return FakeResponse.network();
          },
          '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson(total: '0.00')),
        },
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.text('Daftar'));
      await settle(tester);
      expect(app.adapter.requestsTo('/events/event-1/reservations'), hasLength(1));
      expect(app.location, '/tickets/ticket-1');
      expect(find.text('Pendaftaran Anda sudah tercatat. Tiket Anda dibuka.'), findsOneWidget);
    });

    testWidgets('PRD 4.5 metode bayar ditolak server (400): pesan di bawah pilihan metode, pilih ulang', (
      tester,
    ) async {
      await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/events/event-1/reservations': (_) => FakeResponse.json(
              400,
              errorJson(
                'VALIDATION_ERROR',
                'Periksa kembali isian Anda.',
                fieldErrors: {
                  'payment_method_id': ['Metode pembayaran sudah tidak aktif.'],
                },
              ),
            ),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('method-method-bsi')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await settle(tester);
      expect(find.text('Metode pembayaran sudah tidak aktif.'), findsOneWidget);
      expect(_button(tester, 'reservation-submit').onPressed, isNull);
    });

    testWidgets('ADR-026 metode QRIS: jenis tiap metode berlabel; QRIS terpilih menampilkan NMID dan merchant, '
        'gambarnya tampil di instruksi pembayaran sesudah reservasi', (tester) async {
      final hold = testNow.add(const Duration(hours: 24));
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(),
          extra: {
            '/payment-methods': (_) => FakeResponse.json(200, {
              'items': [
                paymentMethodJson(),
                paymentMethodJson(id: 'method-dana', kind: 'ewallet', provider: 'DANA', accountNumber: '081234567890'),
                qrisMethodJson(),
              ],
            }),
            '/events/event-1/reservations': (_) =>
                FakeResponse.json(201, ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: hold)),
            '/me/payments/payment-9': (_) =>
                FakeResponse.json(200, ticketPaymentDetailJson(holdExpiresAt: hold, method: qrisMethodJson())),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      expect(find.text('Transfer bank'), findsOneWidget);
      expect(find.text('E-wallet'), findsOneWidget);
      // Jenis tidak diulang di bawah metode yang bernama "QRIS".
      expect(find.text('QRIS'), findsOneWidget);
      expect(find.text('NMID: ID1020200012345'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('method-method-qris')));
      await settle(tester);
      expect(find.text('NMID: ID1020200012345'), findsOneWidget);
      expect(find.text('Merchant: KAPDH Pusat'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await settle(tester);

      final request = app.adapter.requestsTo('/events/event-1/reservations').single;
      expect(request.data, {'expected_price': '200000.00', 'payment_method_id': 'method-qris'});
      expect(app.location, '/payments/payment-9');
      expect(find.byType(QrisImageCard), findsOneWidget);
      expect(requestedImages, contains('https://api.kapdh.or.id/api/v1/files/public/file-qr-1'));
    });

    testWidgets('PRD 4.5 pendaftaran ditutup saat mengirim (409 RESERVATION_EXPIRED): alasan dari server', (
      tester,
    ) async {
      await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: _detailRoutes(
          eventDetailJson(price: '0.00'),
          extra: {
            '/events/event-1/reservations': (_) => FakeResponse.json(
              409,
              errorJson(
                'RESERVATION_EXPIRED',
                'Pendaftaran sudah ditutup.',
                current: eventDetailJson(
                  price: '0.00',
                  registrationState: 'closed',
                  canReserve: false,
                  blockedReason: 'closed',
                ),
              ),
            ),
          },
        ),
      );
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.text('Daftar'));
      await settle(tester);
      expect(find.text('Pendaftaran tidak dibuka'), findsOneWidget);
      expect(find.textContaining('Pendaftaran Ditutup.'), findsWidgets);
      await tester.tap(find.text('Tutup'));
      await settle(tester);
      expect(_button(tester, 'event-reserve-disabled').label, 'Pendaftaran Ditutup');
    });

    testWidgets('N-11 detail event dan konfirmasi pada teks 200 % tanpa meluap', (tester) async {
      await pumpMemberApp(tester, textScale: 2, location: '/events/event-1', routes: _detailRoutes(eventDetailJson()));
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      expect(find.text('Konfirmasi Pendaftaran'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('Reservasi saat layar ditinggalkan (PRD 4.3, 4.5)', () {
    Map<String, FakeHandler> paidRoutes(Completer<FakeResponse> pending) => _detailRoutes(
      eventDetailJson(),
      extra: {
        '/events/event-1/reservations': (_) => pending.future,
        '/home': (_) => FakeResponse.json(200, homeJson()),
        '/me/tickets': (_) => FakeResponse.json(200, ticketPageJson([])),
      },
    );

    FakeResponse paidHold() => FakeResponse.json(
      201,
      ticketDetailJson(status: 'awaiting_payment', holdExpiresAt: testNow.add(const Duration(hours: 24))),
    );

    Future<void> submitPaid(WidgetTester tester) async {
      await tester.tap(find.byKey(const ValueKey('event-reserve')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('method-method-bsi')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('reservation-submit')));
      await pumpFrames(tester, count: 5);
    }

    testWidgets('PRD 4.3 reservasi berbayar terkirim: konfirmasi tidak dapat ditinggalkan, hasil tetap ke pembayaran', (
      tester,
    ) async {
      final pending = Completer<FakeResponse>();
      final app = await pumpMemberApp(tester, location: '/events/event-1', routes: paidRoutes(pending));
      await submitPaid(tester);
      expect(_button(tester, 'reservation-submit').busy, isTrue);
      // Tombol kembali disembunyikan dan tombol/gestur kembali sistem ditahan selama request berjalan.
      expect(find.byTooltip('Kembali'), findsNothing);
      await _systemBack(tester);
      await pumpFrames(tester, count: 10);
      expect(find.text('Konfirmasi Pendaftaran'), findsOneWidget);

      pending.complete(paidHold());
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(app.location, '/payments/payment-9');
      expect(find.textContaining('Kursi Anda ditahan sampai 13 Okt 2026, 14.00 WIB'), findsOneWidget);
    });

    testWidgets(
      'PRD 4.5 konfirmasi dilepas router saat respons tiba: tanpa galat, hold diumumkan dengan tombol Bayar',
      (tester) async {
        final pending = Completer<FakeResponse>();
        final app = await pumpMemberApp(tester, location: '/events/event-1', routes: paidRoutes(pending));
        await submitPaid(tester);
        // Mis. anggota mengetuk notifikasi: router mengganti seluruh tumpukan selagi reservasi berjalan.
        app.router.go('/home');
        await settle(tester);
        expect(app.location, '/home');

        pending.complete(paidHold());
        await settle(tester);
        expect(tester.takeException(), isNull);
        expect(app.location, '/home');
        expect(find.textContaining('Kursi Anda ditahan sampai 13 Okt 2026, 14.00 WIB'), findsOneWidget);
        await tester.tap(find.widgetWithText(SnackBarAction, 'Bayar'));
        await settle(tester);
        expect(app.location, '/payments/payment-9');
      },
    );

    testWidgets('PRD 4.5 layar lain terbuka di atas konfirmasi saat respons tiba: detail event tidak ikut tertutup', (
      tester,
    ) async {
      final pending = Completer<FakeResponse>();
      final app = await pumpMemberApp(tester, location: '/events/event-1', routes: paidRoutes(pending));
      await submitPaid(tester);
      unawaited(app.router.push('/tickets'));
      await settle(tester);
      expect(app.location, '/tickets');

      pending.complete(paidHold());
      await settle(tester);
      expect(tester.takeException(), isNull);
      // Layar yang sedang dilihat tidak dipindahkan; hasil diumumkan.
      expect(app.location, '/tickets');
      expect(find.widgetWithText(SnackBarAction, 'Bayar'), findsOneWidget);
      // Konfirmasi yang usang dilepas; kembali tiba di detail event, bukan Beranda.
      await tester.tap(find.byTooltip('Kembali'));
      await settle(tester);
      expect(app.location, '/events/event-1');
      expect(find.text('Konfirmasi Pendaftaran'), findsNothing);
      expect(find.text('Detail Event'), findsOneWidget);
    });

    testWidgets(
      'PRD 4.5 event gratis: detail ditinggalkan selagi mendaftar, tiket terbit diumumkan dengan Lihat tiket',
      (tester) async {
        final pending = Completer<FakeResponse>();
        final app = await pumpMemberApp(
          tester,
          location: '/events/event-1',
          routes: _detailRoutes(
            eventDetailJson(price: '0.00'),
            extra: {
              '/events/event-1/reservations': (_) => pending.future,
              '/home': (_) => FakeResponse.json(200, homeJson()),
              '/me/tickets/ticket-1': (_) =>
                  FakeResponse.json(200, ticketDetailJson(total: '0.00', qrCode: 'qr-gratis')),
            },
          ),
        );
        await tester.tap(find.byKey(const ValueKey('event-reserve')));
        await settle(tester);
        await tester.tap(find.text('Daftar'));
        await pumpFrames(tester, count: 5);
        await tester.tap(find.byTooltip('Kembali'));
        await settle(tester);
        expect(app.location, '/home');

        pending.complete(FakeResponse.json(201, ticketDetailJson(total: '0.00', qrCode: 'qr-gratis')));
        await settle(tester);
        expect(tester.takeException(), isNull);
        expect(app.location, '/home');
        expect(find.text('Pendaftaran berhasil. Tiket Anda sudah terbit.'), findsOneWidget);
        await tester.tap(find.widgetWithText(SnackBarAction, 'Lihat tiket'));
        await settle(tester);
        expect(app.location, '/tickets/ticket-1');
        expect(find.byKey(const ValueKey('ticket-qr')), findsOneWidget);
      },
    );
  });

  group('Akses status (PRD 2.2, kontrak C5)', () {
    testWidgets(
      'PRD 2.2 anggota expired membuka detail event yang pernah dipesan dari tiketnya; tanpa peserta/daftar',
      (tester) async {
        final app = await pumpMemberApp(
          tester,
          status: 'expired',
          location: '/tickets/ticket-1',
          routes: {
            '/me/tickets/ticket-1': (_) => FakeResponse.json(200, ticketDetailJson()),
            '/events/event-1': (_) => FakeResponse.json(
              200,
              eventDetailJson(canReserve: false, blockedReason: 'membership_required', myTicket: ticketSummaryJson()),
            ),
          },
        );
        await scrollTo(tester, find.byKey(const ValueKey('ticket-open-event')));
        await tester.tap(find.byKey(const ValueKey('ticket-open-event')));
        await settle(tester);
        expect(app.location, '/events/event-1');
        expect(find.text('Detail Event'), findsOneWidget);
        expect(find.text('20/36'), findsOneWidget);
        // Peserta hanya untuk anggota aktif; tiket lunas tetap dapat dibuka.
        expect(app.adapter.requestsTo('/events/event-1/participants'), isEmpty);
        expect(find.byKey(const ValueKey('event-reserve')), findsNothing);
        await tester.tap(find.byKey(const ValueKey('event-open-ticket')));
        await settle(tester);
        expect(app.location, '/tickets/ticket-1');
      },
    );

    /// Anggota expired membuka deep link detail event dibatalkan yang tiketnya ia pegang (di atas daftar event).
    Future<AppHarness> openCancelledEventDeepLinkAsExpired(WidgetTester tester) async {
      final app = await pumpMemberApp(
        tester,
        status: 'expired',
        routes: {
          '/events/event-1': (_) => FakeResponse.json(
            200,
            eventDetailJson(
              status: 'cancelled',
              registrationState: 'cancelled',
              canReserve: false,
              blockedReason: 'membership_required',
              cancelReason: 'Cuaca buruk',
              myTicket: ticketSummaryJson(status: 'cancelled', eventStatus: 'cancelled'),
            ),
          ),
        },
      );
      app.router.go('/events/event-1');
      await settle(tester);
      return app;
    }

    testWidgets(
      'AC F09-7 anggota expired membuka deep link event dibatalkan: detail terbuka, bukan halaman perpanjang',
      (tester) async {
        final app = await openCancelledEventDeepLinkAsExpired(tester);
        expect(app.location, '/events/event-1');
        expect(find.text('Event dibatalkan'), findsOneWidget);
        expect(find.textContaining('Alasan: Cuaca buruk.'), findsOneWidget);

        // Kembali: daftar event tetap khusus anggota aktif (matriks rute), jadi anggota tiba di rute awal statusnya
        // tanpa request daftar event.
        await tester.tap(find.byTooltip('Kembali'));
        await settle(tester);
        expect(app.location, '/renewal');
        expect(app.adapter.requestsTo('/events'), isEmpty);
      },
    );

    testWidgets('AC F09-7, PRD 2.2: tombol kembali sistem dari deep link event juga melewati matriks rute (sama '
        'dengan panah kembali app bar)', (tester) async {
      final app = await openCancelledEventDeepLinkAsExpired(tester);
      expect(app.location, '/events/event-1');

      // Tombol kembali Android: WidgetsBinding -> BackButtonDispatcher router -> routerDelegate.popRoute().
      expect(await tester.binding.handlePopRoute(), isTrue);
      await settle(tester);
      expect(app.location, '/renewal');
      expect(app.adapter.requestsTo('/events'), isEmpty);
    });

    testWidgets('PRD 2.2 anggota expired tanpa tiket di event itu (403 MEMBERSHIP_REQUIRED): ajakan perpanjang', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        status: 'expired',
        location: '/events/event-9',
        routes: {
          '/events/event-9': (_) =>
              FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Fitur ini khusus anggota aktif.')),
        },
      );
      expect(app.location, '/events/event-9');
      expect(find.text('Event khusus anggota aktif'), findsOneWidget);
      expect(find.textContaining('Tiket yang sudah lunas tetap dapat dibuka di Tiket Saya.'), findsOneWidget);
      expect(find.byType(ErrorState), findsNothing);
      // Status diperiksa ulang ke server (ErrorUiAction.refreshStatus).
      expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
      await tester.tap(find.widgetWithText(KapdhButton, 'Perpanjang KTA'));
      await settle(tester);
      expect(app.location, '/renewal');
    });

    testWidgets(
      'PRD 2.2 anggota expired dengan tiket berakhir (membership_required): ajakan perpanjang, bukan daftar',
      (tester) async {
        final app = await pumpMemberApp(
          tester,
          status: 'expired',
          location: '/events/event-1',
          routes: {
            '/events/event-1': (_) => FakeResponse.json(
              200,
              eventDetailJson(
                canReserve: false,
                blockedReason: 'membership_required',
                myTicket: ticketSummaryJson(status: 'expired'),
              ),
            ),
          },
        );
        expect(find.byKey(const ValueKey('event-reserve')), findsNothing);
        expect(find.byKey(const ValueKey('event-open-ticket')), findsNothing);
        expect(find.text('Perpanjang KTA untuk mendaftar event baru.'), findsOneWidget);
        await tester.tap(find.widgetWithText(KapdhButton, 'Perpanjang KTA'));
        await settle(tester);
        expect(app.location, '/renewal');
      },
    );

    testWidgets('PRD 2.2 daftar event ditolak server (403 MEMBERSHIP_REQUIRED): /me dimuat ulang lalu dialihkan', (
      tester,
    ) async {
      var status = 'verified';
      final app = await pumpMemberApp(
        tester,
        location: '/events',
        push: false,
        routes: {
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/home': (_) => FakeResponse.json(200, homeJson()),
          '/event-categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
          '/events': (_) {
            status = 'expired';
            return FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Fitur ini khusus anggota aktif.'));
          },
        },
      );
      expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
      expect(app.location, '/renewal');
    });

    testWidgets('PRD 2.2 detail event ditolak ACCOUNT_SUSPENDED: /me dimuat ulang lalu ke portal pembatasan', (
      tester,
    ) async {
      var status = 'verified';
      final app = await pumpMemberApp(
        tester,
        location: '/events/event-1',
        routes: {
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/events/event-1': (_) {
            status = 'suspended';
            return FakeResponse.json(403, errorJson('ACCOUNT_SUSPENDED', 'Akun Anda sedang dibatasi.'));
          },
        },
      );
      expect(app.adapter.requestsTo('/me').length, greaterThanOrEqualTo(2));
      expect(app.location, '/restricted');
    });

    testWidgets('PRD 2.2 tab Event terkunci untuk anggota expired mengarahkan ke Tiket Saya, bukan menu Akun', (
      tester,
    ) async {
      final app = await pumpMemberApp(
        tester,
        status: 'expired',
        location: '/home',
        push: false,
        routes: {'/me/tickets': (_) => FakeResponse.json(200, ticketPageJson([]))},
      );
      final nav = find.byType(NavigationBar);
      await tester.tap(find.descendant(of: nav, matching: find.text('Jejaring')));
      await settle(tester);
      expect(find.text('Jejaring khusus anggota aktif'), findsOneWidget);
      expect(find.byKey(const ValueKey('locked-tab-tickets')), findsNothing);
      await tester.tap(find.text('Tutup'));
      await settle(tester);

      await tester.tap(find.descendant(of: nav, matching: find.text('Event')));
      await settle(tester);
      expect(find.text('Event khusus anggota aktif'), findsOneWidget);
      expect(find.textContaining('Tiket yang sudah lunas tetap dapat dibuka di Tiket Saya.'), findsOneWidget);
      expect(find.textContaining('menu Akun'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('locked-tab-tickets')));
      await settle(tester);
      expect(app.location, '/tickets');
    });
  });
}

/// Tombol/gestur kembali sistem Android (pesan `popRoute` platform).
Future<void> _systemBack(WidgetTester tester) async {
  final message = const JSONMethodCodec().encodeMethodCall(const MethodCall('popRoute'));
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage('flutter/navigation', message, (_) {});
}
