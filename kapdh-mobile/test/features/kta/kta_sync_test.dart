import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/cache/kta_cache_store.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/features/kta/kta_sync.dart';

import '../../support/fakes.dart';

/// Sinkronisasi KTA dan aturan cache offline (F-05; AC F05-2..F05-5, kontrak C2 `MemberCard.offline_valid_until`).
void main() {
  late MemorySecureStore storage;
  late TestClock clock;
  late ProviderContainer container;
  late FakeResponse Function() respond;

  final expiresAt = testNow.add(const Duration(days: 200));

  setUp(() {
    storage = MemorySecureStore();
    clock = TestClock();
    respond = () => FakeResponse.json(200, memberCardJson(expiresAt: expiresAt));
    container = makeContainer(
      adapter: FakeHttpAdapter((options) {
        if (options.path == '/me/card') return respond();
        return FakeResponse.json(404, errorJson('NOT_FOUND', 'Tidak ditemukan (uji)'));
      }),
      store: storage,
      clock: clock,
    );
    addTearDown(container.dispose);
  });

  KtaSync sync() => container.read(ktaSyncProvider);
  KtaCacheStore cache() => container.read(ktaCacheStoreProvider);

  test('AC F05-1, F05-2: kartu dari server ditampilkan dan disimpan untuk akun ini', () async {
    final view = await sync().sync(userId: 'user-1');

    expect(view, isA<KtaOnline>());
    expect((view as KtaOnline).card.memberNumber, '29.01.01.7');
    final cached = await cache().read(userId: 'user-1');
    expect(cached, isA<KtaCacheHit>());
    expect((cached as KtaCacheHit).card.qr?.url, 'https://kapdh.or.id/kta/29.01.01.7#t=token-uji');
  });

  test(
    'AC F05-2: server tidak terjangkau dan cache tersinkron <= 7 hari: kartu Offline dengan waktu sinkron dan QR',
    () async {
      await sync().sync(userId: 'user-1');
      respond = FakeResponse.network;
      clock.advance(const Duration(days: 6, hours: 23));

      final view = await sync().sync(userId: 'user-1');

      expect(view, isA<KtaOffline>());
      final offline = view as KtaOffline;
      expect(offline.syncedAt, testNow);
      expect(offline.qrUsable, isTrue);
      expect(offline.error.isNetwork, isTrue);
    },
  );

  test('AC F05-2: 5xx diperlakukan seperti server tidak terjangkau', () async {
    await sync().sync(userId: 'user-1');
    respond = () => FakeResponse.json(502, errorJson('INTERNAL_ERROR', 'Server sedang bermasalah.'));

    expect(await sync().sync(userId: 'user-1'), isA<KtaOffline>());
  });

  test('AC F05-3: cache lebih dari 7 hari: tidak tampil, pengguna diminta sinkron, cache dihapus', () async {
    await sync().sync(userId: 'user-1');
    respond = FakeResponse.network;
    clock.advance(const Duration(days: 7, minutes: 1));

    final view = await sync().sync(userId: 'user-1');

    expect(view, isA<KtaUnavailable>());
    expect((view as KtaUnavailable).reason, KtaCacheMissReason.stale);
    expect(storage.values.containsKey(KtaCacheStore.storageKey), isFalse);
  });

  test('AC F05-3: batas offline_valid_until server (token QR lebih pendek) lewat: tidak tampil aktif', () async {
    respond = () =>
        FakeResponse.json(200, memberCardJson(expiresAt: expiresAt, qrExpiresAt: testNow.add(const Duration(days: 2))));
    await sync().sync(userId: 'user-1');
    respond = FakeResponse.network;
    clock.advance(const Duration(days: 3));

    final view = await sync().sync(userId: 'user-1');

    expect((view as KtaUnavailable).reason, KtaCacheMissReason.stale);
    expect(storage.values.containsKey(KtaCacheStore.storageKey), isFalse);
  });

  test('AC F05-3: masa keanggotaan pada kartu tersimpan sudah lewat: tidak tampil', () async {
    final soon = testNow.add(const Duration(days: 2));
    respond = () => FakeResponse.json(200, memberCardJson(status: 'expiring', expiresAt: soon));
    await sync().sync(userId: 'user-1');
    respond = FakeResponse.network;
    clock.advance(const Duration(days: 3));

    final view = await sync().sync(userId: 'user-1');

    expect((view as KtaUnavailable).reason, KtaCacheMissReason.membershipExpired);
  });

  test('AC F05-3: kartu kedaluwarsa dari server tidak pernah tampil offline', () async {
    final past = testNow.subtract(const Duration(days: 1));
    respond = () => FakeResponse.json(200, memberCardJson(status: 'expired', expiresAt: past, withQr: false));
    await sync().sync(userId: 'user-1');
    respond = FakeResponse.network;

    final view = await sync().sync(userId: 'user-1');

    expect((view as KtaUnavailable).reason, KtaCacheMissReason.membershipExpired);
    expect(storage.values.containsKey(KtaCacheStore.storageKey), isFalse);
  });

  test('AC F05-3: berganti akun: cache akun lama tidak tampil dan dihapus', () async {
    await sync().sync(userId: 'user-1');
    respond = FakeResponse.network;

    final view = await sync().sync(userId: 'user-2');

    expect((view as KtaUnavailable).reason, KtaCacheMissReason.otherAccount);
    expect(storage.values.containsKey(KtaCacheStore.storageKey), isFalse);
  });

  test('AC F05-3: belum pernah tersinkron dan offline: diminta sinkron', () async {
    respond = FakeResponse.network;

    final view = await sync().sync(userId: 'user-1');

    expect((view as KtaUnavailable).reason, KtaCacheMissReason.empty);
  });

  test('AC F05-4: disuspend setelah sinkron terakhir: kartu dibatasi dari server menggantikan cache aktif', () async {
    await sync().sync(userId: 'user-1');
    respond = () => FakeResponse.json(200, memberCardJson(status: 'suspended', expiresAt: expiresAt, withQr: false));

    final online = await sync().sync(userId: 'user-1');
    expect((online as KtaOnline).card.statusLabel, MemberCardStatus.suspended);
    expect(online.card.qr, isNull);

    // Kembali offline: kartu aktif lama tidak pernah tampil lagi.
    respond = FakeResponse.network;
    final view = await sync().sync(userId: 'user-1');
    expect((view as KtaUnavailable).reason, KtaCacheMissReason.restricted);
  });

  test('AC F05-1: kartu Tidak Aktif boleh tampil offline tanpa QR (tidak pernah tampil aktif)', () async {
    respond = () => FakeResponse.json(200, memberCardJson(status: 'inactive', withQr: false));
    await sync().sync(userId: 'user-1');
    respond = FakeResponse.network;

    final view = await sync().sync(userId: 'user-1');

    expect(view, isA<KtaOffline>());
    expect((view as KtaOffline).qrUsable, isFalse);
  });

  test('AC F05-5: perpanjangan paid: sinkron berikutnya menyimpan nomor yang sama dengan masa berlaku baru', () async {
    await sync().sync(userId: 'user-1');
    final renewed = expiresAt.add(const Duration(days: 365));
    respond = () => FakeResponse.json(200, memberCardJson(expiresAt: renewed));

    final view = await sync().sync(userId: 'user-1');

    expect((view as KtaOnline).card.memberNumber, '29.01.01.7');
    final cached = await cache().read(userId: 'user-1') as KtaCacheHit;
    expect(cached.card.expiresAt, renewed);
  });

  test('N-09: server menjawab galat selain jaringan/5xx: cache tidak dipakai', () async {
    await sync().sync(userId: 'user-1');
    respond = () => FakeResponse.json(403, errorJson('FORBIDDEN', 'Akses ditolak.'));

    final view = await sync().sync(userId: 'user-1');

    expect(view, isA<KtaUnavailable>());
    expect((view as KtaUnavailable).reason, isNull);
    expect(view.error.code, ErrorCode.forbidden);
  });

  test('PRD 4.5: klasifikasi galat yang boleh memakai cache offline', () {
    expect(canUseOfflineCache(networkError()), isTrue);
    expect(canUseOfflineCache(apiError(503, 'MAINTENANCE', 'Pemeliharaan.')), isTrue);
    expect(canUseOfflineCache(apiError(401, 'UNAUTHENTICATED', 'Sesi berakhir.')), isFalse);
    expect(canUseOfflineCache(apiError(404, 'NOT_FOUND', 'Tidak ditemukan.')), isFalse);
  });
}
