import 'dart:async';
import 'dart:math' as math;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/refresh_coordinator.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/core/realtime/realtime_socket.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';

import '../support/fakes.dart';

class FakeSocket implements RealtimeSocket {
  FakeSocket({required this.uri, required this.path, required this.auth, required this.listener});

  final Uri uri;
  final String path;
  final RealtimeAuthProvider auth;
  final RealtimeSocketListener listener;
  final List<(String, Object?)> emitted = [];
  Map<String, Object?>? handshake;
  bool connected = false;
  bool disposed = false;

  @override
  void connect() {
    connected = true;
    auth((data) => handshake = data);
  }

  @override
  void emit(String event, Object? data) => emitted.add((event, data));

  @override
  void dispose() => disposed = true;
}

Map<String, Object?> envelope(String type, {String eventId = 'ev-1', Map<String, Object?> payload = const {}}) => {
  'v': 1,
  'event_id': eventId,
  'type': type,
  'entity_id': 'entity-1',
  'ts': testNow.toIso8601String(),
  'payload': payload,
};

void main() {
  late TokenStore tokens;
  late List<FakeSocket> sockets;
  late int refreshes;
  late TokenPair? Function() nextPair;

  RealtimeClient build({math.Random? random}) {
    final coordinator = RefreshCoordinator(
      store: tokens,
      clock: () => testNow,
      refresher: (refreshToken) async {
        refreshes++;
        final pair = nextPair();
        if (pair == null) throw apiError(401, 'UNAUTHENTICATED', 'Sesi berakhir.');
        return pair;
      },
    );
    return RealtimeClient(
      config: testApiConfig,
      coordinator: coordinator,
      random: random ?? math.Random(1),
      socketFactory: ({required uri, required path, required auth, required listener}) {
        final socket = FakeSocket(uri: uri, path: path, auth: auth, listener: listener);
        sockets.add(socket);
        return socket;
      },
    );
  }

  setUp(() async {
    tokens = TokenStore(MemorySecureStore());
    await tokens.save(
      StoredTokens(
        accessToken: 'access-1',
        accessExpiresAt: testNow.add(const Duration(minutes: 10)),
        refreshToken: 'refresh-1',
      ),
    );
    sockets = [];
    refreshes = 0;
    nextPair = () => TokenPair.fromJson(tokenPairJson(access: 'access-2', refresh: 'refresh-2'));
  });

  test('handshake ke namespace /realtime dengan token dari koordinator (ARCHITECTURE §4.9)', () async {
    final client = build();
    client.start();
    await pumpEventQueue();

    final socket = sockets.single;
    expect(socket.uri.toString(), 'http://api.test/realtime');
    expect(socket.path, '/socket.io');
    expect(socket.handshake, {'token': 'access-1'});
    socket.listener.onConnected();
    expect(client.connectionState.value, RealtimeConnectionState.connected);
    await client.dispose();
  });

  test('amplop dibaca sebagai RealtimeEvent bertipe, event ganda setelah reconnect dibuang (N-02)', () async {
    final client = build();
    final received = <RealtimeEvent>[];
    final sub = client.events.listen(received.add);
    final notifications = <NotificationCreatedEvent>[];
    final sub2 = client.on<NotificationCreatedEvent>().listen(notifications.add);
    client.start();
    await pumpEventQueue();
    final listener = sockets.single.listener;

    listener.onEvent('notification.created', envelope('notification.created'));
    listener.onEvent('notification.created', envelope('notification.created'));
    listener.onEvent('message.created', envelope('message.created', eventId: 'ev-2', payload: {'room_id': 'r1'}));
    listener.onEvent('jenis.baru', envelope('jenis.baru', eventId: 'ev-3'));
    listener.onEvent('rusak', {'v': 1, 'type': 'typing'});
    listener.onEvent('bukan-map', 'teks');
    await pumpEventQueue();

    expect(received.map((e) => e.eventId), ['ev-1', 'ev-2', 'ev-3']);
    expect(received[1], isA<MessageCreatedEvent>());
    expect((received[1] as MessageCreatedEvent).payload['room_id'], 'r1');
    expect(received[2], isA<UnknownRealtimeEvent>());
    expect(notifications, hasLength(1));
    await sub.cancel();
    await sub2.cancel();
    await client.dispose();
  });

  test('klien hanya mengirim typing {room_id} dan presence.ping', () async {
    final client = build();
    client.start();
    await pumpEventQueue();
    client
      ..sendTyping('room-1')
      ..sendPresencePing();
    final emitted = sockets.single.emitted;
    expect(emitted.map((e) => e.$1), ['typing', 'presence.ping']);
    expect(emitted[0].$2, {'room_id': 'room-1'});
    expect(emitted[1].$2, isEmpty);
    await client.dispose();
  });

  test('handshake ditolak UNAUTHENTICATED: satu refresh lalu sambung ulang dengan token baru', () async {
    final client = build();
    client.start();
    await pumpEventQueue();

    sockets.single.listener.onConnectError({'message': 'UNAUTHENTICATED'});
    await pumpEventQueue();
    await Future<void>.delayed(Duration.zero);
    await pumpEventQueue();

    expect(refreshes, 1);
    expect(sockets, hasLength(2));
    expect(sockets.first.disposed, isTrue);
    expect(sockets.last.handshake, {'token': 'access-2'});
    await client.dispose();
  });

  test('refresh ditolak (sesi dicabut): berhenti tanpa sambung ulang', () async {
    nextPair = () => null;
    final client = build();
    client.start();
    await pumpEventQueue();

    sockets.single.listener.onConnectError({
      'message': 'x',
      'data': {'code': 'UNAUTHENTICATED'},
    });
    await pumpEventQueue();

    expect(client.connectionState.value, RealtimeConnectionState.disconnected);
    expect(sockets, hasLength(1));
    expect(await tokens.read(), isNull);
    await client.dispose();
  });

  test('tanpa sesi: tidak menyambung', () async {
    await tokens.clear();
    final client = build();
    client.start();
    await pumpEventQueue();
    expect(sockets, isEmpty);
    expect(client.connectionState.value, RealtimeConnectionState.disconnected);
    await client.dispose();
  });

  test('putus koneksi: sambung ulang dengan backoff eksponensial ber-jitter, reset setelah tersambung', () {
    fakeAsync((async) {
      final client = build(random: math.Random(7));
      client.start();
      async.flushMicrotasks();
      expect(sockets, hasLength(1));

      sockets.last.listener.onDisconnected('transport close');
      expect(client.connectionState.value, RealtimeConnectionState.waitingRetry);
      async.elapse(const Duration(milliseconds: 499));
      async.flushMicrotasks();
      expect(sockets, hasLength(1), reason: 'jitter minimal 50 % dari 1 detik');
      async.elapse(const Duration(milliseconds: 600));
      async.flushMicrotasks();
      expect(sockets, hasLength(2));

      sockets.last.listener.onConnectError({'message': 'xhr poll error'});
      expect(client.attempt, 2);
      async.elapse(const Duration(seconds: 2));
      async.flushMicrotasks();
      expect(sockets, hasLength(3));

      sockets.last.listener.onConnected();
      expect(client.attempt, 0);
      expect(client.connectionState.value, RealtimeConnectionState.connected);

      client.stop();
      sockets.last.listener.onDisconnected('io client disconnect');
      async.elapse(const Duration(minutes: 1));
      expect(sockets, hasLength(3));
      unawaited(client.dispose());
      async.flushMicrotasks();
    });
  });

  test('backoff dibatasi 30 detik', () {
    final client = build(random: math.Random(3));
    for (var attempt = 0; attempt < 20; attempt++) {
      final wait = client.backoffFor(attempt);
      expect(wait, lessThanOrEqualTo(const Duration(seconds: 30)));
      expect(wait, greaterThanOrEqualTo(Duration(milliseconds: math.min(500 * (1 << math.min(attempt, 16)), 15000))));
    }
  });

  test('deteksi penolakan autentikasi', () {
    expect(RealtimeClient.isUnauthenticated({'message': 'UNAUTHENTICATED'}), isTrue);
    expect(
      RealtimeClient.isUnauthenticated({
        'message': 'x',
        'data': {'code': 'UNAUTHENTICATED'},
      }),
      isTrue,
    );
    expect(RealtimeClient.isUnauthenticated('UNAUTHENTICATED: token kedaluwarsa'), isTrue);
    expect(RealtimeClient.isUnauthenticated({'message': 'timeout'}), isFalse);
    expect(RealtimeClient.isUnauthenticated(null), isFalse);
  });
}
