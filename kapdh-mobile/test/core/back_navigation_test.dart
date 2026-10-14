import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_mobile/core/ui/back_navigation.dart';

import '../support/widget_harness.dart';

void main() {
  /// Router uji: `/list` hanya boleh dibuka selama [listAllowed]; selain itu redirect ke `/status` (seperti daftar
  /// event yang khusus anggota aktif, PRD 2.2). `/detail` dijaga `PopScope` selama [guarded].
  Future<GoRouter> pumpRouter(WidgetTester tester, {required bool Function() listAllowed, bool guarded = false}) async {
    usePhoneSize(tester);
    final router = GoRouter(
      initialLocation: '/list',
      redirect: (context, state) => state.uri.path == '/list' && !listAllowed() ? '/status' : null,
      routes: [
        GoRoute(path: '/status', builder: (_, _) => const Text('status')),
        GoRoute(path: '/list', builder: (_, _) => const Text('daftar')),
        GoRoute(
          path: '/detail',
          builder: (_, _) => PopScope(canPop: !guarded, child: const Text('detail')),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: redirectingRouterConfig(router)));
    unawaited(router.push('/detail'));
    await tester.pumpAndSettle();
    expect(find.text('detail'), findsOneWidget);
    return router;
  }

  testWidgets('PRD 2.2: tombol kembali sistem melewatkan halaman dasar ke redirect lagi sesudah halaman tertutup', (
    tester,
  ) async {
    var allowed = true;
    final router = await pumpRouter(tester, listAllowed: () => allowed);
    // Hak membuka daftar hilang selama detail terbuka (mis. keanggotaan berakhir).
    allowed = false;

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();

    expect(router.state.uri.toString(), '/status');
    expect(find.text('status'), findsOneWidget);
    expect(find.text('daftar'), findsNothing);
  });

  testWidgets('PRD 2.2: halaman dasar yang masih diizinkan tetap menjadi tujuan tombol kembali sistem', (tester) async {
    final router = await pumpRouter(tester, listAllowed: () => true);

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();

    expect(router.state.uri.toString(), '/list');
    expect(find.text('daftar'), findsOneWidget);
  });

  testWidgets('PRD 4.5: PopScope yang menahan: halaman tetap dan redirect tidak dijalankan', (tester) async {
    var allowed = true;
    final router = await pumpRouter(tester, listAllowed: () => allowed, guarded: true);
    allowed = false;

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();

    expect(router.state.uri.toString(), '/detail');
    expect(find.text('detail'), findsOneWidget);
  });

  testWidgets('PRD 4.5: dialog di atas halaman ditutup tombol kembali sistem tanpa menjalankan redirect', (
    tester,
  ) async {
    var allowed = true;
    final router = await pumpRouter(tester, listAllowed: () => allowed);
    unawaited(
      showDialog<void>(
        context: tester.element(find.text('detail')),
        builder: (_) => const AlertDialog(content: Text('Buang perubahan?')),
      ),
    );
    await tester.pumpAndSettle();
    allowed = false;

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();

    expect(find.text('Buang perubahan?'), findsNothing);
    expect(router.state.uri.toString(), '/detail');
    expect(find.text('detail'), findsOneWidget);
  });
}
