import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../core/api/error_presenter.dart';
import '../../core/format/formatters.dart';
import '../../core/ui/app_keys.dart';
import '../../design/kapdh_snack_bar_action.dart';
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

/// Akses alur reservasi yang tetap sah sesudah layar pemanggil ditutup selama request berjalan (PRD 4.3, 4.5):
/// container provider aplikasi, router dan messenger akar hidup selama aplikasi, sedangkan WidgetRef dan
/// BuildContext layar tidak boleh dipakai lagi sesudah layarnya dilepas. Wajib dibuat SEBELUM `await` pertama.
class ReservationScope {
  ReservationScope.of(BuildContext context)
    : container = ProviderScope.containerOf(context, listen: false),
      router = GoRouter.of(context);

  final ProviderContainer container;
  final GoRouter router;

  /// Snackbar lewat messenger akar.
  void snack(String message, {SnackBarAction? action, Duration duration = const Duration(seconds: 4)}) =>
      showMessengerSnackBar(container.read(scaffoldMessengerKeyProvider), message, action: action, duration: duration);

  /// Pengendali detail event yang sedang dipakai layar mana pun; null bila tidak ada (tidak dibuat ulang hanya untuk
  /// diperbarui).
  EventDetailController? detailOf(String eventId) {
    final provider = eventDetailControllerProvider(eventId);
    return container.exists(provider) ? container.read(provider.notifier) : null;
  }
}

/// Menjalankan reservasi satu kursi untuk diri sendiri (AC F09-1, F09-3) dan menangani setiap penolakan sesuai
/// kontrak C5:
/// - 409 EVENT_SOLD_OUT / RESERVATION_EXPIRED: detail diganti `current` dan alasan dijelaskan;
/// - 409 VERSION_CONFLICT: sudah punya tiket aktif (buka tiket) atau harga berubah (konfirmasi ulang);
/// - 400 metode bayar: dikembalikan ke formulir;
/// - jaringan putus: status diperiksa dulu lewat detail event sebelum menawarkan kirim ulang dengan
///   Idempotency-Key yang sama (PRD 4.3, PRD 4.5 "Memeriksa status").
///
/// Hanya memakai [scope] sesudah `await`, sehingga hasil tetap ditangani (Tiket Saya diperbarui, alasan
/// dijelaskan) walau layar pemanggil sudah ditutup.
Future<ReservationOutcome> submitReservation(
  ReservationScope scope, {
  required EventDetail event,
  String? paymentMethodId,
}) async {
  final container = scope.container;
  final repository = container.read(eventsRepositoryProvider);
  try {
    final ticket = await repository.reserve(event.id, expectedPrice: event.price, paymentMethodId: paymentMethodId);
    // Kuota, tombol "Lihat Tiket Saya" dan daftar Tiket Saya mengikuti keadaan server terbaru.
    final detail = scope.detailOf(event.id);
    if (detail != null) unawaited(detail.reload());
    container.invalidate(ticketsControllerProvider);
    return ReservationDone(ticket: ticket, ticketId: ticket.id, paymentId: ticket.payment?.id);
  } on ApiException catch (error) {
    final current = eventDetailFromConflict(error);
    if (current != null) scope.detailOf(event.id)?.apply(current);
    switch (error.code) {
      case ErrorCode.versionConflict when current != null:
        final mine = current.myTicket;
        if (current.reservationBlockedReason == EventReservationBlockReason.hasActiveTicket &&
            mine != null &&
            isActiveTicketStatus(mine.status)) {
          scope.snack('Anda sudah terdaftar di event ini. Tiket Anda dibuka.');
          return ReservationDone(ticketId: mine.id);
        }
        if (current.price != event.price) return ReservationPriceChanged(current);
        _explain(container, 'Data event berubah', error.message);
        return const ReservationStopped();
      case ErrorCode.eventSoldOut:
        _explain(
          container,
          'Kuota penuh',
          '${error.message}\n\nKursi dapat tersedia kembali bila ada reservasi yang berakhir atau dibatalkan.',
        );
        return const ReservationStopped();
      case ErrorCode.reservationExpired:
        final state = current == null ? null : registrationStateStyle(current.registrationState).label;
        _explain(container, 'Pendaftaran tidak dibuka', state == null ? error.message : '${error.message}\n\n$state.');
        return const ReservationStopped();
      case ErrorCode.validationError when error.fieldErrors.containsKey('payment_method_id'):
        container.invalidate(paymentMethodsProvider);
        return ReservationInvalidMethod(error.fieldErrors['payment_method_id']!.join(' '));
      default:
        break;
    }
    if (error.isNetwork) return _checkAfterNetworkFailure(scope, repository, event);
    final presenter = container.read(errorPresenterProvider);
    unawaited(presenter.present(error, onReload: () => unawaited(scope.detailOf(event.id)?.reload())));
    return const ReservationStopped();
  }
}

/// PRD 4.5 "Jaringan putus saat bayar/reserve": periksa hasil lewat detail event lebih dahulu. Bila tiket aktif
/// sudah ada, permintaan pertama ternyata diproses server dan tiket itu dibuka; selain itu anggota dapat mengirim
/// ulang dengan Idempotency-Key yang sama (disimpan IdempotencyStore sampai hasilnya diketahui).
Future<ReservationOutcome> _checkAfterNetworkFailure(
  ReservationScope scope,
  EventsRepository repository,
  EventDetail event,
) async {
  scope.snack('Koneksi terputus. Memeriksa status pendaftaran Anda…');
  final detail = scope.detailOf(event.id);
  final EventDetail? latest;
  if (detail != null) {
    latest = await detail.reload();
  } else {
    latest = await _tryGetEvent(repository, event.id);
  }
  final mine = latest?.myTicket;
  if (latest != null && mine != null && isActiveTicketStatus(mine.status)) {
    // Hasil permintaan pertama sudah pasti (tiket tercatat): key reservasi dilepas (PRD 4.3).
    await repository.completeReservation(event.id);
    scope.container.invalidate(ticketsControllerProvider);
    scope.snack('Pendaftaran Anda sudah tercatat. Tiket Anda dibuka.');
    return ReservationDone(ticketId: mine.id);
  }
  return const ReservationNetworkFailed();
}

Future<EventDetail?> _tryGetEvent(EventsRepository repository, String eventId) async {
  try {
    return await repository.getEvent(eventId);
  } on ApiException {
    return null;
  }
}

/// Tampilkan pesan jaringan putus dengan tombol kirim ulang (Idempotency-Key yang sama, PRD 4.3). Tanpa [onRetry]
/// (layar asal sudah ditutup) anggota diarahkan membuka event lagi; key tetap tersimpan sehingga pengiriman ulang
/// dari sana tidak mendaftar dua kali.
void showReservationRetry(ReservationScope scope, VoidCallback? onRetry) {
  scope.snack(
    onRetry == null
        ? 'Pendaftaran belum terkirim karena koneksi terputus. Buka event ini lagi untuk mencoba; Anda tidak '
              'terdaftar dua kali.'
        : 'Pendaftaran belum terkirim karena koneksi terputus. Anda tidak terdaftar dua kali; coba lagi.',
    duration: const Duration(seconds: 10),
    action: onRetry == null ? null : KapdhSnackBarAction(label: 'Coba lagi', onPressed: onRetry),
  );
}

/// Penjelasan penolakan dalam dialog; tidak ditunggu sehingga tombol kirim kembali aktif di belakang dialog.
void _explain(ProviderContainer container, String title, String message) {
  final context = container.read(rootNavigatorKeyProvider).currentContext;
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

/// Kursi berbayar yang ditahan dan menunggu bukti transfer (D5).
bool _isPaidHold(ReservationDone done) =>
    done.paymentId != null && done.ticket != null && done.ticket!.status == TicketStatus.awaitingPayment;

String _holdMessage(TicketDetail ticket) {
  final deadline = ticket.holdExpiresAt;
  return deadline == null
      ? 'Kursi Anda ditahan. Kirim bukti transfer sebelum batas waktu.'
      : 'Kursi Anda ditahan sampai ${formatDateTime(deadline, zone: ticket.event.timezone)}. Kirim bukti transfer '
            'sebelum batas itu.';
}

/// Membuka hasil reservasi: event berbayar ke layar pembayaran bersama `/payments/:paymentId` (unggah bukti sebelum
/// batas hold), event gratis atau tiket yang sudah ada ke detail tiket. Hanya dipanggil bila layar asal masih
/// tampil di atas; selain itu pakai [announceReservationResult].
void openReservationResult(ReservationScope scope, ReservationDone done) {
  final ticket = done.ticket;
  if (_isPaidHold(done)) {
    scope.snack(_holdMessage(ticket!));
    unawaited(scope.router.push(AppRoutes.payment(done.paymentId!)));
    return;
  }
  if (ticket != null && ticket.status == TicketStatus.paid) {
    scope.snack('Pendaftaran berhasil. Tiket Anda sudah terbit.');
  }
  unawaited(scope.router.push(AppRoutes.ticket(done.ticketId)));
}

/// Hasil reservasi yang tiba sesudah layar asalnya ditutup atau tertutup layar lain: anggota diberi tahu lewat
/// snackbar dengan tombol menuju pembayaran atau tiket, tanpa memindahkan layar yang sedang dibuka (PRD 4.5
/// "status pendaftaran harus jelas").
void announceReservationResult(ReservationScope scope, ReservationDone done) {
  final ticket = done.ticket;
  if (_isPaidHold(done)) {
    scope.snack(
      _holdMessage(ticket!),
      duration: const Duration(seconds: 10),
      action: KapdhSnackBarAction(
        label: 'Bayar',
        onPressed: () => unawaited(scope.router.push(AppRoutes.payment(done.paymentId!))),
      ),
    );
    return;
  }
  scope.snack(
    ticket != null && ticket.status == TicketStatus.paid
        ? 'Pendaftaran berhasil. Tiket Anda sudah terbit.'
        : 'Pendaftaran Anda sudah tercatat.',
    duration: const Duration(seconds: 10),
    action: KapdhSnackBarAction(
      label: 'Lihat tiket',
      onPressed: () => unawaited(scope.router.push(AppRoutes.ticket(done.ticketId))),
    ),
  );
}

/// Hasil reservasi untuk layar asal yang sudah dilepas (ditinggalkan, dialihkan router, atau ditutup notifikasi)
/// saat respons tiba: tiket tercatat diumumkan dengan tombol menuju pembayaran/tiket, kegagalan dijelaskan tanpa
/// tombol yang membutuhkan layar itu. Penolakan lain sudah dijelaskan dialog [submitReservation].
void announceDetachedOutcome(ReservationScope scope, ReservationOutcome outcome) {
  switch (outcome) {
    case final ReservationDone done:
      announceReservationResult(scope, done);
    case ReservationPriceChanged(event: final latest):
      scope.snack(
        'Harga tiket berubah menjadi ${formatEventPrice(latest.price, isFree: latest.isFree)}. Anda belum terdaftar; '
        'buka event ini lagi untuk mendaftar.',
        duration: const Duration(seconds: 10),
      );
    case ReservationInvalidMethod(:final message):
      scope.snack('$message Anda belum terdaftar.', duration: const Duration(seconds: 10));
    case ReservationNetworkFailed():
      showReservationRetry(scope, null);
    case ReservationStopped():
      break;
  }
}
