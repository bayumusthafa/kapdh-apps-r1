import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/cache/kta_cache_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';

import '../support/fakes.dart';

void main() {
  late MemorySecureStore storage;
  late TestClock clock;
  late KtaCacheStore cache;

  final expiresAt = testNow.add(const Duration(days: 200));

  setUp(() {
    storage = MemorySecureStore();
    clock = TestClock();
    cache = KtaCacheStore(storage, clock: clock.call);
  });

  group('aturan baca KTA offline (AC F05-2..F05-4)', () {
    test('tersinkron <= 7 hari dan masa anggota belum habis: tampil dengan waktu sinkronisasi', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: expiresAt),
      );
      clock.advance(const Duration(days: 6, hours: 23));

      final result = await cache.read(userId: 'user-1');

      expect(result, isA<KtaCacheHit>());
      final hit = result as KtaCacheHit;
      expect(hit.syncedAt, testNow);
      expect(hit.card.memberNumber, '29.01.01.7');
      expect(hit.qrUsable, isTrue);
    });

    test('tepat 7 hari masih tampil, lebih dari 7 hari tidak (dan cache dihapus)', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: expiresAt, qrExpiresAt: testNow.add(const Duration(days: 8))),
      );
      clock.advance(const Duration(days: 7));
      expect(await cache.read(userId: 'user-1'), isA<KtaCacheHit>());

      clock.advance(const Duration(seconds: 1));
      final result = await cache.read(userId: 'user-1');
      expect((result as KtaCacheMiss).reason, KtaCacheMissReason.stale);
      expect(storage.values.containsKey(KtaCacheStore.storageKey), isFalse);
    });

    test('expires_at sudah lewat (now >= expires_at): tidak tampil', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: testNow.add(const Duration(days: 1))),
      );
      clock.advance(const Duration(days: 1));
      expect(((await cache.read(userId: 'user-1')) as KtaCacheMiss).reason, KtaCacheMissReason.membershipExpired);
    });

    test('akun lain: tidak tampil dan cache akun lama dihapus', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: expiresAt),
      );
      expect(((await cache.read(userId: 'user-2')) as KtaCacheMiss).reason, KtaCacheMissReason.otherAccount);
      expect(await cache.read(userId: 'user-1'), isA<KtaCacheMiss>());
    });

    test('kartu berstatus dibatasi tidak pernah tampil aktif', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(status: 'suspended', expiresAt: expiresAt, withQr: false),
      );
      expect(((await cache.read(userId: 'user-1')) as KtaCacheMiss).reason, KtaCacheMissReason.restricted);
    });

    test('jam perangkat dimundurkan sebelum synced_at: tidak tampil, cache tidak dihapus', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: expiresAt),
      );
      clock.advance(const Duration(hours: -1));
      expect(((await cache.read(userId: 'user-1')) as KtaCacheMiss).reason, KtaCacheMissReason.clockSkew);
      expect(storage.values.containsKey(KtaCacheStore.storageKey), isTrue);
    });

    test('token QR kedaluwarsa: kartu tampil tanpa QR', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: expiresAt, qrExpiresAt: testNow.add(const Duration(days: 2))),
      );
      clock.advance(const Duration(days: 3));
      final hit = (await cache.read(userId: 'user-1')) as KtaCacheHit;
      expect(hit.qrUsable, isFalse);
    });

    test('kartu Tidak Aktif (tanpa expires_at) tetap dapat ditampilkan offline tanpa QR', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(status: 'inactive', withQr: false),
      );
      final hit = (await cache.read(userId: 'user-1')) as KtaCacheHit;
      expect(hit.qrUsable, isFalse);
    });

    test('belum pernah tersinkron dan data rusak', () async {
      expect(((await cache.read(userId: 'user-1')) as KtaCacheMiss).reason, KtaCacheMissReason.empty);
      storage.values[KtaCacheStore.storageKey] = '{"user_id": 1}';
      expect(((await cache.read(userId: 'user-1')) as KtaCacheMiss).reason, KtaCacheMissReason.empty);
      expect(storage.values.containsKey(KtaCacheStore.storageKey), isFalse);
    });

    test('logout: clear menghapus cache', () async {
      await cache.save(
        userId: 'user-1',
        card: cardOf(expiresAt: expiresAt),
      );
      await cache.clear();
      expect(storage.values, isEmpty);
    });
  });
}
