import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../home/shared/content_widgets.dart';
import '../home/shared/links.dart';
import '../home/shared/member_gate.dart';
import '../home/shared/remote_image.dart';
import 'event_format.dart';
import 'events_controllers.dart';
import 'reservation.dart';
import 'reservation_screen.dart';

/// Detail Event (F-09; guideline hal. 8 "Detail Event"): cover, kategori, judul, deskripsi, jadwal dalam zona event,
/// lokasi, kuota "x/y Kuota Peserta", jendela pendaftaran dan check-in, aturan pembatalan D6, tiket saya, daftar
/// peserta, dan tombol "Daftar Sekarang" yang hanya aktif bila server mengizinkan (`can_reserve`). Satu kursi untuk
/// diri sendiri, tanpa pilihan jumlah tiket (PRD 3.9).
class EventDetailScreen extends ConsumerStatefulWidget {
  const EventDetailScreen({super.key, required this.eventId});

  /// Parameter rute `eventId`.
  final String eventId;

  @override
  ConsumerState<EventDetailScreen> createState() => _EventDetailScreenState();
}

class _EventDetailScreenState extends ConsumerState<EventDetailScreen> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final provider = eventDetailControllerProvider(widget.eventId);
    final state = ref.watch(provider);
    final event = state.event;
    final error = state.error;
    final status = ref.watch(sessionProvider.select((session) => session.effectiveStatus));
    final maintenance = ref.watch(appGateProvider.select((gate) => gate.status == GateStatus.maintenance));

    Widget body;
    if (event == null && state.loading) {
      body = ListView(children: const [LoadingSkeleton(lines: 8, semanticsLabel: 'Memuat event')]);
    } else if (event == null && error != null) {
      body = error.code == ErrorCode.notFound
          ? EmptyState(
              icon: Icons.event_busy_outlined,
              title: 'Event tidak tersedia',
              message: 'Event ini belum diterbitkan atau sudah dihapus pengurus.',
              actionLabel: 'Lihat event lain',
              onAction: () => context.go(AppRoutes.events),
            )
          : ErrorState.fromException(error, onRetry: () => unawaited(ref.read(provider.notifier).reload()));
    } else {
      final showParticipants = isActiveMember(status);
      body = RefreshIndicator(
        onRefresh: () => Future.wait<Object?>([
          ref.read(provider.notifier).reload(),
          if (showParticipants) ref.read(participantsControllerProvider(widget.eventId).notifier).refresh(),
        ]),
        child: _EventContent(event: event!, showParticipants: showParticipants),
      );
    }
    return AppScaffold(
      title: 'Detail Event',
      fallbackLocation: AppRoutes.events,
      body: body,
      bottomNavigationBar: event == null
          ? null
          : _ActionBar(
              event: event,
              status: status,
              busy: _busy,
              maintenance: maintenance,
              onReserve: () => unawaited(_reserve(event)),
            ),
    );
  }

  /// Event gratis: konfirmasi lalu tiket langsung paid (AC F09-3). Event berbayar: layar konfirmasi dengan harga,
  /// metode bayar dan total, lalu ke layar pembayaran bersama (guideline hal. 8 "Detail Tiket").
  Future<void> _reserve(EventDetail event) async {
    if (!event.isFree) {
      final done = await Navigator.of(context).push<ReservationDone>(
        MaterialPageRoute<ReservationDone>(builder: (_) => ReservationScreen(eventId: event.id)),
      );
      if (done != null && mounted) openReservationResult(context, ref, done);
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Daftar event gratis?'),
        content: Text(
          '${event.title}\n${formatEventSchedule(event.startsAt, event.endsAt, event.timezone)}\n\n'
          'Satu tiket untuk Anda sendiri. Tiket langsung terbit tanpa pembayaran.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Batal')),
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: const Text('Daftar')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _submitFree(event);
  }

  Future<void> _submitFree(EventDetail event) async {
    setState(() => _busy = true);
    final outcome = await submitReservation(context, ref, event: event);
    if (!mounted) return;
    setState(() => _busy = false);
    switch (outcome) {
      case final ReservationDone done:
        openReservationResult(context, ref, done);
      case ReservationPriceChanged(event: final latest):
        // Harga berubah (mis. menjadi berbayar): tidak ada hold; anggota melihat harga baru lalu mendaftar lagi.
        showAppSnackBar(
          ref,
          'Harga tiket berubah menjadi ${formatEventPrice(latest.price, isFree: latest.isFree)}. Periksa kembali '
          'sebelum mendaftar.',
        );
      case ReservationNetworkFailed():
        showReservationRetry(ref, () => unawaited(_submitFree(event)));
      case ReservationInvalidMethod():
      case ReservationStopped():
        break;
    }
  }
}

class _EventContent extends ConsumerWidget {
  const _EventContent({required this.event, required this.showParticipants});

  final EventDetail event;
  final bool showParticipants;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final zone = event.timezone;
    final cancelled = event.registrationState == EventRegistrationState.cancelled || event.status == EventStatus.cancelled;
    final myTicket = event.myTicket;
    final description = event.description;
    return ListView(
      key: const ValueKey('event-detail'),
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        AspectRatio(
          aspectRatio: 16 / 9,
          child: RemoteImage(
            url: event.coverUrl,
            semanticLabel: 'Cover event ${event.title}',
            borderRadius: BorderRadius.circular(KapdhRadius.lg),
            placeholderIcon: Icons.event,
          ),
        ),
        const SizedBox(height: KapdhSpace.s4),
        Wrap(
          spacing: KapdhSpace.s2,
          runSpacing: KapdhSpace.s2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            if (event.category != null) CategoryChip(event.category!.label),
            StatusBadge(registrationStateStyle(event.registrationState)),
          ],
        ),
        const SizedBox(height: KapdhSpace.s2),
        Semantics(
          header: true,
          child: Text(
            event.title,
            style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w700, height: 1.3),
          ),
        ),
        if (cancelled) ...[
          const SizedBox(height: KapdhSpace.s3),
          InfoBox(
            tone: InfoBoxTone.danger,
            icon: Icons.cancel_outlined,
            title: 'Event dibatalkan',
            message: [
              if (event.cancelReason != null && event.cancelReason!.trim().isNotEmpty)
                'Alasan: ${event.cancelReason!.trim()}.',
              'Seluruh QR tiket tidak berlaku. Peserta berbayar mendapat refund penuh yang diproses bendahara '
                  'paling lambat 7 hari kerja.',
            ].join(' '),
          ),
        ],
        if (description != null && description.trim().isNotEmpty) ...[
          const SizedBox(height: KapdhSpace.s3),
          Text(description.trim(), style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.55)),
        ],
        const SizedBox(height: KapdhSpace.s4),
        _InfoCard(
          children: [
            IconLine(
              icon: Icons.calendar_today_outlined,
              text: formatEventSchedule(event.startsAt, event.endsAt, zone),
              color: KapdhColors.text,
              size: 13,
            ),
            if (event.locationName != null || event.locationAddress != null)
              IconLine(
                icon: Icons.place_outlined,
                text: [?event.locationName, ?event.locationAddress].join('\n'),
                color: KapdhColors.text,
                size: 13,
              ),
            if (event.locationUrl != null) _MapLink(url: event.locationUrl!),
            _Quota(available: event.seatsAvailable, total: event.seatsTotal),
            IconLine(
              icon: Icons.payments_outlined,
              text: 'Harga tiket: ${formatEventPrice(event.price, isFree: event.isFree)} (satu tiket untuk Anda sendiri)',
              color: KapdhColors.text,
              size: 13,
            ),
            IconLine(
              icon: Icons.how_to_reg_outlined,
              text:
                  'Pendaftaran: ${formatDateTime(event.registrationOpensAt, zone: zone)} – '
                  '${formatDateTime(event.registrationClosesAt, zone: zone)}',
              color: KapdhColors.text,
              size: 13,
            ),
            IconLine(
              icon: Icons.qr_code_scanner,
              text:
                  'Check-in: ${formatDateTime(event.checkinOpensAt, zone: zone)} – '
                  '${formatDateTime(event.checkinClosesAt, zone: zone)}',
              color: KapdhColors.text,
              size: 13,
            ),
          ],
        ),
        if (myTicket != null) ...[
          const SizedBox(height: KapdhSpace.s4),
          _MyTicketCard(ticket: myTicket),
        ],
        const SizedBox(height: KapdhSpace.s4),
        InfoBox(
          icon: Icons.policy_outlined,
          title: 'Pembatalan dan refund',
          message: event.cancellationPolicy.summary,
        ),
        if (!event.isFree && event.canReserve) ...[
          const SizedBox(height: KapdhSpace.s3),
          InfoBox(
            icon: Icons.timer_outlined,
            message:
                'Event berbayar: kursi ditahan maksimal ${event.holdHours} jam atau sampai pendaftaran ditutup, mana '
                'yang lebih dahulu. Kirim bukti transfer sebelum batas waktu.',
          ),
        ],
        if (showParticipants) ...[
          const SizedBox(height: KapdhSpace.s5),
          _Participants(eventId: event.id, count: event.participantCount),
        ],
      ],
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const SizedBox(height: KapdhSpace.s3),
            children[i],
          ],
        ],
      ),
    );
  }
}

/// Kuota "20/36 Kuota Peserta" (guideline hal. 8): kursi tersedia dari total, proyeksi server (PRD 4.4).
class _Quota extends StatelessWidget {
  const _Quota({required this.available, required this.total});

  final int available;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: 'Kuota peserta: $available kursi tersedia dari $total',
      excludeSemantics: true,
      child: Row(
        children: [
          const Icon(Icons.groups_outlined, size: 18, color: KapdhColors.primary),
          const SizedBox(width: 6),
          Text(
            '$available/$total',
            key: const ValueKey('event-quota'),
            style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w700, color: KapdhColors.primary),
          ),
          const SizedBox(width: KapdhSpace.s1),
          const Expanded(
            child: Text('Kuota Peserta', style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted)),
          ),
        ],
      ),
    );
  }
}

class _MapLink extends ConsumerWidget {
  const _MapLink({required this.url});

  final String url;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        onPressed: () => unawaited(openContentLink(context, ref, url)),
        icon: const ExternalLinkMark(),
        label: const Text('Buka peta lokasi (tautan luar)'),
      ),
    );
  }
}

class _MyTicketCard extends StatelessWidget {
  const _MyTicketCard({required this.ticket});

  final TicketSummary ticket;

  @override
  Widget build(BuildContext context) {
    final style = ticketStatusStyle(ticket.status, checkedInAt: ticket.checkedInAt);
    return TappableCard(
      onTap: () => unawaited(context.push(AppRoutes.ticket(ticket.id))),
      semanticsLabel: 'Tiket Anda: ${style.label}. Buka detail tiket.',
      child: Row(
        children: [
          const Icon(Icons.confirmation_number_outlined, color: KapdhColors.primary),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Tiket Anda', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: KapdhSpace.s1),
                StatusBadge(style),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: KapdhColors.textMuted),
        ],
      ),
    );
  }
}

/// Peserta terkonfirmasi yang tampil di direktori (guideline hal. 8 "Peserta"); kontak tidak pernah dikirim.
class _Participants extends ConsumerWidget {
  const _Participants({required this.eventId, required this.count});

  final String eventId;
  final int count;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = participantsControllerProvider(eventId);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final error = state.error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(
            'Peserta ($count)',
            style: const TextStyle(fontSize: KapdhFontSize.bodyLg, fontWeight: FontWeight.w600),
          ),
        ),
        const SizedBox(height: KapdhSpace.s1),
        const Text(
          'Hanya peserta terkonfirmasi yang tampil di direktori alumni.',
          style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
        ),
        const SizedBox(height: KapdhSpace.s3),
        if (!state.loaded && state.loading)
          const LoadingSkeleton(showCard: false, lines: 3, semanticsLabel: 'Memuat peserta')
        else if (!state.loaded && error != null)
          InfoBox(
            tone: InfoBoxTone.warning,
            message: error.message,
            trailing: TextButton(onPressed: () => unawaited(controller.refresh()), child: const Text('Coba lagi')),
          )
        else if (state.items.isEmpty)
          const Text(
            'Belum ada peserta terkonfirmasi yang tampil di direktori.',
            style: TextStyle(fontSize: 13, color: KapdhColors.textMuted),
          )
        else ...[
          for (final participant in state.items) _ParticipantTile(participant: participant),
          if (state.loadingMore)
            const Padding(
              padding: EdgeInsets.all(KapdhSpace.s3),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else if (state.hasMore || state.loadMoreError != null)
            Center(
              child: TextButton(
                onPressed: () => unawaited(controller.loadMore()),
                child: Text(state.loadMoreError != null ? 'Coba lagi' : 'Lihat peserta lainnya'),
              ),
            ),
        ],
      ],
    );
  }
}

class _ParticipantTile extends StatelessWidget {
  const _ParticipantTile({required this.participant});

  final EventParticipant participant;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: KapdhSpace.s2),
      child: TappableCard(
        onTap: () => unawaited(context.push(AppRoutes.member(participant.userId))),
        semanticsLabel: '${participant.fullName}, ${participant.cohortCode}. Buka profil.',
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s3, vertical: KapdhSpace.s2),
        child: Row(
          children: [
            SizedBox(
              width: 40,
              height: 40,
              child: participant.avatarUrl == null
                  ? CircleAvatar(
                      backgroundColor: KapdhColors.green100,
                      child: Text(
                        initialsOf(participant.fullName),
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: KapdhColors.primary),
                      ),
                    )
                  : RemoteImage(
                      url: participant.avatarUrl,
                      width: 40,
                      height: 40,
                      borderRadius: BorderRadius.circular(20),
                      placeholderIcon: Icons.person,
                    ),
            ),
            const SizedBox(width: KapdhSpace.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(participant.fullName, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  Text(
                    '#${participant.cohortCode.replaceAll(' ', '')}',
                    style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Tombol aksi bawah (guideline hal. 8 "Daftar Sekarang"); status dan alasan berasal dari server
/// (`can_reserve`, `reservation_blocked_reason`), klien tidak menghitung sendiri.
class _ActionBar extends StatelessWidget {
  const _ActionBar({
    required this.event,
    required this.status,
    required this.busy,
    required this.maintenance,
    required this.onReserve,
  });

  final EventDetail event;
  final EffectiveStatus? status;
  final bool busy;
  final bool maintenance;
  final VoidCallback onReserve;

  @override
  Widget build(BuildContext context) {
    final myTicket = event.myTicket;
    Widget button;
    String? note;
    if (event.canReserve) {
      button = KapdhButton(
        key: const ValueKey('event-reserve'),
        label: 'Daftar Sekarang',
        busy: busy,
        busyLabel: 'Mendaftarkan…',
        onPressed: maintenance ? null : onReserve,
      );
      if (maintenance) note = 'Pendaftaran ditunda selama pemeliharaan. Coba lagi setelah layanan normal.';
    } else if (myTicket != null &&
        (event.reservationBlockedReason == EventReservationBlockReason.hasActiveTicket ||
            isActiveTicketStatus(myTicket.status))) {
      button = KapdhButton.solid(
        key: const ValueKey('event-open-ticket'),
        label: 'Lihat Tiket Saya',
        icon: Icons.confirmation_number_outlined,
        onPressed: () => unawaited(context.push(AppRoutes.ticket(myTicket.id))),
      );
    } else {
      final reason = event.reservationBlockedReason;
      final (String label, String? hint, String? route, String? routeLabel) = switch (reason) {
        EventReservationBlockReason.membershipRequired => switch (status) {
          EffectiveStatus.expired => (
            'Khusus anggota aktif',
            'Perpanjang KTA untuk mendaftar event baru.',
            AppRoutes.renewal,
            'Perpanjang KTA',
          ),
          EffectiveStatus.unverified => (
            'Khusus anggota aktif',
            'Selesaikan iuran pendaftaran agar KTA aktif.',
            AppRoutes.onboardingFees,
            'Bayar iuran',
          ),
          _ => ('Khusus anggota aktif', null, null, null),
        },
        EventReservationBlockReason.notYetOpen => (
          'Pendaftaran Belum Dibuka',
          'Pendaftaran dibuka ${formatDateTime(event.registrationOpensAt, zone: event.timezone)}.',
          null,
          null,
        ),
        EventReservationBlockReason.closed => ('Pendaftaran Ditutup', null, null, null),
        EventReservationBlockReason.soldOut => (
          'Kuota Penuh',
          'Kursi dapat tersedia kembali bila ada reservasi yang berakhir atau dibatalkan.',
          null,
          null,
        ),
        EventReservationBlockReason.cancelled => ('Event Dibatalkan', null, null, null),
        _ => (
          registrationStateStyle(event.registrationState).label,
          null,
          null,
          null,
        ),
      };
      button = route == null
          ? KapdhButton(key: const ValueKey('event-reserve-disabled'), label: label, onPressed: null)
          : KapdhButton(label: routeLabel!, onPressed: () => context.go(route));
      note = hint;
    }
    return Container(
      decoration: const BoxDecoration(
        color: KapdhColors.surface,
        border: Border(top: BorderSide(color: KapdhColors.divider)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s3, KapdhSpace.s5, KapdhSpace.s3),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (note != null) ...[
                Text(
                  note,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                ),
                const SizedBox(height: KapdhSpace.s2),
              ],
              button,
            ],
          ),
        ),
      ),
    );
  }
}
