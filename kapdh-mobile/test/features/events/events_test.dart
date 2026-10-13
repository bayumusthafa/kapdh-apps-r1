import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
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

    testWidgets('event tidak ditemukan (404): pesan dan kembali ke daftar event', (tester) async {
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

    testWidgets('alasan server: belum dibuka, kuota penuh dan sudah punya tiket (tombol buka tiket)', (tester) async {
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

    testWidgets('metode bayar ditolak server (400): pesan di bawah pilihan metode, pilih ulang', (tester) async {
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

    testWidgets('pendaftaran ditutup saat mengirim (409 RESERVATION_EXPIRED): alasan dari server', (tester) async {
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
}
