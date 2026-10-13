import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/cache/kta_cache_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/payments/payment_updates.dart';
import 'package:kapdh_mobile/features/status/restricted_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../payments/payments_fixtures.dart';

const qrUrl = 'https://kapdh.or.id/kta/29.01.01.7#t=token-uji';

final expiresAt = DateTime.utc(2027, 10, 12, 7);

/// Membuka tab KTA untuk anggota berstatus [status]. [card] menjawab GET /me/card; [store] berisi cache awal;
/// [updates] meniru notifikasi realtime.
Future<AppHarness> openKta(
  WidgetTester tester, {
  String status = 'verified',
  DateTime? meExpiresAt,
  required FutureOr<FakeResponse> Function() card,
  Map<String, FakeHandler> routes = const {},
  MemorySecureStore? store,
  bool settleAfter = true,
  double textScale = 1,
  Stream<NotificationCreatedPayload>? updates,
}) async {
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    store: store,
    textScale: textScale,
    overrides: [realtimeNotificationsProvider.overrideWithValue(updates ?? const Stream.empty())],
    handler: apiRoutes({
      '/me': (_) => FakeResponse.json(200, meJson(status: status, expiresAt: meExpiresAt)),
      '/me/card': (_) => card(),
      '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      ...routes,
    }),
  );
  app.router.go('/kta');
  if (settleAfter) {
    await settle(tester);
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }
  return app;
}

KtaCardData shownCard(WidgetTester tester) => tester.widget<KtaCard>(find.byType(KtaCard)).data;

Finder buttonLabelled(String label) => find.widgetWithText(KapdhButton, label);

/// Cache KTA tersimpan untuk user-1 (sinkronisasi terakhir [syncedAt]).
Future<MemorySecureStore> cachedStore(DateTime syncedAt, {String userId = 'user-1'}) async {
  final store = MemorySecureStore();
  await KtaCacheStore(store).save(
    userId: userId,
    card: cardOf(expiresAt: expiresAt, syncedAt: syncedAt),
  );
  return store;
}

void main() {
  group('KTA online (prototipe layar 6; guideline hal. 6)', () {
    testWidgets('AC F05-1: KTA Tidak Aktif: nomor anggota, QR tertutup, ajakan Bayar ke Biaya KTA dan fitur terkunci', (
      tester,
    ) async {
      final app = await openKta(
        tester,
        status: 'unverified',
        card: () => FakeResponse.json(200, memberCardJson(status: 'inactive', withQr: false)),
      );

      expect(app.location, '/kta');
      expect(find.text('Kartu Tanda Anggota'), findsOneWidget);
      final card = shownCard(tester);
      expect(card.memberNumber, '29.01.01.7');
      expect(card.cohortCode, 'KAPDH 29');
      expect(card.subtitle, 'Angkatan 29 | Guru Bahasa Arab');
      expect(card.city, 'Pekanbaru');
      expect(card.qrData, isNull);
      expect(find.byKey(const ValueKey('kta-qr-placeholder')), findsOneWidget);
      expect(find.text('QR muncul setelah KTA aktif'), findsOneWidget);
      expect(find.text('Berlaku sampai: belum aktif'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: KTA Tidak Aktif'), findsOneWidget);
      expect(find.text('Selesaikan iuran pendaftaran untuk mengaktifkan KTA dan fitur alumni.'), findsOneWidget);
      expect(find.text('Terbuka setelah KTA aktif'), findsOneWidget);
      expect(find.text('Jejaring alumni dan chat'), findsOneWidget);
      expect(find.byKey(const ValueKey('kta-brightness-tip')), findsNothing);

      await tester.tap(buttonLabelled('Bayar'));
      await settle(tester);
      expect(app.location, '/onboarding/fees');
    });

    testWidgets('AC F05-1: iuran pendaftaran sedang diproses: Lanjutkan membuka status pembayaran', (tester) async {
      final app = await openKta(
        tester,
        status: 'unverified',
        card: () => FakeResponse.json(200, {
          ...memberCardJson(status: 'inactive', withQr: false),
          'action': 'continue_payment',
          'open_payment_id': 'pay-1',
        }),
        routes: {
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingReviewJson()),
          '/me/membership': (_) => FakeResponse.json(200, membershipJson()),
        },
      );

      expect(find.text('Iuran pendaftaran sedang diproses. Lihat status pembayaran Anda.'), findsOneWidget);
      await tester.tap(buttonLabelled('Lanjutkan'));
      await settle(tester);
      expect(app.location, '/payments/pay-1');
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
    });

    testWidgets('AC F05-1, PRD 4.1: iuran pendaftaran disetujui (notifikasi realtime): kartu menjadi Aktif dengan QR '
        'dan nomor yang sama', (tester) async {
      final updates = StreamController<NotificationCreatedPayload>.broadcast();
      addTearDown(updates.close);
      var paid = false;
      final app = await openKta(
        tester,
        status: 'unverified',
        updates: updates.stream,
        card: () => FakeResponse.json(
          200,
          paid ? memberCardJson(expiresAt: expiresAt) : memberCardJson(status: 'inactive', withQr: false),
        ),
        routes: {'/me': (_) => FakeResponse.json(200, meJson(status: paid ? 'verified' : 'unverified'))},
      );
      expect(shownCard(tester).qrData, isNull);
      expect(find.byTooltip('Event, terkunci'), findsOneWidget);

      paid = true;
      updates.add(notificationOf('membership', title: 'KTA Anda aktif'));
      await settle(tester);

      expect(app.location, '/kta');
      expect(shownCard(tester).qrData, qrUrl);
      expect(shownCard(tester).memberNumber, '29.01.01.7');
      expect(find.bySemanticsLabel('Status: KTA Aktif'), findsOneWidget);
      // Status sesi ikut diperbarui sehingga tab Event dan Jejaring terbuka (PRD 2.2).
      expect(find.byTooltip('Event, terkunci'), findsNothing);
    });

    testWidgets('AC F05-1, AC F07-5: KTA Aktif: QR dari qr.url, waktu sinkron, tips kecerahan; Perpanjang nonaktif '
        'sebelum jendela dibuka', (tester) async {
      await openKta(tester, card: () => FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)));

      final card = shownCard(tester);
      expect(card.qrData, qrUrl);
      expect(find.byKey(const ValueKey('kta-qr')), findsOneWidget);
      expect(find.text('Berlaku sampai 12/10/2027'), findsOneWidget);
      expect(find.text('Tersinkron 12 Okt 2026, 14.00 WIB'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: KTA Aktif'), findsOneWidget);
      expect(find.text('Seluruh fitur alumni aktif. Perpanjangan dibuka mulai 12 Sep 2027.'), findsOneWidget);
      expect(tester.widget<KapdhButton>(buttonLabelled('Perpanjang')).onPressed, isNull);
      expect(find.byKey(const ValueKey('kta-brightness-tip')), findsOneWidget);
      expect(find.textContaining('Naikkan kecerahan layar'), findsOneWidget);
      // Bukan tampilan cache: tidak ada pita Offline.
      expect(find.textContaining('Offline'), findsNothing);
    });

    testWidgets('AC F07-5: jendela perpanjangan terbuka (Segera Berakhir): Perpanjang membuka layar perpanjangan', (
      tester,
    ) async {
      final soon = testNow.add(const Duration(days: 20));
      final app = await openKta(
        tester,
        status: 'expiring',
        meExpiresAt: soon,
        card: () => FakeResponse.json(200, memberCardJson(status: 'expiring', expiresAt: soon)),
        routes: {
          '/me/membership': (_) => FakeResponse.json(
            200,
            membershipJson(status: 'expiring', startsAt: testNow, expiresAt: soon, renewalEligible: true),
          ),
          '/me/fees': (_) => FakeResponse.json(200, feesJson(renewal: feeQuoteJson(type: 'renewal'))),
        },
      );

      expect(find.bySemanticsLabel('Status: Segera Berakhir'), findsOneWidget);
      expect(find.textContaining('Masa aktif berakhir 1 Nov 2026'), findsOneWidget);
      expect(shownCard(tester).qrData, qrUrl);
      await tester.tap(buttonLabelled('Perpanjang'));
      await settle(tester);
      expect(app.location, '/renewal');
    });

    testWidgets('AC F07-2, AC F07-5: KTA kedaluwarsa: QR tidak tampil, jendela perpanjangan tetap terbuka', (
      tester,
    ) async {
      final past = testNow.subtract(const Duration(days: 3));
      final app = await openKta(
        tester,
        status: 'expired',
        meExpiresAt: past,
        card: () => FakeResponse.json(200, memberCardJson(status: 'expired', expiresAt: past, withQr: false)),
        routes: {
          '/me/membership': (_) =>
              FakeResponse.json(200, membershipJson(status: 'expired', expiresAt: past, renewalEligible: true)),
          '/me/fees': (_) => FakeResponse.json(200, feesJson(renewal: feeQuoteJson(type: 'renewal'))),
        },
      );

      expect(app.location, '/kta');
      expect(find.bySemanticsLabel('Status: KTA Kedaluwarsa'), findsOneWidget);
      expect(shownCard(tester).qrData, isNull);
      expect(find.text('QR aktif kembali setelah perpanjangan'), findsOneWidget);
      expect(find.text('Berakhir 09/10/2026'), findsOneWidget);
      expect(find.byKey(const ValueKey('kta-brightness-tip')), findsNothing);
      await tester.tap(buttonLabelled('Perpanjang'));
      await settle(tester);
      expect(app.location, '/renewal');
    });

    testWidgets('AC F05-5: sinkron ulang setelah perpanjangan: nomor tetap dan masa berlaku mengikuti periode baru', (
      tester,
    ) async {
      var expiry = expiresAt;
      await openKta(tester, card: () => FakeResponse.json(200, memberCardJson(expiresAt: expiry)));
      expect(find.text('Berlaku sampai 12/10/2027'), findsOneWidget);

      expiry = DateTime.utc(2028, 10, 12, 7);
      await tester.tap(find.byTooltip('Sinkronkan KTA'));
      await settle(tester);

      expect(find.text('Berlaku sampai 12/10/2028'), findsOneWidget);
      expect(shownCard(tester).memberNumber, '29.01.01.7');
    });

    testWidgets('AC F05-4: kartu dibatasi dari server: sesi dimuat ulang dan anggota diarahkan ke portal pembatasan', (
      tester,
    ) async {
      var status = 'verified';
      final store = MemorySecureStore();
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        store: store,
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: status)),
          '/me/card': (_) {
            status = 'suspended';
            return FakeResponse.json(200, memberCardJson(status: 'suspended', expiresAt: expiresAt, withQr: false));
          },
        }),
      );
      app.router.go('/kta');
      await settle(tester);

      expect(app.location, '/restricted');
      expect(find.byType(RestrictedScreen), findsOneWidget);
      // Cache aktif lama digantikan kartu dibatasi: tidak pernah tampil aktif lagi secara offline.
      final cached = await KtaCacheStore(store).read(userId: 'user-1');
      expect((cached as KtaCacheMiss).reason, KtaCacheMissReason.restricted);
    });
  });

  group('KTA offline (prototipe layar 7; AC F05-2..F05-4)', () {
    testWidgets(
      'AC F05-2: cache tersinkron <= 7 hari: label Offline dan waktu sinkron, QR, Sinkronkan kembali online',
      (tester) async {
        var online = false;
        final store = await cachedStore(testNow.subtract(const Duration(days: 1)));
        await openKta(
          tester,
          store: store,
          card: () => online ? FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)) : FakeResponse.network(),
        );

        expect(find.text('Offline. Tersinkron 11 Okt 2026, 14.00 WIB'), findsOneWidget);
        expect(shownCard(tester).qrData, qrUrl);
        expect(find.text('Status dari sinkronisasi terakhir.'), findsOneWidget);
        expect(find.bySemanticsLabel('Status: KTA Aktif'), findsOneWidget);
        expect(find.byKey(const ValueKey('kta-offline-rule')), findsOneWidget);
        expect(
          find.text(
            'Kartu offline tetap bisa ditunjukkan sampai 7 hari sejak sinkronisasi terakhir. Status terkini selalu '
            'dicek saat pemeriksa memindai QR.',
          ),
          findsOneWidget,
        );

        online = true;
        await tester.tap(buttonLabelled('Sinkronkan'));
        await settle(tester);

        expect(find.textContaining('Offline'), findsNothing);
        expect(find.text('Tersinkron 12 Okt 2026, 14.00 WIB'), findsOneWidget);
      },
    );

    testWidgets('AC F05-3: cache lebih dari 7 hari: kartu tidak tampil dan pengguna diminta sinkron', (tester) async {
      final store = await cachedStore(testNow.subtract(const Duration(days: 8)));
      await openKta(tester, store: store, card: FakeResponse.network);

      expect(find.byKey(const ValueKey('kta-offline-unavailable')), findsOneWidget);
      expect(find.text('Kartu offline perlu disinkronkan'), findsOneWidget);
      expect(find.byType(KtaCard), findsNothing);
      expect(find.text('Sinkronkan'), findsOneWidget);
      expect(store.values.containsKey(KtaCacheStore.storageKey), isFalse);
    });

    testWidgets('AC F05-3: perubahan akun: cache akun lain tidak tampil', (tester) async {
      final store = await cachedStore(testNow.subtract(const Duration(hours: 2)), userId: 'user-lain');
      await openKta(tester, store: store, card: FakeResponse.network);

      expect(find.text('KTA belum tersimpan di perangkat ini'), findsOneWidget);
      expect(find.byType(KtaCard), findsNothing);
    });

    testWidgets('AC F05-3: belum pernah tersinkron lalu kembali online: Sinkronkan menampilkan kartu', (tester) async {
      var online = false;
      await openKta(
        tester,
        card: () => online ? FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)) : FakeResponse.network(),
      );
      expect(find.text('KTA belum tersimpan di perangkat ini'), findsOneWidget);

      online = true;
      await tester.tap(find.text('Sinkronkan'));
      await settle(tester);

      expect(shownCard(tester).qrData, qrUrl);
    });
  });

  group('Keadaan layar KTA', () {
    testWidgets('PRD 4.5: memuat: kerangka pemuatan', (tester) async {
      final pending = Completer<FakeResponse>();
      await openKta(tester, card: () => pending.future, settleAfter: false);

      expect(find.bySemanticsLabel('Memuat KTA'), findsOneWidget);
      pending.complete(FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)));
      await settle(tester);
      expect(find.byType(KtaCard), findsOneWidget);
    });

    testWidgets('PRD 4.5: server menjawab galat (bukan jaringan): pesan galat tanpa kartu cache', (tester) async {
      final store = await cachedStore(testNow.subtract(const Duration(hours: 1)));
      await openKta(tester, store: store, card: () => FakeResponse.json(403, errorJson('FORBIDDEN', 'Akses ditolak.')));

      expect(find.text('Akses ditolak.'), findsOneWidget);
      expect(find.byType(KtaCard), findsNothing);
    });

    testWidgets('N-11: teks 200 % pada KTA aktif tanpa meluap', (tester) async {
      await openKta(tester, textScale: 2, card: () => FakeResponse.json(200, memberCardJson(expiresAt: expiresAt)));

      expect(tester.takeException(), isNull);
      expect(find.byType(KtaCard), findsOneWidget);
    });

    testWidgets('N-11: teks 200 % pada KTA Tidak Aktif tanpa meluap', (tester) async {
      await openKta(
        tester,
        status: 'unverified',
        textScale: 2,
        card: () => FakeResponse.json(200, memberCardJson(status: 'inactive', withQr: false)),
      );

      expect(tester.takeException(), isNull);
      await tester.dragUntilVisible(
        find.text('Terbuka setelah KTA aktif'),
        find.byType(ListView).first,
        const Offset(0, -300),
      );
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(find.text('Pendaftaran event dan tiket'), findsOneWidget);
    });
  });
}
