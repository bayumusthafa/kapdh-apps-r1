// N-12 (PRD 2.4, matriks D7) dan N-03: smoke alur kritis aplikasi anggota di perangkat/emulator NYATA.
//
// Uji widget di test/ berjalan di harness host Flutter. Berkas ini menjalankan aplikasi yang sama (router, redirect,
// gerbang dan sesi asli) di perangkat sasaran D7 (Android 8.0+, iOS 15+; docs/qa/device-matrix.md) sehingga render,
// input teks, plugin platform dan kecepatan perangkat ikut diuji:
// - masuk, sesi tersimpan di Android Keystore / iOS Keychain ASLI (flutter_secure_storage), dibuka ulang, lalu keluar
//   menghapus data akun privat dari penyimpanan perangkat (PRD 5.2);
// - KTA aktif dengan QR;
// - kirim bukti pembayaran sampai Menunggu Verifikasi (AC F03-2);
// - N-03: p95 waktu konten pertama Beranda, KTA dan Berita pada profil jaringan uji 10 Mbps / RTT 100 ms dengan
//   server p95 N-01 (model test/support/first_content.dart), diukur dengan jam dinding perangkat. Anggaran hanya
//   ditegakkan pada build profile/release: build debug (JIT, assert aktif) jauh lebih lambat dan bukan ukuran N-03.
//
// API dijawab tiruan di dalam proses (tanpa backend) agar smoke dapat diulang di setiap perangkat matriks; alur
// dengan backend staging tetap bagian UAT (U-13). Jalankan:
//   flutter test integration_test/critical_flows_test.dart -d <id perangkat>              # smoke (debug)
//   flutter drive --profile --driver=test_driver/integration_test.dart \
//     --target=integration_test/critical_flows_test.dart -d <id perangkat>               # smoke + N-03
// Opsional --dart-define=N03_SAMPLES=50 (0 = smoke saja). Hasil N-03 ditulis ke build/integration_response_data.json
// (flutter drive).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:integration_test/integration_test.dart';
import 'package:kapdh_mobile/app/theme/kapdh_theme.dart';
import 'package:kapdh_mobile/core/api/idempotency_store.dart';
import 'package:kapdh_mobile/core/cache/home_cache_store.dart';
import 'package:kapdh_mobile/core/cache/kta_cache_store.dart';
import 'package:kapdh_mobile/core/format/formatters.dart';
import 'package:kapdh_mobile/core/session/me_snapshot_store.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';
import 'package:kapdh_mobile/design/design.dart';
import 'package:kapdh_mobile/features/auth/login_screen.dart';
import 'package:kapdh_mobile/features/notifications/notifications_repository.dart';
import 'package:kapdh_mobile/features/payments/proof_file.dart';

import '../test/features/home/content_fixtures.dart';
import '../test/features/payments/payments_fixtures.dart';
import '../test/support/app_harness.dart';
import '../test/support/fakes.dart';
import '../test/support/first_content.dart';

/// Jumlah sampel N-03 per layar (p95 nearest-rank: dari 20 sampel hanya sampel terlama yang diabaikan).
const _samples = int.fromEnvironment('N03_SAMPLES', defaultValue: 20);

/// Mode build pengukuran. Anggaran N-03 hanya ditegakkan bila kode dikompilasi AOT seperti build toko aplikasi.
const _buildMode = kReleaseMode ? 'release' : (kProfileMode ? 'profile' : 'debug');
const _enforceN03 = kReleaseMode || kProfileMode;

/// Kunci data akun privat yang wajib hilang dari penyimpanan perangkat setelah logout (PRD 5.2).
const _privateKeys = [
  TokenStore.storageKey,
  MeSnapshotStore.storageKey,
  HomeCacheStore.storageKey,
  KtaCacheStore.storageKey,
  IdempotencyStore.storageKey,
];

Finder _field(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextFormField));

/// Memompa frame sampai [done] terpenuhi lalu menunggu tenang. Plugin perangkat (Keystore/Keychain) menyelesaikan
/// pekerjaannya tanpa menjadwalkan frame, sehingga pumpAndSettle saja dapat berhenti sebelum alur selesai di perangkat
/// yang lambat.
Future<void> _pumpUntil(
  WidgetTester tester,
  FutureOr<bool> Function() done, {
  required String what,
  String Function()? where,
  Duration timeout = const Duration(seconds: 30),
}) async {
  final watch = Stopwatch()..start();
  while (!await done()) {
    if (watch.elapsed > timeout) {
      final texts = tester.widgetList<Text>(find.byType(Text)).map((text) => text.data).nonNulls.take(30);
      fail(
        '$what tidak tercapai dalam ${timeout.inSeconds} detik (${where?.call() ?? '-'}). Teks: ${texts.join(' | ')}',
      );
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  await settle(tester);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // Font sistem perangkat (tanpa unduhan Google Fonts) agar hasil tidak bergantung jaringan perangkat uji.
    KapdhTheme.runtimeFonts = false;
    GoogleFonts.config.allowRuntimeFetching = false;
    await initFormatting();
  });

  group('N-12 smoke alur kritis di perangkat', () {
    testWidgets('masuk: token di Keystore/Keychain perangkat, sesi pulih saat dibuka ulang, keluar menghapus data '
        'privat (PRD 5.2)', (tester) async {
      final store = FlutterSecureStore();
      for (final key in _privateKeys) {
        await store.delete(key);
      }
      final routes = apiRoutes({
        '/auth/login': (_) => FakeResponse.json(200, {'next': 'home', 'session': tokenPairJson()}),
        '/auth/logout': (_) => FakeResponse.json(204),
        '/me': (_) => FakeResponse.json(200, meJson()),
        '/home': (_) => FakeResponse.json(200, homeJson()),
        '/me/card': (_) => FakeResponse.json(200, memberCardJson(expiresAt: DateTime.utc(2027, 10, 12, 7))),
        '/me/fees': (_) => FakeResponse.json(200, feesJson()),
      });

      late AppHarness app;
      bool atHome() => app.location == '/home' && find.text('Ahmad Islam').evaluate().isNotEmpty;
      app = await pumpApp(tester, handler: routes, store: store, phoneSize: false);
      await _pumpUntil(tester, () => find.byType(LoginScreen).evaluate().isNotEmpty, what: 'layar Masuk');
      // Isian lewat TestTextInput, bukan keyboard sistem: keyboard perangkat yang terbuka dapat mengirim ulang isi
      // kosong miliknya dan mengubah tata letak saat tombol diketuk (integration_test tidak mendaftarkannya).
      tester.testTextInput.register();
      addTearDown(tester.testTextInput.unregister);
      await tester.enterText(_field('login-email'), 'ahmad@email.com');
      await tester.enterText(_field('login-password'), 'Rahasia#123');
      FocusManager.instance.primaryFocus?.unfocus();
      await settle(tester);
      expect(tester.widget<KapdhButton>(find.byKey(const ValueKey('login-submit'))).onPressed, isNotNull);
      await scrollAndTap(tester, find.byKey(const ValueKey('login-submit')));
      await _pumpUntil(tester, atHome, what: 'Beranda setelah masuk', where: () => app.location);
      expect(app.location, '/home');
      expect(await store.read(TokenStore.storageKey), isNotNull, reason: 'token di penyimpanan aman perangkat');

      // Proses baru (container dan pohon widget baru) memulihkan sesi dari penyimpanan perangkat tanpa login.
      app = await pumpApp(tester, handler: routes, store: store, phoneSize: false);
      await _pumpUntil(tester, atHome, what: 'Beranda dari sesi tersimpan', where: () => app.location);
      expect(app.location, '/home');
      app.router.go('/kta');
      await _pumpUntil(tester, () => find.byType(KtaCard).evaluate().isNotEmpty, what: 'KTA');
      // KTA offline disimpan ke penyimpanan perangkat (ditulis di latar setelah kartu tampil).
      await _pumpUntil(tester, () async => await store.read(KtaCacheStore.storageKey) != null, what: 'cache KTA');

      await app.container.read(sessionProvider.notifier).logout();
      await _pumpUntil(tester, () => app.location.startsWith('/login'), what: 'layar Masuk setelah keluar');
      for (final key in _privateKeys) {
        expect(await store.read(key), isNull, reason: '$key dihapus dari penyimpanan perangkat saat logout');
      }
    });

    testWidgets('KTA aktif: kartu, nomor anggota dan QR tampil di layar perangkat', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        phoneSize: false,
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson()),
          '/home': (_) => FakeResponse.json(200, homeJson()),
          '/me/card': (_) => FakeResponse.json(200, memberCardJson(expiresAt: DateTime.utc(2027, 10, 12, 7))),
          '/me/fees': (_) => FakeResponse.json(200, feesJson()),
        }),
      );
      app.router.go('/kta');
      await settle(tester);
      expect(find.byType(KtaCard), findsOneWidget);
      expect(find.text('29.01.01.7'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('bukti pembayaran: pilih, unggah dan kirim sampai Menunggu Verifikasi (AC F03-2)', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        phoneSize: false,
        overrides: [
          proofPickerProvider.overrideWithValue(FakeProofPicker()),
          notificationCreatedEventsProvider.overrideWithValue(const Stream.empty()),
        ],
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: 'unverified')),
          '/me/fees': (_) => FakeResponse.json(200, feesJson()),
          '/me/membership': (_) => FakeResponse.json(200, membershipJson(status: 'unverified')),
          '/payment-methods': (_) => FakeResponse.json(200, methodsJson()),
          '/me/payments/pay-1': (_) => FakeResponse.json(200, awaitingTransferJson()),
          '/files': (_) => FakeResponse.json(201, fileRefJson()),
          '/me/payments/pay-1/proof': (_) => FakeResponse.json(200, awaitingReviewJson(proofFileId: 'file-2')),
        }),
      );
      app.router.go('/payments/pay-1');
      await settle(tester);
      expect(find.text('Transfer tepat sebesar'), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-upload-tile')));
      await settle(tester);
      await tester.tap(find.text('Pilih dari galeri'));
      await settle(tester);
      expect(find.text('bukti-transfer.jpg'), findsOneWidget);
      await scrollAndTap(tester, find.byKey(const ValueKey('proof-submit')));
      await settle(tester);
      expect(app.adapter.requestsTo('/me/payments/pay-1/proof'), hasLength(1));
      expect(find.text('Bukti pembayaran sedang diperiksa'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('N-03 p95 konten pertama di perangkat (10 Mbps / RTT 100 ms, server p95 N-01)', () {
    final report = <String, Object?>{'build_mode': _buildMode, 'budget': n03Budget.inMilliseconds};
    tearDownAll(() => binding.reportData = {'n03_first_content_ms': report});

    for (final scenario in firstContentScenarios) {
      testWidgets(
        '${scenario.name}: p95 dari $_samples kali buka tanpa cache (anggaran ${n03Budget.inMilliseconds} ms)',
        (tester) async {
          final samples = <Duration>[];
          for (var i = 0; i < _samples; i++) {
            final watch = Stopwatch()..start();
            samples.add(
              await timeToFirstContent(
                tester,
                scenario,
                phoneSize: false,
                elapsed: () => watch.elapsed,
                step: () => tester.pump(const Duration(milliseconds: 4)),
              ),
            );
            // Pohon kosong agar sampel berikutnya mulai dari aplikasi yang baru dibuka.
            await tester.pumpWidget(const SizedBox.shrink());
          }
          final p50 = percentile(samples, 0.5);
          final p95 = percentile(samples, 0.95);
          report[scenario.name] = {
            'samples': [for (final sample in samples) sample.inMilliseconds],
            'p50': p50.inMilliseconds,
            'p95': p95.inMilliseconds,
          };
          // debugPrint tetap tercetak pada build profile/release.
          debugPrint(
            'N-03 perangkat ${scenario.name}: p50 ${p50.inMilliseconds} ms, p95 ${p95.inMilliseconds} ms '
            '(n=$_samples, build $_buildMode, anggaran ${n03Budget.inMilliseconds} ms'
            '${_enforceN03 ? '' : '; tidak ditegakkan pada build debug, jalankan flutter drive --profile'})',
          );
          if (_enforceN03) expect(p95, lessThanOrEqualTo(n03Budget));
        },
        // N03_SAMPLES=0: hanya smoke N-12.
        skip: _samples == 0,
      );
    }
  });
}
