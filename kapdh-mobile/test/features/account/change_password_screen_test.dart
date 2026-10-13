import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import 'account_fixtures.dart';

void main() {
  Future<AppHarness> openPassword(WidgetTester tester, {FakeHandler? change, double textScale = 1}) async {
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      textScale: textScale,
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': 0}),
        '/auth/password/change': change ?? (_) => FakeResponse.json(204),
      }),
    );
    app.router.go('/account');
    await settle(tester);
    app.router.push('/account/password');
    await settle(tester);
    return app;
  }

  Finder input(String key) =>
      find.descendant(of: find.byKey(ValueKey('password-$key')), matching: find.byType(EditableText));

  Future<void> fill(WidgetTester tester, {String current = 'Lama#2026', String next = 'Baru#2026x'}) async {
    await tester.enterText(input('current'), current);
    await tester.enterText(input('new'), next);
    await tester.enterText(input('confirm'), next);
    await tester.pump();
  }

  Future<void> submit(WidgetTester tester) async {
    await scrollAndTap(tester, find.byKey(const ValueKey('password-submit')));
    await settle(tester);
  }

  testWidgets('AC F02-4: ganti password mensyaratkan password lama; perangkat lain dikeluarkan', (tester) async {
    final app = await openPassword(tester);
    await fill(tester);
    await submit(tester);
    expectLastBody(app.adapter, '/auth/password/change', {
      'current_password': 'Lama#2026',
      'new_password': 'Baru#2026x',
    });
    expect(find.text('Password diganti. Perangkat lain sudah dikeluarkan dari akun Anda.'), findsOneWidget);
    expect(app.location, '/account');
  });

  testWidgets('AC F02-4: password lama salah ditampilkan pada field (400, bukan logout)', (tester) async {
    final app = await openPassword(
      tester,
      change: (_) => FakeResponse.json(
        400,
        errorJson(
          'VALIDATION_ERROR',
          'Periksa kembali isian yang ditandai.',
          fieldErrors: {
            'current_password': ['Password saat ini salah.'],
          },
        ),
      ),
    );
    await fill(tester);
    await submit(tester);
    expect(find.text('Password saat ini salah.'), findsOneWidget);
    expect(app.location, '/account/password');
  });

  testWidgets('PRD 2.5: aturan password baru dan konfirmasi diperiksa sebelum mengirim', (tester) async {
    final app = await openPassword(tester);
    await tester.enterText(input('current'), 'Lama#2026');
    await tester.enterText(input('new'), 'pendek');
    await tester.enterText(input('confirm'), 'berbeda');
    await tester.pump();
    await submit(tester);
    expect(find.text('Password baru tidak sama'), findsOneWidget);
    expect(find.text('Belum memenuhi aturan password'), findsOneWidget);
    expect(find.bySemanticsLabel('Huruf besar, belum terpenuhi'), findsOneWidget);
    expect(find.bySemanticsLabel('Simbol, belum terpenuhi'), findsOneWidget);
    expect(app.adapter.requests.where((r) => r.path == '/auth/password/change'), isEmpty);

    await tester.enterText(input('new'), 'Lama#2026');
    await tester.enterText(input('confirm'), 'Lama#2026');
    await tester.pump();
    expect(find.text('Password baru harus berbeda dari password saat ini'), findsOneWidget);
  });

  testWidgets('PRD 2.5: batas kegagalan (429) menampilkan hitung mundur pada tombol', (tester) async {
    await openPassword(
      tester,
      change: (_) =>
          FakeResponse.json(429, errorJson('RATE_LIMITED', 'Terlalu banyak percobaan.', retryAfterSeconds: 120)),
    );
    await fill(tester);
    await submit(tester);
    expect(find.textContaining('Coba lagi dalam'), findsWidgets);
  });

  testWidgets('N-11: teks 200 % tanpa meluap', (tester) async {
    await openPassword(tester, textScale: 2);
    expect(tester.takeException(), isNull);
  });
}
