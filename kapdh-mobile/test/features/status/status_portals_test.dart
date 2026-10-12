import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/features/status/deletion_status_screen.dart';
import 'package:kapdh_mobile/features/status/restricted_screen.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';

void main() {
  group('Portal pembatasan (suspended, PRD 2.2)', () {
    testWidgets('alasan aman dari server, kontak pengurus, hapus akun dan legal', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(
            200,
            meJson(status: 'suspended', suspensionMessage: 'Akun dibatasi sementara karena laporan pelanggaran.'),
          ),
        }),
      );
      expect(app.location, '/restricted');
      expect(find.byType(RestrictedScreen), findsOneWidget);
      expect(find.text('Akun Anda sedang dibatasi'), findsOneWidget);
      expect(find.text('Akun dibatasi sementara karena laporan pelanggaran.'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Dibatasi'), findsOneWidget);
      expect(find.text('Ahmad Islam'), findsOneWidget);

      await scrollAndTap(tester, find.text('Hapus akun'));
      await settle(tester);
      expect(app.location, '/account/delete');
    });

    testWidgets('tanpa alasan: arahan menghubungi pengurus; tidak dapat membuka KTA', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'suspended'))}),
      );
      expect(find.textContaining('Hubungi pengurus untuk mengetahui alasan'), findsOneWidget);
      app.router.go('/kta');
      await settle(tester);
      expect(app.location, '/restricted');
    });

    testWidgets('periksa status: pemulihan oleh pengurus membawa ke Beranda', (tester) async {
      var status = 'suspended';
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: status))}),
      );
      status = 'verified';
      await scrollAndTap(tester, find.text('Periksa status'));
      await settle(tester);
      expect(app.location, '/home');
    });

    testWidgets('keluar: sesi dan data lokal dihapus, kembali ke login', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({
          '/me': (_) => FakeResponse.json(200, meJson(status: 'suspended')),
          '/auth/logout': (_) => FakeResponse.json(204),
        }),
      );
      await scrollAndTap(tester, find.text('Keluar'));
      await settle(tester);
      expect(app.location, '/login');
      expect(app.container.read(sessionProvider).phase, SessionPhase.anonymous);
      expect(await app.container.read(tokenStoreProvider).read(), isNull);
      expect(app.adapter.requestsTo('/auth/logout'), hasLength(1));
    });

    testWidgets('teks 200 % tanpa meluap', (tester) async {
      await pumpApp(
        tester,
        tokens: savedTokens(),
        textScale: 2,
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'suspended'))}),
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('Status penghapusan (disabled/deletion_pending, F-14)', () {
    testWidgets('deletion_pending: proses penghapusan dan retensi dijelaskan', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'deletion_pending'))}),
      );
      expect(app.location, '/deletion-status');
      expect(find.byType(DeletionStatusScreen), findsOneWidget);
      expect(find.text('Penghapusan akun sedang diproses'), findsOneWidget);
      expect(find.textContaining('kebijakan retensi'), findsOneWidget);
      expect(find.bySemanticsLabel('Status: Penghapusan Diproses'), findsOneWidget);
      app.router.go('/home');
      await settle(tester);
      expect(app.location, '/deletion-status');
    });

    testWidgets('disabled: akun tidak aktif dan tautan kebijakan privasi', (tester) async {
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson(status: 'disabled'))}),
      );
      expect(find.text('Akun tidak aktif'), findsOneWidget);
      await scrollAndTap(tester, find.text('Kebijakan privasi'));
      await settle(tester);
      expect(app.location, '/legal/kebijakan-privasi');
    });
  });
}
