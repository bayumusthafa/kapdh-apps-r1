import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/config/api_config.dart';
import 'package:kapdh_mobile/features/system/config_error_app.dart';

void main() {
  group('ApiConfig.resolve (PRD 5.3, N-07)', () {
    test('debug tanpa dart-define: pengembangan lokal (emulator Android)', () {
      final config = ApiConfig.resolve(rawEnv: null, releaseMode: false);
      expect(config.environment, AppEnvironment.development);
      expect(config.baseUrl, 'http://10.0.2.2:3000/api/v1');
    });

    test('rilis wajib menyebut KAPDH_ENV: build yang lupa --dart-define-from-file ditolak', () {
      expect(
        () => ApiConfig.resolve(rawEnv: null, releaseMode: true),
        throwsA(isA<ApiConfigException>().having((e) => e.message, 'message', contains('KAPDH_ENV'))),
      );
      expect(() => ApiConfig.resolve(rawEnv: '  ', releaseMode: true), throwsA(isA<ApiConfigException>()));
    });

    test('rilis tidak boleh development atau API cleartext', () {
      expect(() => ApiConfig.resolve(rawEnv: 'development', releaseMode: true), throwsA(isA<ApiConfigException>()));
      expect(
        () => ApiConfig.resolve(rawEnv: 'staging', rawBase: 'http://staging-api.kapdh.or.id/api/v1', releaseMode: true),
        throwsA(isA<ApiConfigException>()),
      );
    });

    test('rilis staging/production memakai URL https bawaan atau dari API_BASE_URL', () {
      final production = ApiConfig.resolve(rawEnv: 'production', releaseMode: true);
      expect(production.baseUrl, 'https://api.kapdh.or.id/api/v1');
      final staging = ApiConfig.resolve(
        rawEnv: 'staging',
        rawBase: 'https://staging-api.kapdh.or.id/api/v1',
        releaseMode: true,
      );
      expect(staging.environment, AppEnvironment.staging);
      expect(staging.realtimeUri.toString(), 'https://staging-api.kapdh.or.id/realtime');
    });

    test('nilai tidak dikenal atau URL rusak menjadi ApiConfigException yang jelas', () {
      expect(() => ApiConfig.resolve(rawEnv: 'prod', releaseMode: false), throwsA(isA<ApiConfigException>()));
      expect(
        () => ApiConfig.resolve(rawEnv: 'development', rawBase: 'http://localhost:3000/api', releaseMode: false),
        throwsA(isA<ApiConfigException>()),
      );
    });
  });

  testWidgets('layar galat konfigurasi menjelaskan dan tidak meluap pada teks 200 %', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const ConfigErrorApp(detail: 'Build rilis tidak boleh memakai KAPDH_ENV=development.'));
    expect(find.text('Aplikasi belum dapat dijalankan'), findsOneWidget);
    expect(find.textContaining('KAPDH_ENV=development'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
