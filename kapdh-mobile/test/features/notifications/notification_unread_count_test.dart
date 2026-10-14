import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/app/app_services.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/core/realtime/realtime_socket.dart';

import '../../support/app_harness.dart';
import '../../support/fakes.dart';
import '../account/account_fixtures.dart';

/// Soket realtime yang dikendalikan uji: tersambung/terputus hanya bila uji memanggil listener-nya.
class _ControlledSocket implements RealtimeSocket {
  _ControlledSocket(this.listener);

  final RealtimeSocketListener listener;

  @override
  void connect() {}

  @override
  void emit(String event, Object? data) {}

  @override
  void dispose() {}
}

/// Mengirim perubahan siklus hidup aplikasi seperti platform (`flutter/lifecycle`); transisi antara dibuat binding.
Future<void> _lifecycle(WidgetTester tester, AppLifecycleState state) async {
  final message = const StringCodec().encodeMessage(state.toString());
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage('flutter/lifecycle', message, (_) {});
}

void main() {
  Finder badge(int count) => find.bySemanticsLabel(RegExp('^Notifikasi, Kotak masuk resmi, $count belum dibaca'));

  testWidgets('F-13: lencana belum dibaca dimuat ulang saat aplikasi kembali ke latar depan (kontrak C7)', (
    tester,
  ) async {
    var unread = 1;
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': unread}),
      }),
    );
    app.router.go('/account');
    await settle(tester);
    expect(badge(1), findsOneWidget);
    final before = countRequests(app.adapter, '/notifications/unread-count');

    // Notifikasi tiba saat aplikasi di latar belakang (soket tidak memutar ulang event).
    await _lifecycle(tester, AppLifecycleState.paused);
    unread = 4;
    await _lifecycle(tester, AppLifecycleState.resumed);
    await settle(tester);

    expect(countRequests(app.adapter, '/notifications/unread-count'), before + 1);
    expect(badge(4), findsOneWidget);
  });

  testWidgets('F-13 ARCHITECTURE §4.9: lencana dimuat ulang setiap kali realtime tersambung kembali', (tester) async {
    var unread = 2;
    final sockets = <_ControlledSocket>[];
    final app = await pumpApp(
      tester,
      tokens: savedTokens(),
      overrides: [
        realtimeClientProvider.overrideWith((ref) {
          final client = RealtimeClient(
            config: ref.watch(apiConfigProvider),
            coordinator: ref.watch(refreshCoordinatorProvider),
            initialBackoff: Duration.zero,
            random: math.Random(1),
            socketFactory: ({required uri, required path, required auth, required listener}) {
              final socket = _ControlledSocket(listener);
              sockets.add(socket);
              return socket;
            },
          );
          ref.onDispose(() => unawaited(client.dispose()));
          return client;
        }),
      ],
      handler: apiRoutes({
        '/me': (_) => FakeResponse.json(200, meFullJson()),
        '/notifications/unread-count': (_) => FakeResponse.json(200, {'unread_count': unread}),
      }),
    );
    app.router.go('/account');
    await settle(tester);
    expect(badge(2), findsOneWidget);
    final initial = countRequests(app.adapter, '/notifications/unread-count');

    final realtime = app.container.read(realtimeClientProvider)..start();
    await settle(tester);
    expect(sockets, hasLength(1));
    sockets.last.listener.onConnected();
    await settle(tester);
    expect(countRequests(app.adapter, '/notifications/unread-count'), initial + 1);

    // Koneksi putus; notifikasi yang terbit selama putus tidak diputar ulang.
    sockets.last.listener.onDisconnected('transport close');
    unread = 7;
    await settle(tester);
    expect(realtime.connectionState.value, isNot(RealtimeConnectionState.connected));
    expect(sockets, hasLength(2));
    sockets.last.listener.onConnected();
    await settle(tester);

    expect(countRequests(app.adapter, '/notifications/unread-count'), initial + 2);
    expect(badge(7), findsOneWidget);
    realtime.stop();
  });
}
