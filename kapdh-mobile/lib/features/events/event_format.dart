import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:timezone/timezone.dart' as tz;

import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';

/// Waktu dalam zona tampilan event (PRD 2.1: tampilkan dalam zona event); zona tak dikenal memakai Asia/Jakarta.
tz.TZDateTime eventLocal(DateTime instant, String zone) {
  tz.Location location;
  try {
    location = tz.getLocation(zone);
  } on Object {
    location = tz.getLocation(jakartaZone);
  }
  return tz.TZDateTime.from(instant.toUtc(), location);
}

/// Tanggal kartu event (guideline hal. 8 "Rabu, 13 Februari 2025"): `Rabu, 13 Feb 2026`.
String formatEventDay(DateTime instant, String zone) =>
    DateFormat('EEEE, d MMM y', 'id').format(eventLocal(instant, zone));

/// Jadwal lengkap dalam zona event: satu hari `Rabu, 13 Feb 2026 · 09.00–12.00 WIB`; beberapa hari
/// `13 Feb 2026, 09.00 WIB – 14 Feb 2026, 12.00 WIB`.
String formatEventSchedule(DateTime startsAt, DateTime endsAt, String zone) {
  final start = eventLocal(startsAt, zone);
  final end = eventLocal(endsAt, zone);
  final sameDay = start.year == end.year && start.month == end.month && start.day == end.day;
  if (sameDay) {
    final hours = '${DateFormat('HH.mm', 'id').format(start)}–${DateFormat('HH.mm', 'id').format(end)}';
    return '${formatEventDay(startsAt, zone)} · $hours ${zoneAbbreviation(end)}';
  }
  return '${formatDateTime(startsAt, zone: zone)} – ${formatDateTime(endsAt, zone: zone)}';
}

/// Harga event: `Gratis` atau `Rp50.000` (Money string, tanpa floating point; ARCHITECTURE §2 butir 5).
String formatEventPrice(String price, {required bool isFree}) => isFree ? 'Gratis' : formatRupiah(price);

/// Sisa waktu hold `HH:MM:SS` (D5: hold 24 jam).
String formatHoldRemaining(Duration remaining) {
  final value = remaining.isNegative ? Duration.zero : remaining;
  final totalSeconds = (value.inMilliseconds / 1000).ceil();
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds % 3600) ~/ 60;
  final seconds = totalSeconds % 60;
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(hours)}:${two(minutes)}:${two(seconds)}';
}

/// Sisa waktu untuk pembaca layar: `23 jam 59 menit`.
String describeHoldRemaining(Duration remaining) {
  final value = remaining.isNegative ? Duration.zero : remaining;
  final hours = value.inHours;
  final minutes = value.inMinutes % 60;
  if (hours > 0) return '$hours jam $minutes menit';
  if (minutes > 0) return '$minutes menit';
  return '${value.inSeconds} detik';
}

StatusBadgeStyle _style(String label, IconData icon, Color fg, Color bg) =>
    StatusBadgeStyle(label: label, icon: icon, foreground: fg, background: bg);

/// Label pendaftaran kartu event (guideline hal. 8 "Pendaftaran di Buka/Tutup"); dihitung server, klien hanya
/// memetakan label + ikon + warna (PRD 4.5).
StatusBadgeStyle registrationStateStyle(EventRegistrationState state) => switch (state) {
  EventRegistrationState.open => _style(
    'Pendaftaran Dibuka',
    Icons.event_available,
    KapdhColors.success,
    KapdhColors.successBg,
  ),
  EventRegistrationState.notYetOpen => _style(
    'Pendaftaran Belum Dibuka',
    Icons.schedule,
    KapdhColors.info,
    KapdhColors.infoBg,
  ),
  EventRegistrationState.soldOut => _style('Kuota Penuh', Icons.group_off, KapdhColors.warning, KapdhColors.warningBg),
  EventRegistrationState.closed => _style(
    'Pendaftaran Ditutup',
    Icons.event_busy,
    KapdhColors.danger,
    KapdhColors.dangerBg,
  ),
  EventRegistrationState.cancelled => _style(
    'Event Dibatalkan',
    Icons.cancel,
    KapdhColors.danger,
    KapdhColors.dangerBg,
  ),
  EventRegistrationState.unknown => _style(
    'Status Tidak Dikenal',
    Icons.help_outline,
    KapdhColors.neutral,
    KapdhColors.neutralBg,
  ),
};

/// Label Beranda memakai nilai yang sama dengan [EventRegistrationState] tanpa `cancelled` (kontrak C4).
StatusBadgeStyle homeRegistrationStateStyle(HomeEventRegistrationState state) =>
    registrationStateStyle(EventRegistrationState.fromJson(state.value));

/// Status tiket (F-09); tiket paid yang sudah dipindai tampil "Sudah Check-in" (check-in atribut, PRD 4.4).
StatusBadgeStyle ticketStatusStyle(TicketStatus status, {DateTime? checkedInAt}) {
  if (status == TicketStatus.paid && checkedInAt != null) return StatusStyles.ticket(TicketBadgeStatus.checkedIn);
  return StatusStyles.ticket(TicketBadgeStatus.fromValue(status.value));
}

/// Status refund manual oleh bendahara (D6).
StatusBadgeStyle refundStatusStyle(TicketRefundStatus status) => switch (status) {
  TicketRefundStatus.pending => _style('Refund Diproses', Icons.hourglass_top, KapdhColors.info, KapdhColors.infoBg),
  TicketRefundStatus.completed => _style(
    'Refund Selesai',
    Icons.check_circle,
    KapdhColors.success,
    KapdhColors.successBg,
  ),
  TicketRefundStatus.cancelled => _style('Refund Dibatalkan', Icons.block, KapdhColors.neutral, KapdhColors.neutralBg),
  TicketRefundStatus.unknown => _style(
    'Status Tidak Dikenal',
    Icons.help_outline,
    KapdhColors.neutral,
    KapdhColors.neutralBg,
  ),
};
