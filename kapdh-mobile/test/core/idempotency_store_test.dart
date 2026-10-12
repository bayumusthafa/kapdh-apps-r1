import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/idempotency_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';

import '../support/fakes.dart';

void main() {
  late MemorySecureStore storage;
  late TestClock clock;
  late IdempotencyStore store;

  const payload = {'type': 'registration', 'payment_method_id': 'pm-1'};

  setUp(() {
    storage = MemorySecureStore();
    clock = TestClock();
    store = IdempotencyStore(storage, clock: clock.call);
  });

  group('Idempotency-Key per niat (PRD 4.3, AC F01-4, F03-4)', () {
    test('payload sama memakai key yang sama, juga setelah aplikasi dibuka ulang', () async {
      final first = await store.keyFor('payment.create', payload);
      final again = await store.keyFor('payment.create', {'payment_method_id': 'pm-1', 'type': 'registration'});
      final afterRestart = await IdempotencyStore(storage, clock: clock.call).keyFor('payment.create', payload);

      expect(again, first);
      expect(afterRestart, first);
      expect(RegExp(r'^[0-9a-f-]{36}$').hasMatch(first), isTrue);
    });

    test('payload berubah membuat key baru (mencegah IDEMPOTENCY_CONFLICT)', () async {
      final first = await store.keyFor('payment.create', payload);
      final changed = await store.keyFor('payment.create', {...payload, 'payment_method_id': 'pm-2'});
      expect(changed, isNot(first));
    });

    test('niat berbeda tidak saling memakai key', () async {
      expect(await store.keyFor('a', payload), isNot(await store.keyFor('b', payload)));
    });

    test('key kedaluwarsa setelah retensi 24 jam', () async {
      final first = await store.keyFor('payment.create', payload);
      clock.advance(const Duration(hours: 24, minutes: 1));
      expect(await store.keyFor('payment.create', payload), isNot(first));
    });

    test('jam dimundurkan jauh membuat key baru', () async {
      final first = await store.keyFor('payment.create', payload);
      clock.advance(const Duration(hours: -2));
      expect(await store.keyFor('payment.create', payload), isNot(first));
    });

    test('complete melepas key; berikutnya key baru', () async {
      final first = await store.keyFor('payment.create', payload);
      await store.complete('payment.create');
      expect(await store.keyFor('payment.create', payload), isNot(first));
    });

    test('clear menghapus seluruh key (logout/berganti akun)', () async {
      await store.keyFor('payment.create', payload);
      await store.clear();
      expect(storage.values.containsKey(IdempotencyStore.storageKey), isFalse);
    });
  });

  group('run: key dipertahankan sampai hasil diketahui', () {
    Future<String> keyAfter(ApiException error) async {
      String? used;
      await expectLater(
        store.run('payment.create', payload, (key) async {
          used = key;
          throw error;
        }),
        throwsA(same(error)),
      );
      final next = await store.keyFor('payment.create', payload);
      return next == used ? 'sama' : 'baru';
    }

    test('sukses melepas key', () async {
      final key = await store.run('payment.create', payload, (key) async => key);
      expect(await store.keyFor('payment.create', payload), isNot(key));
    });

    test('jaringan putus/timeout: key sama dipakai ulang (Memeriksa status, PRD 4.5)', () async {
      expect(await keyAfter(networkError()), 'sama');
    });

    test('5xx: hasil belum pasti, key sama', () async {
      expect(await keyAfter(apiError(500, 'INTERNAL_ERROR', 'Galat')), 'sama');
      expect(await keyAfter(apiError(503, 'MAINTENANCE', 'Pemeliharaan')), 'sama');
    });

    test('RATE_LIMITED: belum diproses, key sama setelah jeda', () async {
      expect(await keyAfter(apiError(429, 'RATE_LIMITED', 'Tunggu', retryAfterSeconds: 30)), 'sama');
    });

    test('IDEMPOTENCY_CONFLICT dengan payload sama: permintaan pertama masih diproses, key dipertahankan', () async {
      expect(await keyAfter(apiError(409, 'IDEMPOTENCY_CONFLICT', 'Bertabrakan')), 'sama');
    });

    test('penolakan pasti 4xx (validasi, konflik status) melepas key', () async {
      expect(await keyAfter(apiError(400, 'VALIDATION_ERROR', 'Periksa isian')), 'baru');
      expect(await keyAfter(apiError(409, 'PAYMENT_STATE_CONFLICT', 'Status berubah')), 'baru');
    });
  });

  test('sidik payload kanonik: urutan kunci tidak berpengaruh, nilai berpengaruh', () {
    expect(
      IdempotencyStore.payloadFingerprint({
        'a': 1,
        'b': [1, 2],
      }),
      IdempotencyStore.payloadFingerprint({
        'b': [1, 2],
        'a': 1,
      }),
    );
    expect(IdempotencyStore.payloadFingerprint({'a': 1}), isNot(IdempotencyStore.payloadFingerprint({'a': 2})));
  });

  test('data tersimpan rusak diabaikan', () async {
    storage.values[IdempotencyStore.storageKey] = '{bukan json';
    expect(await store.keyFor('payment.create', payload), isNotEmpty);
  });
}
