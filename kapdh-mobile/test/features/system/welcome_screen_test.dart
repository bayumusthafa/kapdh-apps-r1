import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/welcome/welcome_gate.dart';
import 'package:kapdh_mobile/features/auth/login_screen.dart';
import 'package:kapdh_mobile/features/auth/register_screen.dart';
import 'package:kapdh_mobile/features/system/welcome_screen.dart';

import '../../support/a11y.dart';
import '../../support/app_harness.dart';
import '../../support/fakes.dart';

void main() {
  group('Welcome setelah splash (pemasangan baru atau pembaruan)', () {
    testWidgets('pemasangan baru: logo, sapaan dan dua pilihan', (tester) async {
      final app = await pumpApp(tester, handler: apiRoutes({}), welcome: MemoryWelcomeStore());
      expect(app.location, '/welcome');
      expect(find.byType(WelcomeScreen), findsOneWidget);
      expect(find.bySemanticsLabel('Logo KAPDH'), findsOneWidget);
      expect(find.text(WelcomeScreen.greeting), findsOneWidget);
      expect(find.text(WelcomeScreen.appName), findsOneWidget);
      expect(find.text(WelcomeScreen.tagline), findsOneWidget);
      expect(find.text(WelcomeScreen.registerLabel), findsOneWidget);
      expect(find.text(WelcomeScreen.loginLabel), findsOneWidget);
    });

    testWidgets('Daftar KAPDH Apps membuka pendaftaran dan menandai build ini', (tester) async {
      final store = MemoryWelcomeStore();
      final app = await pumpApp(tester, handler: apiRoutes({}), welcome: store);
      await tester.tap(find.text(WelcomeScreen.registerLabel));
      await settle(tester);
      expect(app.location, '/register');
      expect(find.byType(RegisterScreen), findsOneWidget);
      expect(store.seenBuild, testBuild);
      expect(app.container.read(welcomeProvider), WelcomeStatus.done);
    });

    testWidgets('Sudah Punya Akun? Masuk membuka layar Masuk', (tester) async {
      final store = MemoryWelcomeStore(seenBuild: '1.1.0+6');
      final app = await pumpApp(tester, handler: apiRoutes({}), welcome: store);
      expect(app.location, '/welcome');
      await tester.tap(find.text(WelcomeScreen.loginLabel));
      await settle(tester);
      expect(app.location, '/login');
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(store.seenBuild, testBuild);
    });

    testWidgets('sudah dilihat di build ini: langsung ke layar Masuk', (tester) async {
      final app = await pumpApp(
        tester,
        handler: apiRoutes({}),
        welcome: MemoryWelcomeStore(seenBuild: testBuild),
      );
      expect(app.location, '/login');
    });

    testWidgets('sesi tersimpan setelah pembaruan: ke Beranda dan Welcome ditandai', (tester) async {
      final store = MemoryWelcomeStore(seenBuild: '1.1.0+6');
      final app = await pumpApp(
        tester,
        tokens: savedTokens(),
        welcome: store,
        handler: apiRoutes({'/me': (_) => FakeResponse.json(200, meJson())}),
      );
      expect(app.location, '/home');
      expect(store.seenBuild, testBuild);
    });

    testWidgets('teks 200 %: tidak meluap dan tombol tetap terjangkau', (tester) async {
      await pumpApp(tester, handler: apiRoutes({}), welcome: MemoryWelcomeStore(), textScale: 2);
      expect(tester.takeException(), isNull);
      expect(find.text(WelcomeScreen.registerLabel), findsOneWidget);
      expect(find.text(WelcomeScreen.loginLabel), findsOneWidget);
    });

    testWidgets('memenuhi pedoman aksesibilitas', (tester) async {
      await pumpApp(tester, handler: apiRoutes({}), welcome: MemoryWelcomeStore());
      await expectMeetsAccessibilityGuidelines(tester);
    });
  });
}
