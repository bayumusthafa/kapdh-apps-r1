import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../app/redirect.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/api/error_presenter.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/app_keys.dart';
import '../../design/design.dart';
import '../events/event_format.dart';
import '../events/events_controllers.dart';
import '../home/shared/content_widgets.dart';
import '../home/shared/links.dart';
import '../home/shared/member_gate.dart';
import '../home/shared/remote_image.dart';
import 'widgets/hold_countdown.dart';

/// Tenggat bendahara memproses refund sejak pembatalan (D6, PRD 3.9).
const int refundBusinessDays = 7;

/// Detail Tiket (F-09; PRD 4.4, D5, D6): status berlabel, hitung mundur hold untuk reservasi yang menunggu bukti,
/// QR hanya untuk tiket lunas (AC F09-3, F09-7), pembayaran dan refund, serta pembatalan sendiri dengan aturan H-3.
/// Anggota expired tetap membuka tiket dan QR lunasnya (PRD 2.2).
class TicketDetailScreen extends ConsumerWidget {
  const TicketDetailScreen({super.key, required this.ticketId});

  /// Parameter rute `ticketId`.
  final String ticketId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = ticketDetailControllerProvider(ticketId);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final ticket = state.ticket;
    final error = state.error;

    Widget body;
    if (ticket == null && state.loading) {
      body = ListView(children: const [LoadingSkeleton(lines: 8, semanticsLabel: 'Memuat tiket')]);
    } else if (ticket == null && error != null) {
      body = error.code == ErrorCode.notFound
          ? EmptyState(
              icon: Icons.search_off,
              title: 'Tiket tidak ditemukan',
              message: 'Tiket ini tidak ada atau bukan milik akun Anda.',
              actionLabel: 'Lihat tiket saya',
              onAction: () => context.go(AppRoutes.tickets),
            )
          : ErrorState.fromException(error, onRetry: () => unawaited(controller.reload()));
    } else {
      body = RefreshIndicator(
        onRefresh: controller.reload,
        child: _TicketContent(
          ticket: ticket!,
          cancelling: state.cancelling,
          checking: state.loading,
          controller: controller,
          refreshError: state.error,
        ),
      );
    }
    return AppScaffold(title: 'Detail Tiket', fallbackLocation: AppRoutes.tickets, body: body);
  }
}

class _TicketContent extends ConsumerWidget {
  const _TicketContent({
    required this.ticket,
    required this.cancelling,
    required this.checking,
    required this.controller,
    this.refreshError,
  });

  final TicketDetail ticket;
  final bool cancelling;

  /// Status sedang dimuat ulang dari server.
  final bool checking;
  final TicketDetailController controller;

  /// Galat muat ulang terakhir; tiket yang tampil adalah keadaan terakhir yang berhasil dimuat.
  final ApiException? refreshError;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final active = isActiveMember(session.effectiveStatus);
    // Detail event mengikuti matriks rute (PRD 2.2): anggota expired tetap membuka event yang pernah ia pesan
    // (kontrak C5 getEvent), anggota aktif membuka event apa pun.
    final canOpenEvent = isLocationAllowed(
      RedirectState(gate: ref.watch(appGateProvider).status, session: session),
      AppRoutes.event(ticket.event.id),
    );
    final payment = ticket.payment;
    // Batas hold menurut perkiraan jam server sudah lewat tetapi status server belum terbaru (mis. offline): tiket
    // tidak lagi menawarkan bayar atau batal agar anggota tidak mentransfer untuk hold yang sudah berakhir
    // (D5, AC F09-2, PRD 4.5). Pemicu muat ulang: HoldCountdown saat batas tercapai.
    final holdPassed = _holdPassed(ref, ticket);
    final policy = holdPassed ? null : _policyText(ticket);
    return ListView(
      key: const ValueKey('ticket-detail'),
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        RefreshFailedNotice(error: refreshError, onRetry: () => unawaited(controller.reload())),
        _EventHeader(ticket: ticket, canOpenEvent: canOpenEvent),
        const SizedBox(height: KapdhSpace.s4),
        ..._statusSection(context, ref, active: active, holdPassed: holdPassed),
        if (payment != null) ...[const SizedBox(height: KapdhSpace.s4), _PaymentCard(payment: payment)],
        if (ticket.refunds.isNotEmpty) ...[
          const SizedBox(height: KapdhSpace.s4),
          _RefundsCard(refunds: ticket.refunds, paymentId: payment?.id),
        ],
        if (policy != null) ...[
          const SizedBox(height: KapdhSpace.s4),
          InfoBox(
            key: const ValueKey('ticket-cancel-policy'),
            icon: Icons.policy_outlined,
            title: 'Aturan pembatalan',
            message: policy,
          ),
        ],
        if (ticket.canCancel && !holdPassed) ...[
          const SizedBox(height: KapdhSpace.s4),
          OutlinedButton.icon(
            key: const ValueKey('ticket-cancel'),
            onPressed: cancelling ? null : () => unawaited(_cancel(context, ref)),
            style: OutlinedButton.styleFrom(
              foregroundColor: KapdhColors.danger,
              side: const BorderSide(color: KapdhColors.danger),
              minimumSize: const Size.fromHeight(KapdhSize.buttonHeight),
            ),
            icon: cancelling
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.event_busy_outlined),
            label: Text(
              cancelling
                  ? 'Membatalkan…'
                  : (ticket.status == TicketStatus.awaitingPayment ? 'Batalkan Reservasi' : 'Batalkan Tiket'),
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _statusSection(BuildContext context, WidgetRef ref, {required bool active, required bool holdPassed}) {
    final event = ticket.event;
    final zone = event.timezone;
    final payment = ticket.payment;
    final eventCancelled = event.status == EventStatus.cancelled;
    switch (ticket.status) {
      case TicketStatus.awaitingPayment:
        final hold = ticket.holdExpiresAt;
        final countdown = hold == null
            ? null
            : HoldCountdown(expiresAt: hold, zone: zone, onExpired: () => unawaited(controller.reload()));
        if (holdPassed) {
          return [
            ?countdown,
            const SizedBox(height: KapdhSpace.s3),
            InfoBox(
              key: const ValueKey('ticket-hold-passed'),
              tone: InfoBoxTone.warning,
              icon: Icons.sync_problem,
              title: checking ? 'Memeriksa status reservasi…' : 'Status reservasi belum terbaru',
              message:
                  'Batas kirim bukti sudah lewat, sehingga reservasi ini kemungkinan sudah berakhir dan kursinya '
                  'dilepas. Jangan transfer untuk reservasi ini sebelum statusnya diperbarui.',
              trailing: checking
                  ? null
                  : TextButton(
                      key: const ValueKey('ticket-hold-reload'),
                      onPressed: () => unawaited(controller.reload()),
                      child: const Text('Muat ulang'),
                    ),
            ),
          ];
        }
        return [
          ?countdown,
          const SizedBox(height: KapdhSpace.s3),
          const InfoBox(
            icon: Icons.account_balance_outlined,
            message:
                'Transfer sesuai nominal ke rekening tujuan, lalu unggah bukti transfer. Kursi Anda dilepas otomatis '
                'bila bukti tidak dikirim sebelum batas waktu.',
          ),
          if (payment != null) ...[
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton(
              key: const ValueKey('ticket-pay'),
              label: 'Bayar Sekarang',
              icon: Icons.upload_file_outlined,
              onPressed: () => unawaited(context.push(AppRoutes.payment(payment.id))),
            ),
          ],
        ];
      case TicketStatus.awaitingReview:
        return [
          const InfoBox(
            icon: Icons.hourglass_top,
            title: 'Menunggu verifikasi pengurus',
            message:
                'Bukti transfer Anda sedang diverifikasi. Kursi tetap ditahan sampai keputusan; QR tiket terbit '
                'setelah pembayaran dinyatakan lunas.',
          ),
          if (payment != null) ...[
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton.outlined(
              label: 'Lihat pembayaran',
              onPressed: () => unawaited(context.push(AppRoutes.payment(payment.id))),
            ),
          ],
        ];
      case TicketStatus.paid:
        final checkedInAt = ticket.checkedInAt;
        final qr = ticket.qrCode;
        final window =
            '${formatDateTime(ticket.checkinOpensAt, zone: zone)} – ${formatDateTime(ticket.checkinClosesAt, zone: zone)}';
        if (checkedInAt != null) {
          return [
            InfoBox(
              icon: Icons.how_to_reg,
              title: 'Sudah check-in',
              message: 'Anda tercatat hadir pada ${formatDateTime(checkedInAt, zone: zone)}.',
            ),
          ];
        }
        if (qr == null || eventCancelled) {
          return [
            const InfoBox(
              tone: InfoBoxTone.warning,
              message: 'QR tiket tidak tersedia. Tarik layar ke bawah untuk memuat ulang atau hubungi pengurus.',
            ),
          ];
        }
        return [
          _TicketQr(data: qr),
          const SizedBox(height: KapdhSpace.s3),
          InfoBox(
            icon: Icons.qr_code_scanner,
            title: 'Tunjukkan QR ini kepada petugas check-in',
            message: 'Check-in dibuka $window. Satu QR hanya dapat dipindai sekali; jangan bagikan QR ini.',
          ),
        ];
      case TicketStatus.expired:
        return [
          InfoBox(
            tone: InfoBoxTone.warning,
            icon: Icons.timer_off_outlined,
            title: 'Reservasi berakhir',
            message:
                'Bukti transfer tidak dikirim sebelum batas waktu, sehingga kursi sudah dilepas. Jangan transfer untuk '
                        'reservasi ini. ${active ? 'Anda dapat mendaftar ulang bila kuota masih tersedia.' : ''}'
                    .trim(),
          ),
          if (active && !eventCancelled) ...[
            const SizedBox(height: KapdhSpace.s3),
            KapdhButton.outlined(
              label: 'Lihat event',
              onPressed: () => unawaited(context.push(AppRoutes.event(event.id))),
            ),
          ],
        ];
      case TicketStatus.cancelled:
        return [
          InfoBox(
            tone: InfoBoxTone.danger,
            icon: Icons.block,
            title: eventCancelled ? 'Event dibatalkan' : 'Tiket dibatalkan',
            message: _cancelledText(ticket),
          ),
        ];
      case TicketStatus.unknown:
        return [
          const InfoBox(
            tone: InfoBoxTone.warning,
            message: 'Status tiket belum dikenali versi aplikasi ini. Perbarui aplikasi untuk detail lengkap.',
          ),
        ];
    }
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref) async {
    // Diambil sebelum await: hasil pembatalan tetap diberitahukan walau layar ditutup selama request (PRD 4.5),
    // tanpa memakai WidgetRef layar yang sudah dilepas.
    final presenter = ref.read(errorPresenterProvider);
    final messenger = ref.read(scaffoldMessengerKeyProvider);
    final container = ProviderScope.containerOf(context, listen: false);
    final reason = await showDialog<String>(
      context: context,
      builder: (_) => _CancelDialog(ticket: ticket),
    );
    if (reason == null || !context.mounted) return;
    final expectedRefundEligible = ticket.refundEligible;
    final result = await controller.cancel(expectedRefundEligible: expectedRefundEligible, reason: reason);
    final error = result.error;
    final current = result.ticket;
    if (error == null) {
      if (current == null) return;
      if (!context.mounted) {
        // Layar sudah dilepas sebelum respons tiba: daftar Tiket Saya dan detail event tetap diperbarui.
        container
          ..invalidate(ticketsControllerProvider)
          ..invalidate(eventDetailControllerProvider(ticket.event.id));
      }
      final refundPending = current.refunds.any((r) => r.status == TicketRefundStatus.pending);
      showMessengerSnackBar(
        messenger,
        refundPending
            ? 'Tiket dibatalkan. Refund penuh diproses bendahara paling lambat $refundBusinessDays hari kerja; '
                  'rekening tujuan diminta di halaman pembayaran.'
            : ticket.status == TicketStatus.awaitingPayment
            ? 'Reservasi dibatalkan dan kursi dilepas. Jangan transfer untuk reservasi ini.'
            : 'Tiket dibatalkan dan kursi Anda dilepas.',
      );
      return;
    }
    if (!context.mounted) {
      await presenter.present(error);
      return;
    }
    switch (error.code) {
      case ErrorCode.versionConflict:
        final refundLost = expectedRefundEligible && current != null && !current.refundEligible;
        await _explain(
          context,
          'Data tiket berubah',
          refundLost
              ? 'Batas refund penuh (H-3) sudah lewat. Pembatalan sekarang tidak mendapat refund. Periksa kembali '
                    'sebelum membatalkan.'
              : '${error.message} Periksa keadaan terbaru sebelum mencoba lagi.',
        );
      case ErrorCode.paymentStateConflict:
        await _explain(context, 'Tiket tidak dapat dibatalkan', error.message);
      default:
        // Muat ulang hanya selama detail masih terbuka: pengendalinya dilepas bersama layar.
        await presenter.present(
          error,
          onReload: () {
            if (context.mounted) unawaited(controller.reload());
          },
        );
    }
  }
}

/// Reservasi menunggu bukti yang batas hold-nya sudah lewat menurut perkiraan jam server (`ServerClock`, bukan jam
/// perangkat; PRD 2.1) sementara status dari server belum berubah menjadi expired.
bool _holdPassed(WidgetRef ref, TicketDetail ticket) {
  final hold = ticket.holdExpiresAt;
  if (ticket.status != TicketStatus.awaitingPayment || hold == null) return false;
  return !ref.read(serverClockProvider).now().isBefore(hold);
}

Future<void> _explain(BuildContext context, String title, String message) async {
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Tutup'))],
    ),
  );
}

/// Teks aturan pembatalan D6 untuk tiket yang masih dapat atau pernah dapat dibatalkan.
String? _policyText(TicketDetail ticket) {
  if (ticket.event.status == EventStatus.cancelled) return null;
  final zone = ticket.event.timezone;
  final free = ticket.payment == null;
  switch (ticket.status) {
    case TicketStatus.awaitingPayment:
      return 'Reservasi dapat dibatalkan sebelum bukti transfer dikirim; kursi dilepas dan pembayaran dibatalkan.';
    case TicketStatus.awaitingReview:
      return 'Tiket yang buktinya sedang diverifikasi tidak dapat dibatalkan sendiri karena dana mungkin sudah '
          'ditransfer. Tunggu keputusan pengurus atau hubungi pengurus.';
    case TicketStatus.paid:
      if (ticket.checkedInAt != null) return null;
      if (free) return 'Event gratis tidak memiliki refund; pembatalan melepas kursi untuk anggota lain.';
      final until = ticket.fullRefundUntil;
      if (until == null) return 'Pembatalan sendiri diperbolehkan sebelum acara dimulai, tanpa refund.';
      final date = formatDateTime(until, zone: zone);
      return ticket.refundEligible
          ? 'Batalkan sampai $date (H-3) untuk refund penuh ${formatRupiah(ticket.total)}; setelah itu pembatalan '
                'tanpa refund. Refund ditransfer bendahara paling lambat $refundBusinessDays hari kerja.'
          : 'Batas refund penuh (H-3) sudah lewat pada $date. Pembatalan sekarang tetap boleh sebelum acara '
                'dimulai, tetapi tanpa refund.';
    case TicketStatus.expired:
    case TicketStatus.cancelled:
    case TicketStatus.unknown:
      return null;
  }
}

String _cancelledText(TicketDetail ticket) {
  final zone = ticket.event.timezone;
  final at = ticket.cancelledAt == null ? '' : ' pada ${formatDateTime(ticket.cancelledAt!, zone: zone)}';
  final payment = ticket.payment;
  final parts = <String>[];
  if (ticket.event.status == EventStatus.cancelled) {
    parts.add('Event dibatalkan pengurus$at; seluruh QR tidak berlaku.');
    if (payment != null) {
      parts.add(
        'Peserta berbayar mendapat refund penuh yang diproses bendahara paling lambat $refundBusinessDays hari kerja.',
      );
    }
  } else if (payment?.status == TicketPaymentStatus.rejected) {
    final reason = payment?.rejectionReason;
    parts.add('Bukti pembayaran ditolak pengurus$at${reason == null ? '.' : ': $reason.'}');
    parts.add('Penolakan tiket bersifat final. Daftar ulang bila kuota masih tersedia.');
  } else {
    parts.add(switch (ticket.cancelledBy) {
      TicketCancelledBy.self => 'Anda membatalkan tiket ini$at.',
      TicketCancelledBy.admin => 'Tiket dibatalkan pengurus$at.',
      TicketCancelledBy.system => 'Tiket dibatalkan sistem$at.',
      _ => 'Tiket dibatalkan$at.',
    });
  }
  final reason = ticket.cancelReason?.trim();
  if (reason != null && reason.isNotEmpty) parts.add('Alasan: $reason.');
  return parts.join(' ');
}

class _EventHeader extends StatelessWidget {
  const _EventHeader({required this.ticket, required this.canOpenEvent});

  final TicketDetail ticket;

  /// Rute detail event diizinkan matriks rute status saat ini (anggota aktif dan expired pemegang tiket, PRD 2.2);
  /// selain itu jadwal dan lokasi tetap terlihat di kartu ini.
  final bool canOpenEvent;

  @override
  Widget build(BuildContext context) {
    final event = ticket.event;
    final free = ticket.payment == null;
    // Kartu ringkas "Nama Event" (guideline hal. 8 Detail Tiket): gambar kecil di kiri sehingga status, hitung
    // mundur dan QR tetap terlihat tanpa menggulir.
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s3),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              RemoteImage(
                url: event.coverUrl,
                width: 88,
                height: 72,
                borderRadius: BorderRadius.circular(KapdhRadius.md),
                placeholderIcon: Icons.event,
              ),
              const SizedBox(width: KapdhSpace.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: KapdhSpace.s2,
                      runSpacing: KapdhSpace.s1,
                      children: [
                        StatusBadge(ticketStatusStyle(ticket.status, checkedInAt: ticket.checkedInAt)),
                        if (event.status == EventStatus.cancelled)
                          StatusBadge(StatusStyles.event(EventBadgeStatus.cancelled)),
                      ],
                    ),
                    const SizedBox(height: KapdhSpace.s2),
                    Semantics(
                      header: true,
                      child: Text(
                        event.title,
                        style: const TextStyle(
                          fontSize: KapdhFontSize.bodyLg,
                          fontWeight: FontWeight.w700,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: KapdhSpace.s3),
          IconLine(
            icon: Icons.calendar_today_outlined,
            text: formatEventSchedule(event.startsAt, event.endsAt, event.timezone),
            color: KapdhColors.text,
            size: 13,
          ),
          if (event.locationName != null) ...[
            const SizedBox(height: KapdhSpace.s1),
            IconLine(icon: Icons.place_outlined, text: event.locationName!, color: KapdhColors.text, size: 13),
          ],
          const SizedBox(height: KapdhSpace.s1),
          IconLine(
            icon: Icons.payments_outlined,
            text: free ? 'Gratis' : 'Total ${formatRupiah(ticket.total)} (1 orang)',
            color: KapdhColors.text,
            size: 13,
          ),
          if (canOpenEvent)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: const ValueKey('ticket-open-event'),
                onPressed: () => unawaited(context.push(AppRoutes.event(event.id))),
                child: const Text('Lihat detail event'),
              ),
            ),
        ],
      ),
    );
  }
}

/// QR tiket (kode acak 128-bit dari server, ARCHITECTURE §3.2); hanya untuk tiket paid yang eventnya tidak
/// dibatalkan (AC F09-3, F09-7).
class _TicketQr extends StatelessWidget {
  const _TicketQr({required this.data});

  final String data;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        padding: const EdgeInsets.all(KapdhSpace.s4),
        decoration: BoxDecoration(
          color: KapdhColors.surface,
          border: Border.all(color: KapdhColors.divider),
          borderRadius: BorderRadius.circular(KapdhRadius.lg),
        ),
        child: QrImageView(
          key: const ValueKey('ticket-qr'),
          data: data,
          size: 220,
          padding: EdgeInsets.zero,
          backgroundColor: KapdhColors.surface,
          eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: KapdhColors.surfaceDark),
          dataModuleStyle: const QrDataModuleStyle(
            dataModuleShape: QrDataModuleShape.square,
            color: KapdhColors.surfaceDark,
          ),
          semanticsLabel: 'QR tiket untuk check-in',
        ),
      ),
    );
  }
}

class _PaymentCard extends StatelessWidget {
  const _PaymentCard({required this.payment});

  final TicketPaymentInfo payment;

  @override
  Widget build(BuildContext context) {
    final style = StatusStyles.payment(
      PaymentStatus.fromJson(payment.status.value),
      proofSubmitted: payment.submittedAt != null,
      correctable: false,
    );
    final method = payment.method;
    final rejection = payment.rejectionReason;
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Pembayaran',
                  style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                ),
              ),
              StatusBadge(style),
            ],
          ),
          const SizedBox(height: KapdhSpace.s3),
          _Row(label: 'Nominal', value: formatRupiah(payment.amount), emphasis: true),
          _Row(
            label: 'Rekening tujuan',
            value: '${method.provider} ${method.accountNumber}\na.n. ${method.accountHolder}',
          ),
          if (payment.submittedAt != null) _Row(label: 'Bukti dikirim', value: formatDateTime(payment.submittedAt!)),
          if (payment.decidedAt != null) _Row(label: 'Diputus', value: formatDateTime(payment.decidedAt!)),
          if (rejection != null && rejection.trim().isNotEmpty) _Row(label: 'Alasan penolakan', value: rejection),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => unawaited(context.push(AppRoutes.payment(payment.id))),
              child: const Text('Lihat pembayaran'),
            ),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.emphasis = false});

  final String label;
  final String value;
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: KapdhSpace.s2),
      child: MergeSemantics(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(label, style: const TextStyle(fontSize: 13, color: KapdhColors.textMuted)),
            ),
            const SizedBox(width: KapdhSpace.s3),
            Flexible(
              flex: 2,
              child: Text(
                value,
                textAlign: TextAlign.right,
                style: TextStyle(fontSize: 13, fontWeight: emphasis ? FontWeight.w600 : FontWeight.w400),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Refund manual oleh bendahara atas payment tiket (D6). Rekening tujuan diminta di layar pembayaran saat refund
/// diproses dan tidak pernah ditampilkan di sini (ARCHITECTURE §2 butir 3).
class _RefundsCard extends StatelessWidget {
  const _RefundsCard({required this.refunds, required this.paymentId});

  final List<TicketRefundInfo> refunds;
  final String? paymentId;

  @override
  Widget build(BuildContext context) {
    final pending = refunds.any((refund) => refund.status == TicketRefundStatus.pending);
    return Container(
      key: const ValueKey('ticket-refunds'),
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Refund',
            style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: KapdhSpace.s3),
          for (final refund in refunds) ...[
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(formatRupiah(refund.amount), style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(switch (refund.status) {
                        TicketRefundStatus.completed when refund.completedAt != null =>
                          'Selesai ${formatDateTime(refund.completedAt!)}',
                        TicketRefundStatus.cancelled => 'Dicatat ulang atau dibatalkan bendahara',
                        _ when refund.dueAt != null => 'Paling lambat ${formatDate(refund.dueAt!)}',
                        _ => 'Diproses bendahara',
                      }, style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted)),
                    ],
                  ),
                ),
                StatusBadge(refundStatusStyle(refund.status)),
              ],
            ),
            const SizedBox(height: KapdhSpace.s3),
          ],
          if (pending && paymentId != null) ...[
            const Text(
              'Rekening tujuan refund diminta saat refund diproses. Isi atau ubah di halaman pembayaran.',
              style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted, height: 1.45),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => unawaited(context.push(AppRoutes.payment(paymentId!))),
                child: const Text('Isi rekening tujuan refund'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Konfirmasi pembatalan dengan teks aturan D6 yang berlaku saat ini (H-3); mengembalikan alasan (boleh kosong)
/// atau null bila dibatalkan.
class _CancelDialog extends StatefulWidget {
  const _CancelDialog({required this.ticket});

  final TicketDetail ticket;

  @override
  State<_CancelDialog> createState() => _CancelDialogState();
}

class _CancelDialogState extends State<_CancelDialog> {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  String _consequence() {
    final ticket = widget.ticket;
    final zone = ticket.event.timezone;
    if (ticket.status == TicketStatus.awaitingPayment) {
      return 'Reservasi dibatalkan dan kursi dilepas. Jangan transfer untuk reservasi ini.';
    }
    if (ticket.payment == null) {
      return 'Event gratis tidak memiliki refund. Kursi Anda dilepas untuk anggota lain.';
    }
    final until = ticket.fullRefundUntil;
    final date = until == null ? null : formatDateTime(until, zone: zone);
    if (ticket.refundEligible) {
      return 'Anda membatalkan sebelum batas refund penuh (H-3${date == null ? '' : ', $date'}). Refund penuh '
          '${formatRupiah(ticket.total)} diproses bendahara paling lambat $refundBusinessDays hari kerja; rekening '
          'tujuan diminta saat refund diproses.';
    }
    return 'Batas refund penuh (H-3${date == null ? '' : ', $date'}) sudah lewat. Pembatalan sekarang TIDAK '
        'mendapat refund. Kursi Anda dilepas untuk anggota lain.';
  }

  @override
  Widget build(BuildContext context) {
    final noRefund =
        widget.ticket.payment != null && !widget.ticket.refundEligible && widget.ticket.status == TicketStatus.paid;
    return AlertDialog(
      title: Text(widget.ticket.status == TicketStatus.awaitingPayment ? 'Batalkan reservasi?' : 'Batalkan tiket?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InfoBox(
              key: const ValueKey('cancel-consequence'),
              tone: noRefund ? InfoBoxTone.danger : InfoBoxTone.warning,
              message: _consequence(),
            ),
            const SizedBox(height: KapdhSpace.s3),
            TextField(
              key: const ValueKey('cancel-reason'),
              controller: _reason,
              maxLength: 500,
              maxLines: 3,
              minLines: 1,
              decoration: const InputDecoration(labelText: 'Alasan (opsional)', border: OutlineInputBorder()),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Kembali')),
        TextButton(
          key: const ValueKey('cancel-confirm'),
          style: TextButton.styleFrom(foregroundColor: KapdhColors.danger),
          onPressed: () => Navigator.of(context).pop(_reason.text),
          child: Text(widget.ticket.status == TicketStatus.awaitingPayment ? 'Batalkan reservasi' : 'Batalkan tiket'),
        ),
      ],
    );
  }
}
