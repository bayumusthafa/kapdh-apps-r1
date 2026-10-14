import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/realtime/connection_transitions.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';

void main() {
  test('ARCHITECTURE §4.9: pemanggilan sinkron satu kali per transisi ke connected, dilepas lewat fungsi pelepas', () {
    final state = _State(RealtimeConnectionState.connected);
    addTearDown(state.dispose);
    var calls = 0;
    final remove = listenConnectedTransitions(state, () => calls++);

    // Sudah tersambung saat mulai mendengar: bukan transisi.
    expect(calls, 0);
    state
      ..value = RealtimeConnectionState.waitingRetry
      ..value = RealtimeConnectionState.connecting;
    expect(calls, 0);
    state.value = RealtimeConnectionState.connected;
    expect(calls, 1, reason: 'dipanggil di dalam pemberitahuan, tanpa menunggu antrean event');
    state
      ..value = RealtimeConnectionState.disconnected
      ..value = RealtimeConnectionState.connected;
    expect(calls, 2);

    remove();
    expect(state.listening, isFalse);
    state
      ..value = RealtimeConnectionState.disconnected
      ..value = RealtimeConnectionState.connected;
    expect(calls, 2);
  });

  test('AC F05-4: sambungan realtime pulih memberi satu petunjuk per transisi ke connected', () async {
    final state = ValueNotifier(RealtimeConnectionState.connected);
    addTearDown(state.dispose);
    final events = <void>[];
    final subscription = connectedTransitions(state).listen(events.add);
    addTearDown(subscription.cancel);

    // Sudah tersambung saat mulai mendengar: bukan transisi.
    await pumpEventQueue();
    expect(events, isEmpty);

    state.value = RealtimeConnectionState.waitingRetry;
    state.value = RealtimeConnectionState.connecting;
    await pumpEventQueue();
    expect(events, isEmpty);

    state.value = RealtimeConnectionState.connected;
    await pumpEventQueue();
    expect(events, hasLength(1));

    state.value = RealtimeConnectionState.disconnected;
    state.value = RealtimeConnectionState.connected;
    await pumpEventQueue();
    expect(events, hasLength(2));
  });

  test('pendengar keadaan dilepas setelah pelanggan terakhir berhenti', () async {
    final state = _State(RealtimeConnectionState.disconnected);
    addTearDown(state.dispose);
    final subscription = connectedTransitions(state).listen((_) {});
    expect(state.listening, isTrue);
    await subscription.cancel();
    expect(state.listening, isFalse);
  });
}

class _State extends ValueNotifier<RealtimeConnectionState> {
  _State(super.value);

  bool get listening => hasListeners;
}
