// N-03 (PRD 2.4): p95 konten pertama dapat digunakan <= 3 detik pada profil jaringan uji 10 Mbps dan RTT 100 ms.
//
// Uji host ini menjalankan model jalur kritis KLIEN (test/support/first_content.dart) secara deterministik dengan jam
// uji Flutter (fake async). Yang tertangkap: rantai request berurutan (waterfall), request yang menahan layar, dan
// kerangka yang tidak pernah selesai. Yang TIDAK tertangkap: kinerja render perangkat nyata, DNS, dan waktu server
// sebenarnya. Model yang sama diukur p95-nya di perangkat/emulator nyata oleh integration_test/critical_flows_test.dart
// (matriks D7, docs/qa/device-matrix.md); pengukuran dengan network shaping ke staging tetap dicatat di laporan UAT
// (U-13).

import 'package:flutter_test/flutter_test.dart';

import '../features/home/content_fixtures.dart';
import '../support/fakes.dart';
import '../support/first_content.dart';

/// Resolusi pengukuran.
const _step = Duration(milliseconds: 10);

/// Mengukur [scenario] dengan jam uji: setiap langkah memompa satu frame dan memajukan waktu [_step].
Future<Duration> _measure(WidgetTester tester, FirstContentScenario scenario, {Map<String, FakeHandler>? routes}) {
  var elapsed = Duration.zero;
  return timeToFirstContent(
    tester,
    scenario,
    routes: routes,
    elapsed: () => elapsed,
    step: () async {
      await tester.pump(_step);
      elapsed += _step;
    },
  );
}

void main() {
  group('N-03 jalur kritis klien pada profil 10 Mbps / RTT 100 ms (server p95 N-01)', () {
    for (final scenario in firstContentScenarios) {
      testWidgets('${scenario.name}${scenario.location == null ? ' (rute awal anggota aktif)' : ''} dalam anggaran', (
        tester,
      ) async {
        final elapsed = await _measure(tester, scenario);
        expect(elapsed, lessThanOrEqualTo(n03Budget));
      });
    }

    testWidgets('model menangkap waterfall: request berurutan tambahan melewati anggaran', (tester) async {
      // Kontrol: bila Beranda harus menunggu tiga request berurutan tambahan sebelum tampil, model melampaui 3 detik.
      var chained = 0;
      final elapsed = await _measure(
        tester,
        firstContentScenarios.first,
        routes: {
          '/home': (_) async {
            // Mensimulasikan tiga request tambahan yang harus selesai lebih dulu (masing-masing satu putaran penuh).
            for (; chained < 3; chained++) {
              await Future<void>.delayed(n03Rtt + n01ServerP95);
            }
            return FakeResponse.json(200, homeJson());
          },
        },
      );
      expect(elapsed, greaterThan(n03Budget));
    });

    test('persentil nearest-rank', () {
      final samples = [for (var i = 1; i <= 20; i++) Duration(milliseconds: i * 100)];
      expect(percentile(samples, 0.95), const Duration(milliseconds: 1900));
      expect(percentile(samples, 0.5), const Duration(milliseconds: 1000));
      expect(percentile([const Duration(seconds: 1)], 0.95), const Duration(seconds: 1));
    });
  });
}
