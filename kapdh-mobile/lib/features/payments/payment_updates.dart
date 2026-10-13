import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_services.dart';

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
