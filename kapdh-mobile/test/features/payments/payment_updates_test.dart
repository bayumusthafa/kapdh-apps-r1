import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/realtime/realtime_client.dart';
import 'package:kapdh_mobile/features/payments/payment_updates.dart';

import 'payments_fixtures.dart';

void main() {
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

  test('hanya notifikasi kategori pembayaran dan keanggotaan yang memicu muat ulang', () {
    expect(isPaymentUpdate(notificationOf('payment')), isTrue);
    expect(isPaymentUpdate(notificationOf('membership')), isTrue);
    expect(isPaymentUpdate(notificationOf('news', title: 'Berita baru')), isFalse);
  });
}

class _State extends ValueNotifier<RealtimeConnectionState> {
  _State(super.value);

  bool get listening => hasListeners;
}
