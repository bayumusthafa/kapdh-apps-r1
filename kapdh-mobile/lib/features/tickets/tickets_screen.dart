import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import '../events/event_format.dart';
import '../events/events_controllers.dart';
import '../home/shared/content_widgets.dart';
import '../home/shared/member_gate.dart';
import '../home/shared/paged_list.dart';
import '../home/shared/remote_image.dart';

/// Tiket Saya (F-09): tab Aktif dan Riwayat dengan status berlabel, batas bayar reservasi, keadaan kosong/galat.
/// Anggota expired tetap melihat dan memakai tiket lunasnya (PRD 2.2).
class TicketsScreen extends ConsumerWidget {
  const TicketsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final active = isActiveMember(ref.watch(sessionProvider.select((session) => session.effectiveStatus)));
    return DefaultTabController(
      length: 2,
      child: AppScaffold(
        title: 'Tiket Saya',
        fallbackLocation: AppRoutes.home,
        // TabBar selebar layar (tablet: tidak ikut dibatasi 600); isi tab dibatasi ContentWidth.
        header: ColoredBox(
          color: context.kc.surface,
          child: TabBar(
            labelColor: context.kc.primary,
            unselectedLabelColor: context.kc.textMuted,
            indicatorColor: context.kc.primary,
            tabs: const [
              Tab(text: 'Aktif'),
              Tab(text: 'Riwayat'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _TicketList(view: TicketListView.active, canBrowseEvents: active),
            _TicketList(view: TicketListView.history, canBrowseEvents: active),
          ],
        ),
      ),
    );
  }
}

class _TicketList extends ConsumerWidget {
  const _TicketList({required this.view, required this.canBrowseEvents});

  final TicketListView view;
  final bool canBrowseEvents;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = ticketsControllerProvider(view);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final activeView = view == TicketListView.active;
    return PagedListView(
      key: ValueKey('tickets-${view.value}'),
      state: state,
      loadingSemantics: 'Memuat tiket',
      onRefresh: controller.refresh,
      onLoadMore: () => unawaited(controller.loadMore()),
      itemBuilder: (context, ticket) =>
          TicketCard(ticket: ticket, onTap: () => unawaited(context.push(AppRoutes.ticket(ticket.id)))),
      empty: EmptyState(
        icon: KapdhIcons.confirmationNumberOutlined,
        title: activeView ? 'Belum ada tiket aktif' : 'Belum ada riwayat tiket',
        message: activeView
            ? (canBrowseEvents
                  ? 'Daftar event untuk mendapatkan tiket. Tiket yang lunas memuat QR untuk check-in.'
                  : 'Tiket yang sudah lunas tetap tampil di sini.')
            : 'Tiket yang berakhir, dibatalkan atau eventnya sudah selesai tampil di sini.',
        actionLabel: activeView && canBrowseEvents ? 'Lihat event' : null,
        onAction: activeView && canBrowseEvents ? () => context.go(AppRoutes.events) : null,
      ),
    );
  }
}

/// Kartu tiket: cover, judul event, jadwal dalam zona event, status berlabel dan batas bayar reservasi (PRD 4.4).
class TicketCard extends StatelessWidget {
  const TicketCard({super.key, required this.ticket, this.onTap});

  final TicketSummary ticket;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final event = ticket.event;
    final style = ticketStatusStyle(ticket.status, checkedInAt: ticket.checkedInAt);
    final day = formatEventDay(event.startsAt, event.timezone);
    final hold = ticket.status == TicketStatus.awaitingPayment ? ticket.holdExpiresAt : null;
    final holdText = hold == null ? null : 'Kirim bukti sebelum ${formatDateTime(hold, zone: event.timezone)}';
    final eventCancelled = event.status == EventStatus.cancelled;
    return TappableCard(
      onTap: onTap,
      semanticsLabel: [
        event.title,
        day,
        'Status tiket: ${style.label}',
        ?holdText,
        if (eventCancelled) 'Event dibatalkan',
      ].join(', '),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RemoteImage(
            url: event.coverUrl,
            width: 72,
            height: 72,
            borderRadius: BorderRadius.circular(KapdhRadius.md),
            placeholderIcon: KapdhIcons.confirmationNumberOutlined,
          ),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  event.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: KapdhSpace.s1),
                IconLine(icon: KapdhIcons.calendarTodayOutlined, text: day, iconColor: context.kc.iconAccent),
                if (event.locationName != null) ...[
                  const SizedBox(height: 2),
                  IconLine(icon: KapdhIcons.placeOutlined, text: event.locationName!, iconColor: context.kc.iconAccent),
                ],
                const SizedBox(height: 6),
                Wrap(
                  spacing: KapdhSpace.s2,
                  runSpacing: KapdhSpace.s1,
                  children: [
                    StatusBadge(style),
                    if (eventCancelled) StatusBadge(StatusStyles.event(EventBadgeStatus.cancelled)),
                  ],
                ),
                if (holdText != null) ...[
                  const SizedBox(height: 6),
                  IconLine(icon: KapdhIcons.timerOutlined, text: holdText, color: context.kc.warning),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
