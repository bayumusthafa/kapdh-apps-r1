import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';
import '../../home/shared/content_widgets.dart';
import '../../home/shared/remote_image.dart';
import '../event_format.dart';

/// Kartu event (guideline hal. 8 daftar event): cover di kiri, chip kategori, judul, tanggal dalam zona event dan
/// label pendaftaran berikon (status tidak dibedakan dengan warna saja, PRD 4.5). Dipakai daftar Event dan Beranda.
class EventCard extends StatelessWidget {
  const EventCard({
    super.key,
    required this.title,
    required this.coverUrl,
    required this.categoryLabel,
    required this.startsAt,
    required this.timezone,
    required this.locationName,
    required this.registration,
    required this.priceLabel,
    this.myTicketStatus,
    this.onTap,
  });

  factory EventCard.summary(EventSummary event, {Key? key, VoidCallback? onTap}) => EventCard(
    key: key,
    title: event.title,
    coverUrl: event.coverUrl,
    categoryLabel: event.category?.label,
    startsAt: event.startsAt,
    timezone: event.timezone,
    locationName: event.locationName,
    registration: registrationStateStyle(event.registrationState),
    priceLabel: formatEventPrice(event.price, isFree: event.isFree),
    myTicketStatus: event.myTicketStatus,
    onTap: onTap,
  );

  factory EventCard.home(HomeEvent event, {Key? key, VoidCallback? onTap}) => EventCard(
    key: key,
    title: event.title,
    coverUrl: event.coverUrl,
    categoryLabel: event.category?.label,
    startsAt: event.startsAt,
    timezone: event.timezone,
    locationName: event.locationName,
    registration: homeRegistrationStateStyle(event.registrationState),
    priceLabel: formatEventPrice(event.price, isFree: event.isFree),
    onTap: onTap,
  );

  final String title;
  final String? coverUrl;
  final String? categoryLabel;
  final DateTime startsAt;
  final String timezone;
  final String? locationName;
  final StatusBadgeStyle registration;
  final String priceLabel;

  /// Status tiket terbaru milik pemanggil di event ini (null bila belum pernah memesan).
  final TicketStatus? myTicketStatus;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final day = formatEventDay(startsAt, timezone);
    final ticket = myTicketStatus == null ? null : ticketStatusStyle(myTicketStatus!);
    final label = [
      title,
      ?categoryLabel,
      day,
      ?locationName,
      priceLabel,
      registration.label,
      if (ticket != null) 'Tiket Anda: ${ticket.label}',
    ].join(', ');
    return TappableCard(
      onTap: onTap,
      semanticsLabel: label,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RemoteImage(
            url: coverUrl,
            width: 92,
            height: 76,
            borderRadius: BorderRadius.circular(KapdhRadius.md),
            placeholderIcon: Icons.event,
          ),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (categoryLabel != null) ...[CategoryChip(categoryLabel!), const SizedBox(height: 6)],
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: KapdhSpace.s1),
                IconLine(icon: Icons.calendar_today_outlined, text: day),
                if (locationName != null) ...[
                  const SizedBox(height: 2),
                  IconLine(icon: Icons.place_outlined, text: locationName!),
                ],
                const SizedBox(height: 6),
                Wrap(
                  spacing: KapdhSpace.s2,
                  runSpacing: KapdhSpace.s1,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    StatusBadge(registration),
                    Text(
                      priceLabel,
                      style: const TextStyle(
                        fontSize: KapdhFontSize.caption,
                        fontWeight: FontWeight.w600,
                        color: KapdhColors.primary,
                      ),
                    ),
                    if (ticket != null) StatusBadge(ticket),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
