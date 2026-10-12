import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/api/api_signals.dart';
import 'package:kapdh_mobile/core/app_gate/app_gate.dart';
import 'package:kapdh_mobile/core/config/app_info.dart';

import '../support/fakes.dart';

void main() {
  group('evaluateConfig (PRD 4.5)', () {
    test('versi di bawah min_app_version platform: wajib update', () {
      final state = evaluateConfig(configOf(android: '1.3.0'), testAppInfo, testNow);
      expect(state.status, GateStatus.updateRequired);
      expect(state.storeLinks?.android, contains('play.google.com'));
    });

    test('versi sama atau lebih baru: ok', () {
      expect(evaluateConfig(configOf(android: '1.2.0'), testAppInfo, testNow).status, GateStatus.ok);
      expect(evaluateConfig(configOf(android: '1.1.9'), testAppInfo, testNow).status, GateStatus.ok);
    });

    test('perbandingan semver, bukan string', () {
      expect(isBelowMinimum(current: '1.10.0', minimum: '1.9.0'), isFalse);
      expect(isBelowMinimum(current: '1.9.0', minimum: '1.10.0'), isTrue);
      expect(isBelowMinimum(current: '1.2.0-beta.1', minimum: '1.2.0'), isTrue);
      expect(isBelowMinimum(current: 'tidak-valid', minimum: '1.0.0'), isFalse);
    });

    test('versi iOS memakai min_app_version.ios', () {
      const ios = AppInfo(version: '1.0.0', buildNumber: '1', platform: DevicePlatform.ios);
      final config = PublicConfig.fromJson(publicConfigJson(android: '9.0.0', ios: '1.0.0'));
      expect(evaluateConfig(config, ios, testNow).status, GateStatus.ok);
    });

    test('maintenance aktif membawa pesan dan estimasi', () {
      final until = testNow.add(const Duration(hours: 2));
      final state = evaluateConfig(
        configOf(maintenance: true, maintenanceMessage: 'Peningkatan server', maintenanceUntil: until),
        testAppInfo,
        testNow,
      );
      expect(state.status, GateStatus.maintenance);
      expect(state.maintenanceMessage, 'Peningkatan server');
      expect(state.maintenanceUntil, until);
    });

    test('wajib update didahulukan dari maintenance', () {
      expect(
        evaluateConfig(configOf(android: '2.0.0', maintenance: true), testAppInfo, testNow).status,
        GateStatus.updateRequired,
      );
    });
  });

  group('AppGateController', () {
    test('GET /public/config tanpa bearer menentukan status (http_mock_adapter)', () async {
      final dio = Dio(BaseOptions(baseUrl: testApiConfig.baseUrl));
      final mock = DioAdapter(dio: dio)
        ..onGet('/public/config', (server) => server.reply(200, publicConfigJson(android: '1.5.0')));
      final container = makeContainer(adapter: mock);

      expect(container.read(appGateProvider).status, GateStatus.checking);
      await container.read(appGateProvider.notifier).check();

      expect(container.read(appGateProvider).status, GateStatus.updateRequired);
      expect(container.read(appGateProvider).config?.minAppVersion.android, '1.5.0');
    });

    test('offline saat splash: tidak memblokir (unavailable)', () async {
      final container = makeContainer(adapter: FakeHttpAdapter((_) => FakeResponse.network()));
      await container.read(appGateProvider.notifier).check();
      expect(container.read(appGateProvider).status, GateStatus.unavailable);
    });

    test('503 MAINTENANCE dari /public/config memakai retry_after_seconds sebagai estimasi', () async {
      final container = makeContainer(
        adapter: FakeHttpAdapter(
          (_) => FakeResponse.json(503, errorJson('MAINTENANCE', 'Sedang pemeliharaan.', retryAfterSeconds: 600)),
        ),
      );
      await container.read(appGateProvider.notifier).check();
      final state = container.read(appGateProvider);
      expect(state.status, GateStatus.maintenance);
      expect(state.maintenanceMessage, 'Sedang pemeliharaan.');
      expect(state.maintenanceUntil, testNow.add(const Duration(minutes: 10)));
    });

    test('sinyal global dari request mana pun: 503 → maintenance, 426 → wajib update', () async {
      final container = makeContainer(adapter: FakeHttpAdapter((_) => FakeResponse.json(200, publicConfigJson())));
      await container.read(appGateProvider.notifier).check();
      expect(container.read(appGateProvider).status, GateStatus.ok);
      final signals = container.read(apiSignalsProvider);

      signals.emit(const MaintenanceSignal(message: 'Pemeliharaan malam', retryAfter: Duration(minutes: 30)));
      await Future<void>.delayed(Duration.zero);
      expect(container.read(appGateProvider).status, GateStatus.maintenance);
      expect(container.read(appGateProvider).maintenanceUntil, testNow.add(const Duration(minutes: 30)));

      signals.emit(const UpgradeRequiredSignal());
      await Future<void>.delayed(Duration.zero);
      expect(container.read(appGateProvider).status, GateStatus.updateRequired);
    });

    test('respons 426 dari mutasi memancarkan sinyal wajib update lewat interceptor', () async {
      final adapter = FakeHttpAdapter((options) {
        if (options.path == '/public/config') return FakeResponse.json(200, publicConfigJson());
        return FakeResponse.json(426, errorJson('UPGRADE_REQUIRED', 'Perbarui aplikasi.'));
      });
      final container = makeContainer(adapter: adapter);
      await container.read(appGateProvider.notifier).check();

      await expectLater(
        container.read(kapdhApiProvider).auth.resendOtp(const OtpResendRequest(challengeId: 'c')),
        throwsA(isA<ApiException>()),
      );
      await Future<void>.delayed(Duration.zero);
      expect(container.read(appGateProvider).status, GateStatus.updateRequired);
    });

    test('recheckIfStale tidak memanggil ulang dalam 5 menit saat status ok', () async {
      final clock = TestClock();
      final adapter = FakeHttpAdapter((_) => FakeResponse.json(200, publicConfigJson()));
      final container = makeContainer(adapter: adapter, clock: clock);
      final gate = container.read(appGateProvider.notifier);
      await gate.check();
      await gate.recheckIfStale();
      expect(adapter.requestsTo('/public/config'), hasLength(1));

      clock.advance(const Duration(minutes: 6));
      await gate.recheckIfStale();
      expect(adapter.requestsTo('/public/config'), hasLength(2));
    });
  });
}
