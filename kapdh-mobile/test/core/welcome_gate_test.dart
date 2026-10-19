import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/welcome/welcome_gate.dart';

import '../support/fakes.dart';

void main() {
  group('WelcomeController (pemasangan baru atau pembaruan)', () {
    test('pemasangan baru (tanpa penanda): pending', () async {
      final container = makeContainer(welcome: MemoryWelcomeStore());
      addTearDown(container.dispose);
      expect(container.read(welcomeProvider), WelcomeStatus.unknown);
      await container.read(welcomeProvider.notifier).load();
      expect(container.read(welcomeProvider), WelcomeStatus.pending);
    });

    test('build sama dengan penanda: selesai', () async {
      final container = makeContainer(welcome: MemoryWelcomeStore(seenBuild: testBuild));
      addTearDown(container.dispose);
      await container.read(welcomeProvider.notifier).load();
      expect(container.read(welcomeProvider), WelcomeStatus.done);
    });

    test('pembaruan aplikasi (penanda dari build lama): pending', () async {
      final container = makeContainer(welcome: MemoryWelcomeStore(seenBuild: '1.1.0+6'));
      addTearDown(container.dispose);
      await container.read(welcomeProvider.notifier).load();
      expect(container.read(welcomeProvider), WelcomeStatus.pending);
    });

    test('markSeen menyimpan versi+build saat ini', () async {
      final store = MemoryWelcomeStore();
      final container = makeContainer(welcome: store);
      addTearDown(container.dispose);
      await container.read(welcomeProvider.notifier).load();
      await container.read(welcomeProvider.notifier).markSeen();
      expect(container.read(welcomeProvider), WelcomeStatus.done);
      expect(store.seenBuild, testBuild);
    });

    test('penyimpanan gagal dibaca: selesai (tidak menahan splash)', () async {
      final container = makeContainer(welcome: MemoryWelcomeStore(failing: true));
      addTearDown(container.dispose);
      await container.read(welcomeProvider.notifier).load();
      expect(container.read(welcomeProvider), WelcomeStatus.done);
      await container.read(welcomeProvider.notifier).markSeen();
      expect(container.read(welcomeProvider), WelcomeStatus.done);
    });
  });
}
