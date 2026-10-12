import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/api/api_signals.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';

import '../support/fakes.dart';

void main() {
  test('setiap request membawa X-App-Version, X-App-Platform dan X-Request-Id (PRD 4.5, N-14)', () async {
    final adapter = FakeHttpAdapter((_) => FakeResponse.json(200, publicConfigJson()));
    final container = makeContainer(adapter: adapter);

    await container.read(kapdhApiProvider).public.getPublicConfig();
    await container.read(kapdhApiProvider).public.getPublicConfig();

    final first = adapter.requests.first.headers;
    expect(first['X-App-Version'], '1.2.0');
    expect(first['X-App-Platform'], 'android');
    expect(first['X-Request-Id'], matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-')));
    expect(adapter.requests.last.headers['X-Request-Id'], isNot(first['X-Request-Id']));
  });

  test('request yang diulang setelah refresh mempertahankan X-Request-Id', () async {
    final adapter = FakeHttpAdapter((options) {
      if (options.path == '/auth/refresh') return FakeResponse.json(200, tokenPairJson(access: 'access-2'));
      if (options.headers['Authorization'] == 'Bearer access-2') return FakeResponse.json(200, meJson());
      return FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.'));
    });
    final container = makeContainer(adapter: adapter);
    await container
        .read(tokenStoreProvider)
        .save(
          StoredTokens(
            accessToken: 'access-1',
            accessExpiresAt: testNow.add(const Duration(minutes: 5)),
            refreshToken: 'r',
          ),
        );

    await container.read(kapdhApiProvider).me.getMe();

    final ids = adapter.requestsTo('/me').map((r) => r.headers['X-Request-Id']).toSet();
    expect(ids, hasLength(1));
  });

  test(
    'galat global memancarkan sinyal: MAINTENANCE, UPGRADE_REQUIRED, MEMBERSHIP_REQUIRED, ACCOUNT_SUSPENDED',
    () async {
      final responses = {
        '/a': FakeResponse.json(503, errorJson('MAINTENANCE', 'Pemeliharaan', retryAfterSeconds: 120)),
        '/b': FakeResponse.json(426, errorJson('UPGRADE_REQUIRED', 'Perbarui')),
        '/c': FakeResponse.json(403, errorJson('MEMBERSHIP_REQUIRED', 'Perlu KTA aktif')),
        '/d': FakeResponse.json(403, errorJson('ACCOUNT_SUSPENDED', 'Dibatasi')),
        '/e': FakeResponse.json(400, errorJson('VALIDATION_ERROR', 'Periksa')),
      };
      final container = makeContainer(adapter: FakeHttpAdapter((options) => responses[options.path]!));
      final signals = <ApiSignal>[];
      container.read(apiSignalsProvider).stream.listen(signals.add);
      final dio = container.read(dioProvider);

      for (final path in responses.keys) {
        await dio.get<Object?>(path).then<void>((_) {}, onError: (Object _) {});
      }
      await pumpEventQueue();

      expect(signals, hasLength(4));
      expect(
        signals[0],
        isA<MaintenanceSignal>().having((s) => s.retryAfter, 'retryAfter', const Duration(minutes: 2)),
      );
      expect(signals[1], isA<UpgradeRequiredSignal>());
      expect(signals[2], isA<StatusStaleSignal>());
      expect(signals[3], isA<StatusStaleSignal>());
    },
  );

  test('respons non-JSON (HTML 502 proxy) bukan offline: invalidResponse dengan aksi coba lagi', () async {
    final container = makeContainer(adapter: FakeHttpAdapter((_) => FakeResponse.raw(502, '<html>Bad gateway</html>')));
    await expectLater(
      container.read(kapdhApiProvider).public.getPublicConfig(),
      throwsA(
        isA<ApiException>()
            .having((e) => e.kind, 'kind', ApiFailureKind.invalidResponse)
            .having((e) => e.ui.action, 'action', ErrorUiAction.showRetry),
      ),
    );
  });
}
