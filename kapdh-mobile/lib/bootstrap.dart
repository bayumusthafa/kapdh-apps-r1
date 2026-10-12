import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'app/app.dart';
import 'app/app_services.dart';
import 'core/api/api_providers.dart';
import 'core/config/api_config.dart';
import 'core/config/app_info.dart';
import 'core/format/formatters.dart';
import 'features/system/config_error_app.dart';

/// Inisialisasi aplikasi sebelum frame pertama (PRD 4.6 splash, N-03): format tanggal Indonesia dan zona waktu,
/// identitas build untuk X-App-Version/X-App-Platform, konfigurasi API dari `--dart-define`. Push dimulai setelah
/// frame pertama agar tidak menunda tampilan; kegagalannya tidak menghentikan aplikasi (AC F13-2).
Future<void> bootstrap() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Galat tak tertangani dicatat tanpa data pribadi; pelaporan ke GlitchTip ditambahkan tim ops (PRD 5.5).
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    debugPrint('Galat tak tertangani: ${error.runtimeType}');
    if (kDebugMode) debugPrintStack(stackTrace: stack);
    return true;
  };

  await initFormatting();
  final ApiConfig config;
  try {
    config = ApiConfig.fromEnvironment();
  } on ApiConfigException catch (error) {
    // Build rilis tanpa lingkungan staging/production atau tanpa https: berhenti di layar galat konfigurasi
    // (PRD 5.3, N-07), bukan berjalan diam-diam ke API pengembangan.
    debugPrint(error.toString());
    runApp(ConfigErrorApp(detail: error.message));
    return;
  }
  final package = await PackageInfo.fromPlatform();
  final info = AppInfo(version: package.version, buildNumber: package.buildNumber, platform: AppInfo.currentPlatform());

  final container = ProviderContainer(
    overrides: [appInfoProvider.overrideWithValue(info), apiConfigProvider.overrideWithValue(config)],
  );
  runApp(UncontrolledProviderScope(container: container, child: const KapdhApp()));

  // Notifikasi yang membuka aplikasi dari keadaan mati diteruskan ke router setelah frame pertama (AC F13-3).
  WidgetsBinding.instance.addPostFrameCallback((_) {
    unawaited(container.read(pushServiceProvider).start());
  });
}
