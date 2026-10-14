// N-03 (PRD 2.4): p95 konten pertama dapat digunakan <= 3 detik pada profil jaringan uji 10 Mbps dan RTT 100 ms.
//
// Model jalur kritis klien yang dipakai bersama oleh uji host (test/perf, jam uji fake async) dan uji perangkat
// (integration_test, jam dinding perangkat nyata): setiap request ke API tiruan ditahan selama RTT + waktu server p95
// (N-01, baca sederhana <= 500 ms) + waktu transfer isi respons pada 10 Mbps, ditambah jabat tangan TCP + TLS 1.3
// (2 RTT) untuk koneksi pertama. Aplikasi dibuka dengan sesi tersimpan tanpa cache (kasus terburuk) sampai konten
// pertama yang dapat dipakai tampil.

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../features/home/content_fixtures.dart';
import '../features/home/feature_harness.dart';
import '../features/payments/payments_fixtures.dart';
import 'app_harness.dart';
import 'fakes.dart';

/// Profil jaringan uji N-03.
const n03Rtt = Duration(milliseconds: 100);
const n03BitsPerSecond = 10 * 1000 * 1000;

/// Waktu server p95 untuk baca sederhana (N-01).
const n01ServerP95 = Duration(milliseconds: 500);

/// Anggaran N-03.
const n03Budget = Duration(seconds: 3);

/// Catatan satu request: kapan dikirim dan kapan jawabannya tiba (sejak aplikasi dibuka).
class TimedRequest {
  TimedRequest(this.path, this.start, this.end);

  final String path;
  final Duration start;
  final Duration end;

  @override
  String toString() => '$path ${start.inMilliseconds}-${end.inMilliseconds} ms';
}

/// Menunda setiap jawaban [inner] sesuai profil N-03 dan mencatatnya ke [log]. [elapsed] adalah waktu sejak
/// aplikasi dibuka.
FakeHandler shapeN03(FakeHandler inner, List<TimedRequest> log, Duration Function() elapsed) {
  var connected = false;
  return (RequestOptions options) async {
    final start = elapsed();
    final response = await inner(options);
    final bytes = utf8.encode(response.raw ?? (response.body == null ? '' : jsonEncode(response.body))).length;
    final transfer = Duration(microseconds: (bytes * 8 * 1000000 / n03BitsPerSecond).ceil());
    // Koneksi pertama: TCP (1 RTT) + TLS 1.3 (1 RTT); berikutnya dipakai ulang (keep-alive, HTTP/2).
    final handshake = connected ? Duration.zero : n03Rtt * 2;
    connected = true;
    await Future<void>.delayed(handshake + n03Rtt + n01ServerP95 + transfer);
    log.add(TimedRequest(options.path, start, elapsed()));
    return response;
  };
}

/// Satu layar yang diukur: rute, jawaban API dan penanda konten pertama yang dapat dipakai.
class FirstContentScenario {
  const FirstContentScenario({required this.name, required this.routes, required this.ready, this.location});

  final String name;

  /// Dibuka setelah aplikasi dipasang; null = rute awal anggota aktif (Beranda).
  final String? location;
  final Map<String, FakeHandler> Function() routes;
  final Finder Function() ready;
}

/// Layar N-03 (U-13): Beranda, KTA dan Berita.
final firstContentScenarios = <FirstContentScenario>[
  FirstContentScenario(
    name: 'Beranda',
    routes: () => {'/home': (_) => FakeResponse.json(200, homeJson())},
    ready: () => find.bySemanticsLabel(RegExp('^Banner 1 dari 1')),
  ),
  FirstContentScenario(
    name: 'KTA',
    location: '/kta',
    routes: () => {
      '/home': (_) => FakeResponse.json(200, homeJson()),
      '/me/card': (_) => FakeResponse.json(200, memberCardJson(expiresAt: DateTime.utc(2027, 10, 12, 7))),
      '/me/fees': (_) => FakeResponse.json(200, feesJson()),
    },
    ready: () => find.byType(KtaCard),
  ),
  FirstContentScenario(
    name: 'Berita',
    location: '/news',
    routes: () => {
      '/home': (_) => FakeResponse.json(200, homeJson()),
      '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
      '/posts': (_) => FakeResponse.json(200, postPageJson([postSummaryJson()])),
    },
    ready: () => find.text('Halal Bihalal Alumni 2026'),
  ),
];

/// Membuka aplikasi dengan sesi tersimpan tanpa cache (kasus terburuk), lalu [FirstContentScenario.location] bila ada,
/// dan mengukur waktu sampai [FirstContentScenario.ready] tampil.
///
/// [elapsed] membaca waktu sejak aplikasi dibuka; [step] memompa satu frame dan memajukan waktu (uji host: jam uji
/// dimajukan manual; perangkat: frame nyata dengan jeda jam dinding). [phoneSize] false memakai layar perangkat apa
/// adanya. [routes] mengganti jawaban skenario (kontrol waterfall).
Future<Duration> timeToFirstContent(
  WidgetTester tester,
  FirstContentScenario scenario, {
  required Duration Function() elapsed,
  required Future<void> Function() step,
  Map<String, FakeHandler>? routes,
  bool phoneSize = true,
  Duration limit = const Duration(seconds: 10),
}) async {
  final log = <TimedRequest>[];
  final handler = shapeN03(
    apiRoutes({'/me': (_) => FakeResponse.json(200, meJson()), ...(routes ?? scenario.routes())}),
    log,
    elapsed,
  );
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    settle: false,
    phoneSize: phoneSize,
    overrides: [testImagesOverride],
    handler: handler,
  );
  final location = scenario.location;
  if (location != null) app.router.go(location);
  final ready = scenario.ready();
  while (ready.evaluate().isEmpty) {
    if (elapsed() > limit) fail('Konten pertama ${scenario.name} tidak tampil dalam ${limit.inSeconds} detik: $log');
    await step();
  }
  final result = elapsed();
  debugPrint('N-03 ${scenario.name}: ${result.inMilliseconds} ms (anggaran ${n03Budget.inMilliseconds} ms); $log');
  // Tidak ada request yang tertinggal sesudah pengukuran.
  await settle(tester);
  return result;
}

/// Persentil [p] (0..1) metode nearest-rank.
Duration percentile(List<Duration> samples, double p) {
  assert(samples.isNotEmpty && p > 0 && p <= 1);
  final sorted = [...samples]..sort();
  final rank = (p * sorted.length).ceil();
  return sorted[rank - 1];
}
