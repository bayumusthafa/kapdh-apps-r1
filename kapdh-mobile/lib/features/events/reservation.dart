import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/ui/app_keys.dart';
import '../home/shared/links.dart';
import 'event_format.dart';
import 'events_controllers.dart';
import 'events_repository.dart';

/// Hasil satu percobaan reservasi (F-09).
sealed class ReservationOutcome {
  const ReservationOutcome();
}

/// Tiket dibuat (atau ditemukan sesudah jaringan putus): event gratis langsung paid, event berbayar
/// awaiting_payment dengan payment yang menunggu bukti.
final class ReservationDone extends ReservationOutcome {
  const ReservationDone({this.ticket, required this.ticketId, this.paymentId});

  final TicketDetail? ticket;
  final String ticketId;

  /// Payment tiket untuk unggah bukti; null untuk event gratis.
  final String? paymentId;
}

/// Harga berubah di antara tampilan dan kirim (409 VERSION_CONFLICT, PRD 4.4): tidak ada hold; anggota wajib
/// mengonfirmasi harga baru.
final class ReservationPriceChanged extends ReservationOutcome {
  const ReservationPriceChanged(this.event);

  final EventDetail event;
}

/// Metode bayar ditolak server (400, `field_errors.payment_method_id`).
final class ReservationInvalidMethod extends ReservationOutcome {
  const ReservationInvalidMethod(this.message);

  final String message;
}

/// Ditolak atau gagal; pesan sudah ditampilkan.
final class ReservationStopped extends ReservationOutcome {
  const ReservationStopped();
}

/// Jaringan putus dan belum ada tiket aktif di server: tawarkan kirim ulang dengan key yang sama.
final class ReservationNetworkFailed extends ReservationOutcome {
  const ReservationNetworkFailed();
}

/// Status tiket yang masih menahan atau memakai kursi (satu tiket aktif per anggota per event, PRD 3.9).
bool isActiveTicketStatus(TicketStatus? status) =>
    status == TicketStatus.awaitingPayment || status == TicketStatus.awaitingReview || status == TicketStatus.paid;

/// Menjalankan reservasi satu kursi untuk diri sendiri (AC F09-1, F09-3) dan menangani setiap penolakan sesuai
/// kontrak C5:
/// - 409 EVENT_SOLD_OUT / RESERVATION_EXPIRED: detail diganti `current` dan alasan dijelaskan;
/// - 409 VERSION_CONFLICT: sudah punya tiket aktif (buka tiket) atau harga berubah (konfirmasi ulang);
/// - 400 metode bayar: dikembalikan ke formulir;
/// - jaringan putus: status diperiksa dulu lewat detail event sebelum menawarkan kirim ulang dengan
///   Idempotency-Key yang sama (PRD 4.3, PRD 4.5 "Memeriksa status").
Future<ReservationOutcome> submitReservation(
  BuildContext context,
  WidgetRef ref, {
  required EventDetail event,
  String? paymentMethodId,
}) async {
  final repository = ref.read(eventsRepositoryProvider);
  final detail = ref.read(eventDetailControllerProvider(event.id).notifier);
  try {
    final ticket = await repository.reserve(event.id, expectedPrice: event.price, paymentMethodId: paymentMethodId);
    // Kuota, tombol "Lihat Tiket Saya" dan daftar Tiket Saya mengikuti keadaan server terbaru.
    unawaited(detail.reload());
    ref.invalidate(ticketsControllerProvider);
    return ReservationDone(ticket: ticket, ticketId: ticket.id, paymentId: ticket.payment?.id);
  } on ApiException catch (error) {
    final current = eventDetailFromConflict(error);
    if (current != null) detail.apply(current);
    switch (error.code) {
      case ErrorCode.versionConflict when current != null:
        final mine = current.myTicket;
        if (current.reservationBlockedReason == EventReservationBlockReason.hasActiveTicket &&
            mine != null &&
            isActiveTicketStatus(mine.status)) {
          showAppSnackBar(ref, 'Anda sudah terdaftar di event ini. Tiket Anda dibuka.');
          return ReservationDone(ticketId: mine.id);
        }
        if (current.price != event.price) return ReservationPriceChanged(current);
        _explain(ref, 'Data event berubah', error.message);
        return const ReservationStopped();
      case ErrorCode.eventSoldOut:
        _explain(
          ref,
          'Kuota penuh',
          '${error.message}\n\nKursi dapat tersedia kembali bila ada reservasi yang berakhir atau dibatalkan.',
        );
        return const ReservationStopped();
      case ErrorCode.reservationExpired:
        final state = current == null ? null : registrationStateStyle(current.registrationState).label;
        _explain(ref, 'Pendaftaran tidak dibuka', state == null ? error.message : '${error.message}\n\n$state.');
        return const ReservationStopped();
      case ErrorCode.validationError when error.fieldErrors.containsKey('payment_method_id'):
        ref.invalidate(paymentMethodsProvider);
        return ReservationInvalidMethod(error.fieldErrors['payment_method_id']!.join(' '));
      default:
        break;
    }
    if (error.isNetwork && context.mounted) return _checkAfterNetworkFailure(context, ref, event);
    unawaited(ref.read(errorPresenterProvider).present(error, onReload: () => unawaited(detail.reload())));
    return const ReservationStopped();
  }
}

/// PRD 4.5 "Jaringan putus saat bayar/reserve": periksa hasil lewat detail event lebih dahulu. Bila tiket aktif
/// sudah ada, permintaan pertama ternyata diproses server dan tiket itu dibuka; selain itu anggota dapat mengirim
/// ulang dengan Idempotency-Key yang sama (disimpan IdempotencyStore sampai hasilnya diketahui).
Future<ReservationOutcome> _checkAfterNetworkFailure(BuildContext context, WidgetRef ref, EventDetail event) async {
  showAppSnackBar(ref, 'Koneksi terputus. Memeriksa status pendaftaran Anda…');
  final repository = ref.read(eventsRepositoryProvider);
  final latest = await ref.read(eventDetailControllerProvider(event.id).notifier).reload();
  final mine = latest?.myTicket;
  if (latest != null && mine != null && isActiveTicketStatus(mine.status)) {
    // Hasil permintaan pertama sudah pasti (tiket tercatat): key reservasi dilepas (PRD 4.3).
    await repository.completeReservation(event.id);
    ref.invalidate(ticketsControllerProvider);
    showAppSnackBar(ref, 'Pendaftaran Anda sudah tercatat. Tiket Anda dibuka.');
    return ReservationDone(ticketId: mine.id);
  }
  return const ReservationNetworkFailed();
}

/// Tampilkan pesan jaringan putus dengan tombol kirim ulang (Idempotency-Key yang sama, PRD 4.3).
void showReservationRetry(WidgetRef ref, VoidCallback onRetry) {
  ref.read(scaffoldMessengerKeyProvider).currentState
    ?..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 10),
        content: const Text(
          'Pendaftaran belum terkirim karena koneksi terputus. Anda tidak terdaftar dua kali; coba lagi.',
        ),
        action: SnackBarAction(label: 'Coba lagi', onPressed: onRetry),
      ),
    );
}

/// Penjelasan penolakan dalam dialog; tidak ditunggu sehingga tombol kirim kembali aktif di belakang dialog.
void _explain(WidgetRef ref, String title, String message) {
  final context = ref.read(rootNavigatorKeyProvider).currentContext;
  if (context == null || !context.mounted) return;
  unawaited(
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Tutup'))],
      ),
    ),
  );
}

/// Membuka hasil reservasi: event berbayar ke layar pembayaran bersama `/payments/:paymentId` (unggah bukti sebelum
/// batas hold), event gratis atau tiket yang sudah ada ke detail tiket.
void openReservationResult(BuildContext context, WidgetRef ref, ReservationDone done) {
  final ticket = done.ticket;
  final router = GoRouter.of(context);
  final paymentId = done.paymentId;
  if (paymentId != null && ticket != null && ticket.status == TicketStatus.awaitingPayment) {
    final deadline = ticket.holdExpiresAt;
    showAppSnackBar(
      ref,
      deadline == null
          ? 'Kursi Anda ditahan. Kirim bukti transfer sebelum batas waktu.'
          : 'Kursi Anda ditahan sampai ${formatDateTime(deadline, zone: ticket.event.timezone)}. Kirim bukti transfer '
                'sebelum batas itu.',
    );
    unawaited(router.push(AppRoutes.payment(paymentId)));
    return;
  }
  if (ticket != null && ticket.status == TicketStatus.paid) {
    showAppSnackBar(ref, 'Pendaftaran berhasil. Tiket Anda sudah terbit.');
  }
  unawaited(router.push(AppRoutes.ticket(done.ticketId)));
}
