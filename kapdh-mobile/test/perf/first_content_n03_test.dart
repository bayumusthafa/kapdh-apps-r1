// N-03 (PRD 2.4): p95 konten pertama dapat digunakan <= 3 detik pada profil jaringan uji 10 Mbps dan RTT 100 ms.
//
// Uji ini memodelkan jalur kritis KLIEN pada profil jaringan N-03 secara deterministik: setiap request ke API tiruan
// ditahan selama RTT + waktu server p95 (N-01, baca sederhana <= 500 ms) + waktu transfer isi respons pada 10 Mbps,
// ditambah jabat tangan TCP + TLS 1.3 (2 RTT) untuk koneksi pertama. Waktu dihitung dengan jam uji Flutter (fake
// async), dari aplikasi dibuka dengan sesi tersimpan tanpa cache (kasus terburuk) sampai konten pertama yang dapat
// dipakai tampil. Yang tertangkap: rantai request berurutan (waterfall), request yang menahan layar, dan kerangka yang
// tidak pernah selesai. Yang TIDAK tertangkap: kinerja render perangkat nyata, DNS, dan waktu server sebenarnya;
// pengukuran p95 pada perangkat sasaran D7 dengan network shaping tetap dicatat di laporan UAT (U-13).

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/design/design.dart';

import '../features/home/content_fixtures.dart';
import '../features/home/feature_harness.dart';
import '../features/payments/payments_fixtures.dart';
import '../support/app_harness.dart';
import '../support/fakes.dart';

/// Profil jaringan uji N-03.
const _rtt = Duration(milliseconds: 100);
const _bitsPerSecond = 10 * 1000 * 1000;

/// Waktu server p95 untuk baca sederhana (N-01).
const _serverP95 = Duration(milliseconds: 500);

/// Anggaran N-03.
const _budget = Duration(seconds: 3);

/// Resolusi pengukuran.
const _step = Duration(milliseconds: 10);

/// Catatan satu request: kapan dikirim dan kapan jawabannya tiba (jam uji).
class _Timed {
  _Timed(this.path, this.start, this.end);

  final String path;
  final Duration start;
  final Duration end;

  @override
  String toString() => '$path ${start.inMilliseconds}-${end.inMilliseconds} ms';
}

/// Menunda setiap jawaban [inner] sesuai profil N-03 dan mencatatnya ke [log]. [elapsed] adalah jam uji sejak
/// aplikasi dibuka.
FakeHandler _shaped(FakeHandler inner, List<_Timed> log, Duration Function() elapsed) {
  var connected = false;
  return (RequestOptions options) async {
    final start = elapsed();
    final response = await inner(options);
    final bytes = utf8.encode(response.raw ?? (response.body == null ? '' : jsonEncode(response.body))).length;
    final transfer = Duration(microseconds: (bytes * 8 * 1000000 / _bitsPerSecond).ceil());
    // Koneksi pertama: TCP (1 RTT) + TLS 1.3 (1 RTT); berikutnya dipakai ulang (keep-alive, HTTP/2).
    final handshake = connected ? Duration.zero : _rtt * 2;
    connected = true;
    await Future<void>.delayed(handshake + _rtt + _serverP95 + transfer);
    log.add(_Timed(options.path, start, elapsed()));
    return response;
  };
}

/// Membuka aplikasi dengan sesi tersimpan tanpa cache (kasus terburuk), lalu [location] bila ada, dan mengukur waktu
/// (jam uji) sampai [ready] tampil.
Future<Duration> _timeToFirstContent(
  WidgetTester tester, {
  required Map<String, FakeHandler> routes,
  required Finder ready,
  String? location,
}) async {
  var elapsed = Duration.zero;
  final log = <_Timed>[];
  final handler = _shaped(
    apiRoutes({'/me': (_) => FakeResponse.json(200, meJson()), ...routes}),
    log,
    () => elapsed,
  );
  final app = await pumpApp(
    tester,
    tokens: savedTokens(),
    settle: false,
    overrides: [testImagesOverride],
    handler: handler,
  );
  if (location != null) app.router.go(location);
  while (ready.evaluate().isEmpty) {
    if (elapsed > const Duration(seconds: 10)) {
      fail('Konten pertama tidak tampil dalam 10 detik. Request: $log');
    }
    await tester.pump(_step);
    elapsed += _step;
  }
  debugPrint('N-03 ${location ?? app.location}: ${elapsed.inMilliseconds} ms (anggaran ${_budget.inMilliseconds} ms); '
      'request: $log');
  // Tidak ada request yang tertinggal sesudah pengukuran.
  await settle(tester);
  return elapsed;
}

void main() {
  group('N-03 jalur kritis klien pada profil 10 Mbps / RTT 100 ms (server p95 N-01)', () {
    testWidgets('Beranda: rute awal anggota aktif, kartu ringkas dan banner dari GET /home', (tester) async {
      final elapsed = await _timeToFirstContent(
        tester,
        routes: {'/home': (_) => FakeResponse.json(200, homeJson())},
        ready: find.bySemanticsLabel(RegExp('^Banner 1 dari 1')),
      );
      expect(elapsed, lessThanOrEqualTo(_budget));
    });

    testWidgets('KTA: kartu anggota dari GET /me/card', (tester) async {
      final elapsed = await _timeToFirstContent(
        tester,
        location: '/kta',
        routes: {
          '/home': (_) => FakeResponse.json(200, homeJson()),
          '/me/card': (_) => FakeResponse.json(200, memberCardJson(expiresAt: DateTime.utc(2027, 10, 12, 7))),
          '/me/fees': (_) => FakeResponse.json(200, feesJson()),
        },
        ready: find.byType(KtaCard),
      );
      expect(elapsed, lessThanOrEqualTo(_budget));
    });

    testWidgets('Berita: daftar berita dari GET /posts', (tester) async {
      final elapsed = await _timeToFirstContent(
        tester,
        location: '/news',
        routes: {
          '/home': (_) => FakeResponse.json(200, homeJson()),
          '/categories': (_) => FakeResponse.json(200, {'items': <Object?>[]}),
          '/posts': (_) => FakeResponse.json(200, postPageJson([postSummaryJson()])),
        },
        ready: find.text('Halal Bihalal Alumni 2026'),
      );
      expect(elapsed, lessThanOrEqualTo(_budget));
    });

    testWidgets('model menangkap waterfall: request berurutan tambahan melewati anggaran', (tester) async {
      // Kontrol: bila Beranda harus menunggu tiga request berurutan tambahan sebelum tampil, model melampaui 3 detik.
      var chained = 0;
      final elapsed = await _timeToFirstContent(
        tester,
        routes: {
          '/home': (_) async {
            // Mensimulasikan tiga request tambahan yang harus selesai lebih dulu (masing-masing satu putaran penuh).
            for (; chained < 3; chained++) {
              await Future<void>.delayed(_rtt + _serverP95);
            }
            return FakeResponse.json(200, homeJson());
          },
        },
        ready: find.bySemanticsLabel(RegExp('^Banner 1 dari 1')),
      );
      expect(elapsed, greaterThan(_budget));
    });
  });
}
