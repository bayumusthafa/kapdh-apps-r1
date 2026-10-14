import 'dart:async';

import 'package:flutter/foundation.dart';

import 'realtime_client.dart';

/// Memanggil [onConnected] setiap kali [state] berpindah ke [RealtimeConnectionState.connected] dari keadaan lain
/// (tersambung pertama kali atau kembali). Sudah tersambung saat mulai mendengar bukan transisi. Event yang terbit
/// selama soket terputus tidak diputar ulang server, jadi pemakai memuat ulang datanya pada transisi ini
/// (ARCHITECTURE §4.9). Dipanggil sinkron di dalam pemberitahuan [state]. Mengembalikan fungsi pelepas pendengar.
VoidCallback listenConnectedTransitions(ValueListenable<RealtimeConnectionState> state, VoidCallback onConnected) {
  var previous = state.value;
  void onChange() {
    final next = state.value;
    final connected = next == RealtimeConnectionState.connected && previous != RealtimeConnectionState.connected;
    previous = next;
    if (connected) onConnected();
  }

  state.addListener(onChange);
  return () => state.removeListener(onChange);
}

/// [listenConnectedTransitions] sebagai aliran: satu event per transisi ke tersambung. Pendengar dipasang selama ada
/// pelanggan saja.
Stream<void> connectedTransitions(ValueListenable<RealtimeConnectionState> state) {
  late final StreamController<void> controller;
  VoidCallback? remove;
  controller = StreamController<void>.broadcast(
    onListen: () => remove = listenConnectedTransitions(state, () => controller.add(null)),
    onCancel: () {
      remove?.call();
      remove = null;
    },
  );
  return controller.stream;
}
