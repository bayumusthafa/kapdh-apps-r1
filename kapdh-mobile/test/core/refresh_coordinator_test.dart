import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/api/refresh_coordinator.dart';
import 'package:kapdh_mobile/core/config/server_clock.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';

import '../support/fakes.dart';

StoredTokens tokens({
  String access = 'access-1',
  String? refresh = 'refresh-1',
  Duration validFor = const Duration(minutes: 10),
}) => StoredTokens(accessToken: access, accessExpiresAt: testNow.add(validFor), refreshToken: refresh);

String? bearer(RequestOptions options) => options.headers['Authorization'] as String?;

Map<String, Object?> jsonBody(RequestOptions options) {
  final data = options.data;
  if (data is Map<String, Object?>) return data;
  return jsonDecode(data as String) as Map<String, Object?>;
}

void main() {
  group('RefreshCoordinator melalui Dio aplikasi (ARCHITECTURE §8.3, AC F02-3)', () {
    test('lima request paralel yang ditolak 401 hanya memicu SATU refresh lalu diulang dengan token baru', () async {
      final adapter = FakeHttpAdapter((options) async {
        if (options.path == '/auth/refresh') {
          await Future<void>.delayed(const Duration(milliseconds: 20));
          return FakeResponse.json(200, tokenPairJson(access: 'access-2', refresh: 'refresh-2'));
        }
        if (bearer(options) == 'Bearer access-2') return FakeResponse.json(200, meJson());
        return FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.'));
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(tokens());
      final api = container.read(kapdhApiProvider);

      final results = await Future.wait(List.generate(5, (_) => api.me.getMe()));

      expect(results.map((me) => me.userId), everyElement('user-1'));
      final refreshes = adapter.requestsTo('/auth/refresh');
      expect(refreshes, hasLength(1));
      expect(jsonBody(refreshes.single)['refresh_token'], 'refresh-1');
      expect(container.read(refreshCoordinatorProvider).refreshCount, 1);
      expect(adapter.requestsTo('/me').where((r) => bearer(r) == 'Bearer access-2'), hasLength(5));
      final stored = await container.read(tokenStoreProvider).read();
      expect(stored?.accessToken, 'access-2');
      expect(stored?.refreshToken, 'refresh-2');
    });

    test('refresh gagal karena jaringan: token TIDAK dihapus dan request gagal sebagai offline', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/refresh') return FakeResponse.network();
        return FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.'));
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(tokens());
      var invalidated = false;
      container.read(refreshCoordinatorProvider).invalidated.listen((_) => invalidated = true);

      final error = await container
          .read(kapdhApiProvider)
          .me
          .getMe()
          .then<ApiException?>((_) => null, onError: (Object e) => e as ApiException);

      expect(error?.isNetwork, isTrue);
      expect(error?.ui.action, ErrorUiAction.showOffline);
      expect((await container.read(tokenStoreProvider).read())?.refreshToken, 'refresh-1');
      expect(invalidated, isFalse);
    });

    test('refresh 5xx/MAINTENANCE juga tidak mengeluarkan pengguna', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/refresh') {
          return FakeResponse.json(503, errorJson('MAINTENANCE', 'Pemeliharaan.', retryAfterSeconds: 60));
        }
        return FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.'));
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(tokens());

      await expectLater(
        container.read(kapdhApiProvider).me.getMe(),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', ErrorCode.maintenance)),
      );
      expect(await container.read(tokenStoreProvider).read(), isNotNull);
    });

    test('hanya UNAUTHENTICATED dari /auth/refresh yang menghapus token dan memancarkan invalidated', () async {
      final adapter = FakeHttpAdapter(
        (options) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir. Silakan masuk kembali.')),
      );
      final store = MemorySecureStore();
      final container = makeContainer(adapter: adapter, store: store);
      await container.read(tokenStoreProvider).save(tokens());
      store.values['kapdh.lainnya'] = 'tetap';
      final invalidated = container.read(refreshCoordinatorProvider).invalidated.first;

      await expectLater(
        container.read(kapdhApiProvider).me.getMe(),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', ErrorCode.unauthenticated)),
      );
      await invalidated;
      expect(await container.read(tokenStoreProvider).read(), isNull);
      expect(store.values.containsKey(TokenStore.storageKey), isFalse);
      // Hanya kunci token yang dihapus, bukan seluruh secure storage.
      expect(store.values['kapdh.lainnya'], 'tetap');
      expect(adapter.requestsTo('/auth/refresh'), hasLength(1));
    });

    test('operasi auth publik (login) tidak membawa token dan 401-nya tidak memicu refresh', () async {
      final adapter = FakeHttpAdapter(
        (options) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Email atau password salah.')),
      );
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(tokens());

      await expectLater(
        container.read(kapdhApiProvider).auth.login(const LoginRequest(email: 'a@b.id', password: 'Rahasia#1')),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Email atau password salah.')),
      );
      expect(adapter.requestsTo('/auth/refresh'), isEmpty);
      expect(bearer(adapter.requestsTo('/auth/login').single), isNull);
      expect(await container.read(tokenStoreProvider).read(), isNotNull);
    });

    test('request tanpa sesi yang ditolak 401 tidak mencoba refresh', () async {
      final adapter = FakeHttpAdapter((options) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Masuk dulu.')));
      final container = makeContainer(adapter: adapter);

      await expectLater(container.read(kapdhApiProvider).me.getMe(), throwsA(isA<ApiException>()));
      expect(adapter.requestsTo('/auth/refresh'), isEmpty);
      expect(bearer(adapter.requestsTo('/me').single), isNull);
    });

    test('token hampir habis di-refresh proaktif sebelum request dikirim', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/refresh') {
          return FakeResponse.json(200, tokenPairJson(access: 'access-2', refresh: 'refresh-2'));
        }
        return FakeResponse.json(200, meJson());
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(tokens(validFor: const Duration(seconds: 5)));

      await container.read(kapdhApiProvider).me.getMe();

      expect(adapter.requestsTo('/auth/refresh'), hasLength(1));
      expect(bearer(adapter.requestsTo('/me').single), 'Bearer access-2');
    });

    test('request multipart yang ditolak 401 dikirim ulang dengan FormData yang diklon (retryableRequest)', () async {
      var uploads = 0;
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/refresh') {
          return FakeResponse.json(200, tokenPairJson(access: 'access-2', refresh: 'refresh-2'));
        }
        uploads++;
        if (bearer(options) == 'Bearer access-2') return FakeResponse.json(201, {'id': 'file-1'});
        return FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.'));
      });
      final container = makeContainer(adapter: adapter);
      await container.read(tokenStoreProvider).save(tokens());

      final response = await container
          .read(dioProvider)
          .post<Object?>(
            '/files',
            data: FormData.fromMap({
              'purpose': 'payment_proof',
              'file': MultipartFile.fromString('isi', filename: 'bukti.txt'),
            }),
          );

      expect(response.statusCode, 201);
      expect(uploads, 2);
    });
  });

  group('RefreshCoordinator langsung', () {
    late MemorySecureStore store;
    late TokenStore tokenStore;
    late int calls;
    late Completer<TokenPair> pending;

    RefreshCoordinator build({SessionRefresher? refresher, ServerClock? serverClock}) => RefreshCoordinator(
      store: tokenStore,
      serverClock: serverClock ?? ServerClock(clock: () => testNow),
      refresher:
          refresher ??
          (refreshToken) {
            calls++;
            return pending.future;
          },
    );

    setUp(() async {
      store = MemorySecureStore();
      tokenStore = TokenStore(store);
      calls = 0;
      pending = Completer<TokenPair>();
      await tokenStore.save(tokens());
    });

    test('token yang ditolak sudah diganti pihak lain: pakai token terbaru tanpa refresh (cegah reuse)', () async {
      final coordinator = build();
      await tokenStore.save(tokens(access: 'access-2', refresh: 'refresh-2'));

      expect(await coordinator.refreshAfterRejection('access-1'), 'access-2');
      expect(calls, 0);
    });

    test('socket, push dan HTTP yang meminta bersamaan berbagi satu refresh', () async {
      final coordinator = build();
      await tokenStore.save(tokens(validFor: Duration.zero));

      final socket = coordinator.validAccessToken();
      final push = coordinator.validAccessToken();
      final http = coordinator.refreshAfterRejection('access-1');
      pending.complete(TokenPair.fromJson(tokenPairJson(access: 'access-2', refresh: 'refresh-2')));

      expect(await Future.wait([socket, push, http]), ['access-2', 'access-2', 'access-2']);
      expect(calls, 1);
      // Penolakan terlambat yang masih membawa token lama tidak memicu refresh kedua.
      expect(await coordinator.refreshAfterRejection('access-1'), 'access-2');
      expect(calls, 1);
    });

    test('refresh baru dimulai setelah refresh sebelumnya selesai dan token baru juga ditolak', () async {
      var n = 0;
      final coordinator = build(
        refresher: (refreshToken) async {
          n++;
          return TokenPair.fromJson(tokenPairJson(access: 'access-${n + 1}', refresh: 'refresh-${n + 1}'));
        },
      );
      expect(await coordinator.refreshAfterRejection('access-1'), 'access-2');
      expect(await coordinator.refreshAfterRejection('access-2'), 'access-3');
      expect(n, 2);
    });

    test('tanpa refresh token: sesi dianggap tidak berlaku', () async {
      final coordinator = build();
      await tokenStore.save(tokens(refresh: null));

      expect(await coordinator.refreshAfterRejection('access-1'), isNull);
      expect(await tokenStore.read(), isNull);
      expect(calls, 0);
    });

    test(
      'login ulang selama refresh berjalan: sesi baru tidak dihapus UNAUTHENTICATED lama dan dipakai ulang',
      () async {
        final gate = Completer<void>();
        var started = false;
        final coordinator = build(
          refresher: (refreshToken) async {
            started = true;
            await gate.future;
            throw apiError(401, 'UNAUTHENTICATED', 'Sesi berakhir.');
          },
        );
        var invalidated = false;
        coordinator.invalidated.listen((_) => invalidated = true);
        final result = coordinator.refreshAfterRejection('access-1');
        await pumpEventQueue();
        expect(started, isTrue);
        await tokenStore.save(tokens(access: 'access-baru', refresh: 'refresh-baru'));
        gate.complete();

        expect(await result, 'access-baru');
        expect(invalidated, isFalse);
        expect((await tokenStore.read())?.accessToken, 'access-baru');
      },
    );

    test('token berubah sebelum refresh dimulai: langsung memakai token terbaru', () async {
      final coordinator = build();
      final result = coordinator.refreshAfterRejection('access-1');
      await tokenStore.save(tokens(access: 'access-baru', refresh: 'refresh-baru'));
      expect(await result, 'access-baru');
      expect(calls, 0);
    });

    test('tanpa sesi tersimpan validAccessToken mengembalikan null', () async {
      await tokenStore.clear();
      expect(await build().validAccessToken(), isNull);
    });
  });

  group('jam perangkat melenceng dari server (PRD 2.1, AC F02-1)', () {
    late TokenStore tokenStore;
    // Jam perangkat 20 menit lebih cepat daripada server (TTL access token 15 menit).
    final deviceNow = testNow.add(const Duration(minutes: 20));
    TokenPair serverPair(int n) => TokenPair.fromJson(
      tokenPairJson(
        access: 'access-$n',
        refresh: 'refresh-$n',
        accessExpiresAt: testNow.add(const Duration(minutes: 15)),
      ),
    );

    setUp(() => tokenStore = TokenStore(MemorySecureStore()));

    test('jam server diketahui (header Date): token baru dipakai ulang tanpa refresh di setiap request', () async {
      final clock = ServerClock(clock: () => deviceNow)..observe(testNow);
      await tokenStore.save(StoredTokens.received(serverPair(1), clock));
      var n = 1;
      final coordinator = RefreshCoordinator(
        store: tokenStore,
        serverClock: clock,
        refresher: (_) async => serverPair(++n),
      );
      for (var i = 0; i < 5; i++) {
        expect(await coordinator.validAccessToken(leeway: const Duration(seconds: 10)), 'access-1');
      }
      expect(coordinator.refreshCount, 0);
    });

    test('jam server belum diketahui: token baru yang tampak sudah habis tidak memicu refresh berulang', () async {
      final clock = ServerClock(clock: () => deviceNow);
      // Data lama tanpa batas menurut jam perangkat: tampak kedaluwarsa, satu refresh.
      await tokenStore.save(
        StoredTokens(
          accessToken: 'access-0',
          accessExpiresAt: testNow.add(const Duration(minutes: 10)),
          refreshToken: 'r0',
        ),
      );
      var n = 0;
      final coordinator = RefreshCoordinator(
        store: tokenStore,
        serverClock: clock,
        refresher: (_) async => serverPair(++n),
      );
      for (var i = 0; i < 5; i++) {
        await coordinator.validAccessToken(leeway: const Duration(seconds: 10));
      }
      expect(coordinator.refreshCount, 1);
      final stored = await tokenStore.read();
      expect(stored?.clockSkewSuspected, isTrue);
      expect(stored?.deviceExpiresAt, isNull, reason: 'hanya jalur 401 yang me-refresh pasangan ini');
      // Server menolak token: refresh reaktif tetap berjalan.
      expect(await coordinator.refreshAfterRejection('access-1'), 'access-2');
    });

    test('lewat Dio: header Date menyinkronkan jam, lima request hanya memicu satu refresh', () async {
      final dateHeader = {'date': HttpDate.format(testNow)};
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/auth/refresh') {
          return FakeResponse.json(
            200,
            tokenPairJson(
              access: 'access-2',
              refresh: 'refresh-2',
              accessExpiresAt: testNow.add(const Duration(minutes: 15)),
            ),
            dateHeader,
          );
        }
        return FakeResponse.json(200, meJson(), dateHeader);
      });
      final container = makeContainer(adapter: adapter, clock: TestClock(deviceNow));
      await container
          .read(tokenStoreProvider)
          .save(
            StoredTokens(
              accessToken: 'access-1',
              accessExpiresAt: testNow.add(const Duration(minutes: 10)),
              refreshToken: 'refresh-1',
            ),
          );
      final api = container.read(kapdhApiProvider);
      for (var i = 0; i < 5; i++) {
        await api.me.getMe();
      }
      expect(adapter.requestsTo('/auth/refresh'), hasLength(1));
      expect(adapter.requestsTo('/me').map(bearer).skip(1), everyElement('Bearer access-2'));
      expect(container.read(serverClockProvider).isSynced, isTrue);
    });
  });

  group('ServerClock', () {
    test('header Date menjadi selisih jam server terhadap perangkat', () {
      final clock = ServerClock(clock: () => testNow.add(const Duration(hours: 7)));
      expect(clock.isSynced, isFalse);
      expect(clock.now(), testNow.add(const Duration(hours: 7)));
      clock.observeDateHeader(HttpDate.format(testNow));
      expect(clock.isSynced, isTrue);
      final drift = clock.now().difference(testNow);
      expect(drift.inMilliseconds, inInclusiveRange(0, 1000), reason: 'resolusi header satu detik');
      expect(
        clock.toDeviceTime(testNow).difference(testNow.add(const Duration(hours: 7))).inSeconds.abs(),
        lessThan(1),
      );
    });

    test('respons dari cache perantara: umur cache (Age) ditambahkan', () {
      final clock = ServerClock(clock: () => testNow)
        ..observeDateHeader(HttpDate.format(testNow.subtract(const Duration(minutes: 5))), age: '300');
      expect(clock.now().difference(testNow).inMilliseconds.abs(), lessThanOrEqualTo(1000));
    });

    test('header kosong atau rusak diabaikan', () {
      final clock = ServerClock(clock: () => testNow)
        ..observeDateHeader(null)
        ..observeDateHeader('')
        ..observeDateHeader('bukan tanggal');
      expect(clock.isSynced, isFalse);
      expect(clock.offset, Duration.zero);
    });
  });
}
