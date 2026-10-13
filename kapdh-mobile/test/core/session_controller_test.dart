import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';
import 'package:dio/dio.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/session/me_snapshot_store.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';
import 'package:kapdh_mobile/core/cache/kta_cache_store.dart';

import '../support/fakes.dart';

StoredTokens storedTokens() => StoredTokens(
  accessToken: 'access-1',
  accessExpiresAt: testNow.add(const Duration(minutes: 10)),
  refreshToken: 'refresh-1',
);

void main() {
  group('bootstrap (ARCHITECTURE §8.3: offline tidak pernah mengeluarkan pengguna)', () {
    test('tanpa token: anonim', () async {
      final container = makeContainer(adapter: FakeHttpAdapter((_) => FakeResponse.network()));
      await container.read(sessionProvider.notifier).bootstrap();
      expect(container.read(sessionProvider).phase, SessionPhase.anonymous);
    });

    test('online: GET /me menentukan status dan snapshot disimpan', () async {
      final store = MemorySecureStore();
      final container = makeContainer(
        store: store,
        adapter: FakeHttpAdapter((_) => FakeResponse.json(200, meJson(status: 'unverified'))),
      );
      await container.read(tokenStoreProvider).save(storedTokens());

      await container.read(sessionProvider.notifier).bootstrap();

      final state = container.read(sessionProvider);
      expect(state.phase, SessionPhase.authenticated);
      expect(state.effectiveStatus, EffectiveStatus.unverified);
      expect(state.syncedAt, testNow);
      expect((await container.read(meSnapshotStoreProvider).read())?.me.userId, 'user-1');
    });

    test('offline dengan snapshot: offlineLastKnown, token tetap', () async {
      final store = MemorySecureStore();
      final container = makeContainer(store: store, adapter: FakeHttpAdapter((_) => FakeResponse.network()));
      await container.read(tokenStoreProvider).save(storedTokens());
      await MeSnapshotStore(store).save(meOf(status: 'verified'), testNow.subtract(const Duration(days: 2)));

      await container.read(sessionProvider.notifier).bootstrap();

      final state = container.read(sessionProvider);
      expect(state.phase, SessionPhase.offlineLastKnown);
      expect(state.issue, SessionIssue.offline);
      expect(state.effectiveStatus, EffectiveStatus.verified);
      expect(state.syncedAt, testNow.subtract(const Duration(days: 2)));
      expect(await container.read(tokenStoreProvider).read(), isNotNull);
    });

    test('offline tanpa snapshot: tetap unknown dengan masalah offline, token tetap', () async {
      final container = makeContainer(adapter: FakeHttpAdapter((_) => FakeResponse.network()));
      await container.read(tokenStoreProvider).save(storedTokens());

      await container.read(sessionProvider.notifier).bootstrap();

      expect(container.read(sessionProvider), const SessionState.unknown(issue: SessionIssue.offline));
      expect(await container.read(tokenStoreProvider).read(), isNotNull);
    });

    test('server 500 atau HTML proxy: masalah server, token tetap', () async {
      final container = makeContainer(
        adapter: FakeHttpAdapter((_) => FakeResponse.raw(502, '<html>Bad gateway</html>')),
      );
      await container.read(tokenStoreProvider).save(storedTokens());

      await container.read(sessionProvider.notifier).bootstrap();

      expect(container.read(sessionProvider).issue, SessionIssue.serverError);
      expect(await container.read(tokenStoreProvider).read(), isNotNull);
    });

    test('secure storage gagal dibaca: splash mendapat masalah storage, coba lagi berhasil, token tetap', () async {
      final inner = MemorySecureStore();
      await TokenStore(inner).save(storedTokens());
      final flaky = FlakySecureStore(inner);
      final container = makeContainer(store: flaky, adapter: FakeHttpAdapter((_) => FakeResponse.json(200, meJson())));
      final controller = container.read(sessionProvider.notifier);

      await controller.bootstrap();
      expect(container.read(sessionProvider), const SessionState.unknown(issue: SessionIssue.storage));
      expect(inner.values.containsKey(TokenStore.storageKey), isTrue);

      await controller.bootstrap();
      expect(container.read(sessionProvider).phase, SessionPhase.authenticated);
    });

    test('sesi dicabut (refresh UNAUTHENTICATED): anonim dan data privat dihapus', () async {
      final store = MemorySecureStore();
      final container = makeContainer(
        store: store,
        adapter: FakeHttpAdapter((_) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.'))),
      );
      await container.read(tokenStoreProvider).save(storedTokens());
      await MeSnapshotStore(store).save(meOf(), testNow);
      await container.read(ktaCacheStoreProvider).save(userId: 'user-1', card: cardOf());

      await container.read(sessionProvider.notifier).bootstrap();
      await Future<void>.delayed(Duration.zero);

      expect(container.read(sessionProvider).phase, SessionPhase.anonymous);
      expect(store.values.keys, isNot(contains(TokenStore.storageKey)));
      expect(store.values.keys, isNot(contains(MeSnapshotStore.storageKey)));
      expect(store.values.keys, isNot(contains(KtaCacheStore.storageKey)));
    });

    test('kembali online: offlineLastKnown diganti status server terbaru', () async {
      var online = false;
      final container = makeContainer(
        adapter: FakeHttpAdapter(
          (_) => online ? FakeResponse.json(200, meJson(status: 'suspended')) : FakeResponse.network(),
        ),
      );
      final store = container.read(secureStoreProvider);
      await container.read(tokenStoreProvider).save(storedTokens());
      await MeSnapshotStore(store).save(meOf(status: 'verified'), testNow);
      await container.read(ktaCacheStoreProvider).save(userId: 'user-1', card: cardOf());
      final controller = container.read(sessionProvider.notifier);
      await controller.bootstrap();
      expect(container.read(sessionProvider).isOffline, isTrue);

      online = true;
      await controller.refreshQuietly();

      expect(container.read(sessionProvider).phase, SessionPhase.authenticated);
      expect(container.read(sessionProvider).effectiveStatus, EffectiveStatus.suspended);
      // Anggota disuspend setelah sinkronisasi terakhir: cache tidak lagi tampil aktif (AC F05-4).
      expect(await container.read(ktaCacheStoreProvider).read(userId: 'user-1'), isA<KtaCacheMiss>());
    });

    test('refreshMe saat sesi aktif dan jaringan putus: sesi tidak berubah, galat dilempar', () async {
      var online = true;
      final container = makeContainer(
        adapter: FakeHttpAdapter((_) => online ? FakeResponse.json(200, meJson()) : FakeResponse.network()),
      );
      await container.read(tokenStoreProvider).save(storedTokens());
      final controller = container.read(sessionProvider.notifier);
      await controller.bootstrap();
      final before = container.read(sessionProvider);

      online = false;
      await expectLater(
        controller.refreshMe(),
        throwsA(isA<ApiException>().having((e) => e.isNetwork, 'network', true)),
      );
      expect(container.read(sessionProvider), before);
    });
  });

  group('login, logout dan pergantian akun', () {
    test('login akun pending_otp menyimpan challenge tanpa token (AC F02-1)', () async {
      final dio = Dio(BaseOptions(baseUrl: testApiConfig.baseUrl));
      final mock = DioAdapter(dio: dio);
      mock.onPost(
        '/auth/login',
        (server) => server.reply(200, {'next': 'verify_otp', 'challenge': otpChallengeJson()}),
        data: {'email': 'ahmad@email.com', 'password': 'Rahasia#123', 'device_name': 'Aplikasi KAPDH Android'},
      );
      final container = makeContainer(adapter: mock);

      final result = await container
          .read(sessionProvider.notifier)
          .login(email: ' ahmad@email.com ', password: 'Rahasia#123');

      expect(result.outcome, LoginOutcome.verifyOtp);
      expect(container.read(sessionProvider).challenge?.challengeId, 'challenge-1');
      expect(await container.read(tokenStoreProvider).read(), isNull);
    });

    test('login berhasil menyimpan token atomik lalu memuat /me', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/login') return FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()});
        return FakeResponse.json(200, meJson(status: 'expiring'));
      });
      final container = makeContainer(adapter: adapter);

      final result = await container.read(sessionProvider.notifier).login(email: 'a@b.id', password: 'Rahasia#123');

      expect(result.outcome, LoginOutcome.signedIn);
      expect(container.read(sessionProvider).effectiveStatus, EffectiveStatus.expiring);
      expect((await container.read(tokenStoreProvider).read())?.refreshToken, 'refresh-1');
    });

    test(
      'login akun deletion_pending: status penghapusan tanpa sesi dan tanpa memanggil /me (F-14, PRD 2.2)',
      () async {
        final adapter = FakeHttpAdapter((options) {
          if (options.path == '/auth/login') {
            return FakeResponse.json(200, {
              'next': 'deletion_pending',
              'deletion': {
                'request_number': 'DEL-2026-7K3Q9X',
                'status': 'processing',
                'source': 'app',
                'requested_at': testNow.toIso8601String(),
                'estimated_completion_at': testNow.add(const Duration(days: 7)).toIso8601String(),
                'completed_at': null,
              },
            });
          }
          return FakeResponse.json(500, errorJson('INTERNAL_ERROR', 'Tidak boleh dipanggil.'));
        });
        final container = makeContainer(adapter: adapter);

        final result = await container.read(sessionProvider.notifier).login(email: 'a@b.id', password: 'Rahasia#123');

        expect(result.outcome, LoginOutcome.deletionPending);
        expect(result.deletion?.requestNumber, 'DEL-2026-7K3Q9X');
        expect(container.read(sessionProvider).hasSession, isFalse);
        expect(await container.read(tokenStoreProvider).read(), isNull);
        expect(adapter.requestsTo('/me'), isEmpty);
      },
    );

    test('login akun disabled: tanpa sesi (PRD 2.2)', () async {
      final adapter = FakeHttpAdapter((_) => FakeResponse.json(200, {'next': 'account_disabled'}));
      final container = makeContainer(adapter: adapter);

      final result = await container.read(sessionProvider.notifier).login(email: 'a@b.id', password: 'Rahasia#123');

      expect(result.outcome, LoginOutcome.accountDisabled);
      expect(result.deletion, isNull);
      expect(container.read(sessionProvider).hasSession, isFalse);
      expect(await container.read(tokenStoreProvider).read(), isNull);
    });

    test('logout menghapus token, snapshot, cache KTA dan kunci idempotensi walau server tidak terjangkau', () async {
      var online = true;
      final store = MemorySecureStore();
      final container = makeContainer(
        store: store,
        adapter: FakeHttpAdapter((options) => online ? FakeResponse.json(200, meJson()) : FakeResponse.network()),
      );
      await container.read(tokenStoreProvider).save(storedTokens());
      await container.read(sessionProvider.notifier).bootstrap();
      await container.read(ktaCacheStoreProvider).save(userId: 'user-1', card: cardOf());
      await container.read(idempotencyStoreProvider).keyFor('payment.create', {'type': 'registration'});
      store.values['kapdh.lain'] = 'tetap';

      online = false;
      await container.read(sessionProvider.notifier).logout();

      expect(container.read(sessionProvider).phase, SessionPhase.anonymous);
      expect(store.values.keys, ['kapdh.lain']);
    });

    test('keluar semua perangkat gagal: galat dilempar dan sesi lokal tetap', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/logout-all') return FakeResponse.network();
        return FakeResponse.json(200, meJson());
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(storedTokens());
      await container.read(sessionProvider.notifier).bootstrap();

      await expectLater(
        container.read(sessionProvider.notifier).logout(allDevices: true),
        throwsA(isA<ApiException>()),
      );
      expect(container.read(sessionProvider).phase, SessionPhase.authenticated);
      expect(await container.read(tokenStoreProvider).read(), isNotNull);
    });

    test('akun berbeda masuk di perangkat yang sama: cache KTA akun lama dihapus (AC F05-3)', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/login') {
          return FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson(access: 'b')});
        }
        return FakeResponse.json(200, meJson(userId: 'user-2'));
      });
      final store = MemorySecureStore();
      final container = makeContainer(adapter: adapter, store: store);
      await MeSnapshotStore(store).save(meOf(userId: 'user-1'), testNow);
      await container.read(ktaCacheStoreProvider).save(userId: 'user-1', card: cardOf());

      await container.read(sessionProvider.notifier).login(email: 'b@b.id', password: 'Rahasia#123');

      expect(container.read(sessionProvider).userId, 'user-2');
      expect(store.values.containsKey(KtaCacheStore.storageKey), isFalse);
    });

    test('sinyal MEMBERSHIP_REQUIRED dari request mana pun memuat ulang /me (ErrorUiAction.refreshStatus)', () async {
      var meCalls = 0;
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/me') {
          meCalls++;
          return FakeResponse.json(200, meJson(status: meCalls == 1 ? 'verified' : 'expired'));
        }
        return FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Perlu KTA aktif.'));
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(storedTokens());
      await container.read(sessionProvider.notifier).bootstrap();

      await expectLater(container.read(kapdhApiProvider).content.getHome(), throwsA(isA<ApiException>()));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(meCalls, 2);
      expect(container.read(sessionProvider).effectiveStatus, EffectiveStatus.expired);
    });
  });
}
