import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_services.dart';
import '../../core/realtime/connection_transitions.dart';
import '../notifications/notifications_repository.dart';

/// Notifikasi kategori pembayaran atau keanggotaan: tanda status payment atau KTA berubah, mis. pengurus
/// menyetujui/menolak bukti (PRD 4.1 "Worker mengirim hasil dan kartu menjadi Aktif").
bool isPaymentUpdate(NotificationCreatedPayload payload) =>
    payload.category == NotificationCreatedPayloadCategory.payment ||
    payload.category == NotificationCreatedPayloadCategory.membership;

/// Aliran petunjuk muat ulang layar pembayaran dan KTA. Event hanya petunjuk; status tetap dibaca dari API karena
/// event realtime bukan sumber kebenaran (PRD 5.2).
///
/// Diturunkan dari [notificationCreatedEventsProvider], satu-satunya sumber `notification.created` (ARCHITECTURE
/// §4.9; F-13), sehingga satu event yang sama memperbarui lencana belum dibaca dan memicu muat ulang pembayaran/KTA,
/// juga pada uji yang mengganti sumber itu dengan aliran tiruan.
final paymentUpdatesProvider = Provider<Stream<NotificationCreatedPayload>>(
  (ref) => ref.watch(notificationCreatedEventsProvider).where(isPaymentUpdate),
);

/// Koneksi realtime tersambung kembali (transisi ke `connected`): petunjuk bahwa server terjangkau lagi, sehingga
/// layar yang sedang menampilkan data cache offline menyinkronkan ulang tanpa menunggu pengguna (AC F05-4, PRD 4.5).
/// Diganti sumber tiruan pada uji.
final realtimeReconnectedProvider = Provider<Stream<void>>(
  (ref) => connectedTransitions(ref.watch(realtimeClientProvider).connectionState),
);
