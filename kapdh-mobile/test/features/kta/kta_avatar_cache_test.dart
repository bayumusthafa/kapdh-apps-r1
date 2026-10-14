import 'package:cached_network_image/cached_network_image.dart';

import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/cache/kta_avatar_cache.dart';
import 'package:kapdh_mobile/core/cache/kta_cache_store.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:mocktail/mocktail.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'kta_fakes.dart';

class _FakeManager extends Mock implements BaseCacheManager {}

void main() {
  group('KtaAvatarCache (PRD 5.2, AC F05-3)', () {
    late MemorySecureStore store;
    late _FakeManager manager;
    late int created;

    KtaAvatarCache cache() => KtaAvatarCache(
      store,
      createManager: () {
        created++;
        return manager;
      },
    );

    setUp(() {
      store = MemorySecureStore();
      manager = _FakeManager();
      created = 0;
      when(() => manager.emptyCache()).thenAnswer((_) async {});
    });

    test('foto KTA memakai cache tersendiri dengan kunci akun/berkas dan ditandai untuk dihapus nanti', () async {
      final provider = cache().imageFor('https://files.test/avatar.jpg?sig=1', cacheKey: 'kta-avatar-user-1-file-1');
      await pumpEventQueue();

      expect(provider, isA<CachedNetworkImageProvider>());
      final cached = provider as CachedNetworkImageProvider;
      expect(cached.cacheManager, same(manager));
      expect(cached.cacheKey, 'kta-avatar-user-1-file-1');
      expect(store.values[KtaAvatarCache.storageKey], isNotNull);
    });

    test('mengosongkan cache foto dan penanda; tanpa pemakaian sebelumnya cache tidak dibuka sama sekali', () async {
      await cache().clear();
      expect(created, 0);
      verifyNever(() => manager.emptyCache());

      final used = cache();
      used.imageFor('https://files.test/avatar.jpg');
      await pumpEventQueue();
      await used.clear();
      verify(() => manager.emptyCache()).called(1);
      expect(store.values.containsKey(KtaAvatarCache.storageKey), isFalse);
    });

    test('setelah aplikasi dibuka ulang: penanda tersimpan membuat cache foto tetap dikosongkan saat logout', () async {
      final first = cache();
      first.imageFor('https://files.test/avatar.jpg');
      await pumpEventQueue();

      // Proses baru: instance baru, hanya penanda di secure storage yang tersisa.
      await cache().clear();
      verify(() => manager.emptyCache()).called(1);
      expect(store.values.containsKey(KtaAvatarCache.storageKey), isFalse);
    });

    test('kegagalan menghapus tidak menggagalkan logout', () async {
      when(() => manager.emptyCache()).thenThrow(StateError('disk'));
      final avatars = cache();
      avatars.imageFor('https://files.test/avatar.jpg');
      await pumpEventQueue();
      await expectLater(avatars.clear(), completes);
    });

    test('KtaCacheStore.clear ikut mengosongkan data turunan kartu (foto KTA)', () async {
      var cleared = 0;
      final kta = KtaCacheStore(store, onClear: () async => cleared++);
      await kta.save(
        userId: 'user-1',
        card: cardOf(expiresAt: DateTime.utc(2027, 10, 12, 7)),
      );
      await kta.clear();
      expect(cleared, 1);
      expect(store.values.containsKey(KtaCacheStore.storageKey), isFalse);

      // Cache kartu kedaluwarsa (> 7 hari) dihapus saat dibaca: foto ikut dihapus.
      final old = KtaCacheStore(store, clock: () => testNow, onClear: () async => cleared++);
      await old.save(
        userId: 'user-1',
        card: cardOf(expiresAt: DateTime.utc(2027, 10, 12, 7), syncedAt: testNow.subtract(const Duration(days: 8))),
      );
      expect(await old.read(userId: 'user-1'), isA<KtaCacheMiss>());
      expect(cleared, 2);
    });
  });

  group('Sesi menghapus foto KTA (PRD 5.2, AC F05-3, F05-4)', () {
    test('logout mengosongkan cache foto KTA', () async {
      final avatars = RecordingAvatarCache();
      final container = makeContainer(
        adapter: FakeHttpAdapter((_) => FakeResponse.json(204)),
        overrides: [ktaAvatarCacheProvider.overrideWithValue(avatars)],
      );
      addTearDown(container.dispose);
      await container.read(tokenStoreProvider).save(savedTokens());

      await container.read(sessionProvider.notifier).logout();

      expect(avatars.clears, greaterThan(0));
    });

    test('status dibatasi dari server mengosongkan cache foto KTA', () async {
      final avatars = RecordingAvatarCache();
      final container = makeContainer(
        adapter: FakeHttpAdapter((options) {
          if (options.path == '/me') return FakeResponse.json(200, meJson(status: 'suspended'));
          return FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan.'));
        }),
        overrides: [ktaAvatarCacheProvider.overrideWithValue(avatars)],
      );
      addTearDown(container.dispose);
      await container.read(tokenStoreProvider).save(savedTokens());

      await container.read(sessionProvider.notifier).bootstrap();

      expect(avatars.clears, greaterThan(0));
    });

    test('berganti akun mengosongkan cache foto KTA akun sebelumnya', () async {
      final avatars = RecordingAvatarCache();
      final store = MemorySecureStore();
      final container = makeContainer(
        store: store,
        adapter: FakeHttpAdapter((options) {
          if (options.path == '/me') return FakeResponse.json(200, meJson(userId: 'user-2'));
          return FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan.'));
        }),
        overrides: [ktaAvatarCacheProvider.overrideWithValue(avatars)],
      );
      addTearDown(container.dispose);
      // Snapshot /me terakhir milik user-1 (akun sebelumnya di perangkat ini).
      await container.read(meSnapshotStoreProvider).save(meOf(), testNow);
      await container.read(tokenStoreProvider).save(savedTokens());

      await container.read(sessionProvider.notifier).bootstrap();

      expect(avatars.clears, greaterThan(0));
    });
  });
}
