import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/api/idempotency_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/features/payments/payment_presentation.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'payments_fixtures.dart';

/// Membuka `/payments/new/<type>` (rute mutasi pembuatan instruksi iuran, ARCHITECTURE §8.4).
Future<AppHarness> openNew(
  WidgetTester tester,
  Map<String, FakeHandler> routes, {
  String type = 'registration',
  String status = 'unverified',
  MemorySecureStore? store,
}) async {
  final create = routes['/me/payments'];
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    store: store,
    handler: apiRoutes({
      '/me': (_) => FakeResponse.json(200, meJson(status: status)),
      '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      '/me/membership': (_) => FakeResponse.json(200, membershipJson(status: status)),
      '/payment-methods': (_) => FakeResponse.json(200, methodsJson()),
      '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson(type: type)),
      ...routes,
      // Riwayat (rute induk /payments ikut dibangun go_router) kosong; POST = pembuatan instruksi.
      '/me/payments': (options) => options.method == 'POST' && create != null
          ? create(options)
          : FakeResponse.json(200, {'items': <Object?>[], 'next_cursor': null}),
    }),
  );
  await useTallScreen(tester);
  app.router.go('/payments/new/$type');
  await settle(tester);
  return app;
}

List<String?> createKeys(AppHarness app) =>
    app.adapter.requestsTo('/me/payments').where((r) => r.method == 'POST').map(idempotencyKeyOf).toList();

void main() {
  testWidgets('AC F03-1: instruksi iuran dibuat server dengan rekening aktif pertama dan Idempotency-Key, lalu layar '
      'instruksi menggantikan rute pembuatan', (tester) async {
    final app = await openNew(tester, {'/me/payments': (_) => FakeResponse.json(201, awaitingTransferJson())});

    final create = app.adapter.requestsTo('/me/payments').where((r) => r.method == 'POST').single;
    expect(create.method, 'POST');
    expect(bodyOf(create), {'type': 'registration', 'payment_method_id': 'method-1'});
    expect(idempotencyKeyOf(create), isNotEmpty);
    expect(app.location, '/payments/pay-1');
    expect(find.text('Transfer tepat sebesar'), findsOneWidget);
    // Hasil pasti: key tidak disimpan lagi sehingga instruksi berikutnya memakai key baru.
    expect(find.byKey(const ValueKey('create-checking-status')), findsNothing);
  });

  testWidgets('AC F03-1: payment terbuka sudah ada: dibuka tanpa POST (satu payment nonterminal per jenis)', (
    tester,
  ) async {
    final app = await openNew(tester, {
      '/me/fees': (_) => FakeResponse.json(
        200,
        feesJson(
          registration: feeQuoteJson(type: 'registration', openPaymentId: 'pay-1'),
        ),
      ),
    });

    expect(createKeys(app), isEmpty);
    expect(app.location, '/payments/pay-1');
  });

  testWidgets('PRD 4.5, AC F03-4: jaringan putus saat membuat instruksi: status diperiksa lebih dahulu dan payment '
      'yang ternyata sudah dibuat dibuka tanpa POST kedua', (tester) async {
    var created = false;
    final app = await openNew(tester, {
      '/me/payments': (_) {
        created = true;
        return FakeResponse.network();
      },
      '/me/fees': (_) => FakeResponse.json(
        200,
        feesJson(
          registration: feeQuoteJson(type: 'registration', openPaymentId: created ? 'pay-1' : null),
        ),
      ),
    });

    expect(createKeys(app), hasLength(1));
    expect(app.location, '/payments/pay-1');
  });

  testWidgets('PRD 4.5, AC F03-4: belum tercatat di server: POST diulang dengan Idempotency-Key yang sama', (
    tester,
  ) async {
    var attempts = 0;
    final app = await openNew(tester, {
      '/me/payments': (_) {
        attempts++;
        return attempts == 1 ? FakeResponse.network() : FakeResponse.json(201, awaitingTransferJson());
      },
    });

    final keys = createKeys(app);
    expect(keys, hasLength(2));
    expect(keys.toSet(), hasLength(1));
    expect(app.location, '/payments/pay-1');
  });

  testWidgets('PRD 4.5, AC F03-4: masih offline: "Memeriksa status" tanpa ajakan transfer, key tersimpan, lalu '
      'Periksa status menyelesaikan dengan key yang sama', (tester) async {
    var online = false;
    var posted = false;
    final store = MemorySecureStore();
    final app = await openNew(store: store, tester, {
      '/me/payments': (_) {
        posted = true;
        return online ? FakeResponse.json(201, awaitingTransferJson()) : FakeResponse.network();
      },
      '/me/fees': (_) {
        // Pemuatan awal berhasil; pemeriksaan status setelah POST terputus masih offline.
        if (!online && posted) return FakeResponse.network();
        return FakeResponse.json(200, feesJson());
      },
    });

    expect(find.byKey(const ValueKey('create-checking-status')), findsOneWidget);
    expect(find.text('Memeriksa status'), findsOneWidget);
    expect(find.textContaining('Jangan transfer dulu'), findsOneWidget);
    expect(find.textContaining('instruksi tidak akan dibuat ganda'), findsOneWidget);
    expect(app.location, '/payments/new/registration');
    // Key disimpan di secure storage sampai hasilnya diketahui (bertahan bila aplikasi ditutup).
    expect(store.values[IdempotencyStore.storageKey], contains('payment.create.registration'));

    online = true;
    await tester.tap(find.text('Periksa status'));
    await settle(tester);

    final keys = createKeys(app);
    expect(keys, hasLength(2));
    expect(keys.toSet(), hasLength(1));
    expect(app.location, '/payments/pay-1');
    expect(store.values[IdempotencyStore.storageKey] ?? '', isNot(contains('payment.create.registration')));
  });

  testWidgets(
    'PRD 4.3, 4.5, AC F03-4: payment terbuka ditemukan saat Memeriksa status: key pembuatan dilepas, sehingga '
    'instruksi baru setelah pembatalan memakai key baru (bukan replay instruksi batal)',
    (tester) async {
      var posted = false;
      var cancelled = false;
      String? firstKey;
      final store = MemorySecureStore();
      final app = await openNew(store: store, tester, {
        '/me/payments': (options) {
          final key = idempotencyKeyOf(options);
          if (!posted) {
            // Permintaan pertama sampai di server (pay-1 dibuat) tetapi responsnya hilang.
            posted = true;
            firstKey = key;
            return FakeResponse.network();
          }
          // Server menyimpan respons per key selama 24 jam: key lama me-replay pay-1 yang kini dibatalkan.
          if (key == firstKey) {
            return FakeResponse.json(200, paymentJson(status: 'cancelled', stage: 'cancelled', cancelledAt: testNow));
          }
          return FakeResponse.json(201, paymentJson(id: 'pay-2'));
        },
        '/me/fees': (_) => FakeResponse.json(
          200,
          feesJson(
            registration: feeQuoteJson(type: 'registration', openPaymentId: posted && !cancelled ? 'pay-1' : null),
          ),
        ),
        '/me/payments/pay-2': (_) => FakeResponse.json(200, paymentJson(id: 'pay-2')),
      });

      expect(app.location, '/payments/pay-1');
      // Hasil sudah diketahui lewat GET /me/fees: key tidak tertinggal di secure storage.
      expect(store.values[IdempotencyStore.storageKey] ?? '', isNot(contains('payment.create.registration')));

      // pay-1 dibatalkan (oleh anggota atau pengurus), lalu anggota membuat instruksi baru.
      cancelled = true;
      app.router.go('/payments/new/registration');
      await settle(tester);

      final keys = createKeys(app);
      expect(keys, hasLength(2));
      expect(keys.last, isNot(firstKey));
      expect(app.location, '/payments/pay-2');
    },
  );

  testWidgets('PRD 4.3: respons replay berupa instruksi yang sudah dibatalkan: diulang sekali dengan key baru dan '
      'instruksi yang berlaku dibuka', (tester) async {
    var posts = 0;
    final app = await openNew(tester, {
      '/me/payments': (_) {
        if (posts++ == 0) {
          return FakeResponse.json(200, paymentJson(status: 'cancelled', stage: 'cancelled', cancelledAt: testNow));
        }
        return FakeResponse.json(201, paymentJson(id: 'pay-2'));
      },
      '/me/payments/pay-2': (_) => FakeResponse.json(200, paymentJson(id: 'pay-2')),
    });

    final keys = createKeys(app);
    expect(keys, hasLength(2));
    expect(keys.toSet(), hasLength(2));
    expect(app.location, '/payments/pay-2');
    expect(find.text('Instruksi pembayaran dibatalkan'), findsNothing);
  });

  testWidgets('AC F07-5: perpanjangan sebelum jendela dibuka: instruksi tidak dibuat, tanggal pembukaan tampil', (
    tester,
  ) async {
    final opens = DateTime.utc(2027, 9, 12, 7);
    final app = await openNew(tester, type: 'renewal', status: 'verified', {
      '/me/fees': (_) => FakeResponse.json(
        200,
        feesJson(
          registration: feeQuoteJson(type: 'registration', eligible: false, ineligibleReason: 'already_registered'),
          renewal: feeQuoteJson(
            type: 'renewal',
            eligible: false,
            ineligibleReason: 'renewal_window_not_open',
            renewalOpensAt: opens,
          ),
        ),
      ),
    });

    expect(createKeys(app), isEmpty);
    expect(find.text('Iuran belum dapat dibayar'), findsOneWidget);
    expect(find.text('Perpanjangan dibuka mulai 12 Sep 2027, 30 hari sebelum masa aktif berakhir.'), findsOneWidget);
  });

  testWidgets('D13: instruksi iuran disembunyikan untuk platform ini: tidak ada POST, arahan ke pengurus', (
    tester,
  ) async {
    final app = await openNew(tester, {'/me/fees': (_) => FakeResponse.json(200, feesJson(instructionsHidden: true))});

    expect(createKeys(app), isEmpty);
    expect(find.byKey(const ValueKey('dues-hidden')), findsOneWidget);
    expect(find.text(duesHiddenMessage), findsOneWidget);
  });

  testWidgets('D13: server menolak dari platform tersembunyi (403 FORBIDDEN): arahan ke pengurus', (tester) async {
    final app = await openNew(tester, {
      '/me/payments': (_) => FakeResponse.json(403, errorJson('FORBIDDEN', 'Akses ditolak.')),
    });

    expect(createKeys(app), hasLength(1));
    expect(find.byKey(const ValueKey('dues-hidden')), findsOneWidget);
  });

  testWidgets('PRD 4.5: rekening tujuan belum diaktifkan pengurus: pesan spesifik dan kontak pengurus', (tester) async {
    final app = await openNew(tester, {'/payment-methods': (_) => FakeResponse.json(200, methodsJson(const []))});

    expect(createKeys(app), isEmpty);
    expect(find.text('Rekening tujuan belum tersedia'), findsOneWidget);
    expect(find.text('Hubungi pengurus'), findsOneWidget);
  });

  testWidgets('PRD 4.5: jenis pembayaran tidak dikenal: tidak ada request mutasi', (tester) async {
    final app = await openNew(tester, type: 'donasi', status: 'verified', {});

    expect(createKeys(app), isEmpty);
    expect(app.adapter.requestsTo('/me/fees'), isEmpty);
    expect(find.text('Jenis pembayaran tidak dikenal'), findsOneWidget);
  });
}
