import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_services.dart';
import '../../core/realtime/realtime_client.dart';

/// Notifikasi in-app baru yang tiba lewat realtime (`notification.created`, ARCHITECTURE §4.9; F-13). Diganti
/// sumber tiruan pada uji.
final realtimeNotificationsProvider = Provider<Stream<NotificationCreatedPayload>>(
  (ref) => ref.watch(realtimeClientProvider).on<NotificationCreatedEvent>().map((event) => event.payload),
);

/// Notifikasi kategori pembayaran atau keanggotaan: tanda status payment atau KTA berubah, mis. pengurus
/// menyetujui/menolak bukti (PRD 4.1 "Worker mengirim hasil dan kartu menjadi Aktif").
bool isPaymentUpdate(NotificationCreatedPayload payload) =>
    payload.category == NotificationCreatedPayloadCategory.payment ||
    payload.category == NotificationCreatedPayloadCategory.membership;

/// Aliran petunjuk muat ulang layar pembayaran dan KTA. Event hanya petunjuk; status tetap dibaca dari API karena
/// event realtime bukan sumber kebenaran (PRD 5.2).
final paymentUpdatesProvider = Provider<Stream<NotificationCreatedPayload>>(
  (ref) => ref.watch(realtimeNotificationsProvider).where(isPaymentUpdate),
);

/// Koneksi realtime tersambung kembali (transisi ke `connected`): petunjuk bahwa server terjangkau lagi, sehingga
/// layar yang sedang menampilkan data cache offline menyinkronkan ulang tanpa menunggu pengguna (AC F05-4, PRD 4.5).
/// Diganti sumber tiruan pada uji.
final realtimeReconnectedProvider = Provider<Stream<void>>(
  (ref) => connectedTransitions(ref.watch(realtimeClientProvider).connectionState),
);

/// Satu event setiap kali [state] berpindah ke [RealtimeConnectionState.connected] dari keadaan lain. Pendengar
/// dipasang selama ada pelanggan saja.
Stream<void> connectedTransitions(ValueListenable<RealtimeConnectionState> state) {
  late final StreamController<void> controller;
  var previous = state.value;
  void onChange() {
    final next = state.value;
    if (next == RealtimeConnectionState.connected && previous != RealtimeConnectionState.connected) {
      controller.add(null);
    }
    previous = next;
  }

  controller = StreamController<void>.broadcast(
    onListen: () {
      previous = state.value;
      state.addListener(onChange);
    },
    onCancel: () => state.removeListener(onChange),
  );
  return controller.stream;
}
