import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../app/theme/kapdh_tokens.dart';
import 'kapdh_icons.dart';

/// Gaya badge status: label + ikon + warna. Status tidak pernah dibedakan dengan warna saja (PRD 4.5, N-11).
@immutable
class StatusBadgeStyle {
  const StatusBadgeStyle({required this.label, required this.icon, required this.foreground, required this.background});

  /// Dari token design-tokens (`KapdhMembershipStatus.*`); nama ikon token dipetakan ke ikon Material.
  factory StatusBadgeStyle.fromToken(KapdhStatusStyle token, {String? label}) => StatusBadgeStyle(
    label: label ?? token.label,
    icon: _iconFor(token.icon),
    foreground: token.fg,
    background: token.bg,
  );

  final String label;
  final IconData icon;
  final Color foreground;
  final Color background;

  static IconData _iconFor(String name) => switch (name) {
    'check_circle' => KapdhIcons.checkCircle,
    'schedule' => KapdhIcons.schedule,
    'cancel' => KapdhIcons.cancel,
    'hourglass_top' => KapdhIcons.hourglassTop,
    'block' => KapdhIcons.block,
    _ => KapdhIcons.infoOutline,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is StatusBadgeStyle &&
          other.label == label &&
          other.icon == icon &&
          other.foreground == foreground &&
          other.background == background;

  @override
  int get hashCode => Object.hash(label, icon, foreground, background);
}

/// Status tiket (ARCHITECTURE §3.4). Didefinisikan di sini sampai kontrak events (C5) menghasilkan enum SDK;
/// [fromValue] membaca nilai JSON kontrak.
enum TicketBadgeStatus {
  awaitingPayment('awaiting_payment'),
  awaitingReview('awaiting_review'),
  paid('paid'),
  checkedIn('checked_in'),
  expired('expired'),
  cancelled('cancelled'),
  unknown('');

  const TicketBadgeStatus(this.value);

  final String value;

  static TicketBadgeStatus fromValue(String value) =>
      values.firstWhere((s) => s != unknown && s.value == value, orElse: () => unknown);
}

/// Status event (ARCHITECTURE §3.4); lihat [TicketBadgeStatus].
enum EventBadgeStatus {
  draft('draft'),
  open('open'),
  closed('closed'),
  done('done'),
  cancelled('cancelled'),
  unknown('');

  const EventBadgeStatus(this.value);

  final String value;

  static EventBadgeStatus fromValue(String value) =>
      values.firstWhere((s) => s != unknown && s.value == value, orElse: () => unknown);
}

/// Pemetaan setiap keluarga status ke gaya badge (satu sumber untuk seluruh layar).
abstract final class StatusStyles {
  static const _success = (fg: KapdhColors.success, bg: KapdhColors.successBg);
  static const _warning = (fg: KapdhColors.warning, bg: KapdhColors.warningBg);
  static const _danger = (fg: KapdhColors.danger, bg: KapdhColors.dangerBg);
  static const _info = (fg: KapdhColors.info, bg: KapdhColors.infoBg);
  static const _neutral = (fg: KapdhColors.neutral, bg: KapdhColors.neutralBg);

  static StatusBadgeStyle _make(String label, IconData icon, ({Color fg, Color bg}) tone) =>
      StatusBadgeStyle(label: label, icon: icon, foreground: tone.fg, background: tone.bg);

  /// effective_status dari GET /me (PRD 2.2). Label dari katalog terbangkit `membershipLabel`.
  static StatusBadgeStyle membership(EffectiveStatus status) {
    final label = membershipLabel(status);
    return switch (status) {
      EffectiveStatus.verified => StatusBadgeStyle.fromToken(KapdhMembershipStatus.verified, label: label),
      EffectiveStatus.expiring => StatusBadgeStyle.fromToken(KapdhMembershipStatus.expiring, label: label),
      EffectiveStatus.expired => StatusBadgeStyle.fromToken(KapdhMembershipStatus.expired, label: label),
      EffectiveStatus.unverified => StatusBadgeStyle.fromToken(KapdhMembershipStatus.unverified, label: label),
      EffectiveStatus.suspended => StatusBadgeStyle.fromToken(KapdhMembershipStatus.suspended, label: label),
      EffectiveStatus.pendingOtp => _make(label, KapdhIcons.markEmailUnreadOutlined, _info),
      EffectiveStatus.disabled => _make(label, KapdhIcons.personOffOutlined, _neutral),
      EffectiveStatus.deletionPending => _make(label, KapdhIcons.deleteOutline, _neutral),
      EffectiveStatus.unknown => _make(label, KapdhIcons.helpOutline, _neutral),
    };
  }

  /// `status_label` kartu KTA (GET /me/card, F-05).
  static StatusBadgeStyle card(MemberCardStatus status) => switch (status) {
    MemberCardStatus.active => StatusBadgeStyle.fromToken(KapdhMembershipStatus.verified),
    MemberCardStatus.expiring => StatusBadgeStyle.fromToken(KapdhMembershipStatus.expiring),
    MemberCardStatus.inactive => StatusBadgeStyle.fromToken(KapdhMembershipStatus.unverified),
    MemberCardStatus.expired => StatusBadgeStyle.fromToken(KapdhMembershipStatus.expired),
    MemberCardStatus.suspended => StatusBadgeStyle.fromToken(KapdhMembershipStatus.suspended),
    MemberCardStatus.unknown => _make('Status Tidak Dikenal', KapdhIcons.helpOutline, _neutral),
  };

  /// Pembayaran (PRD 3.3, 4.3). [proofSubmitted]: bukti sudah dikirim dan menunggu pengurus. [correctable]: penolakan
  /// iuran dapat diperbaiki dengan bukti baru; penolakan tiket final.
  static StatusBadgeStyle payment(PaymentStatus status, {bool proofSubmitted = false, bool correctable = true}) =>
      switch (status) {
        PaymentStatus.pending when proofSubmitted => StatusBadgeStyle.fromToken(KapdhMembershipStatus.pendingReview),
        PaymentStatus.pending => _make('Menunggu Pembayaran', KapdhIcons.schedule, _warning),
        PaymentStatus.paid => _make('Lunas', KapdhIcons.checkCircle, _success),
        PaymentStatus.rejected when correctable => _make('Perlu Perbaikan', KapdhIcons.errorOutline, _danger),
        PaymentStatus.rejected => _make('Ditolak', KapdhIcons.cancel, _danger),
        PaymentStatus.cancelled => _make('Dibatalkan', KapdhIcons.block, _neutral),
        PaymentStatus.unknown => _make('Status Tidak Dikenal', KapdhIcons.helpOutline, _neutral),
      };

  /// Tiket event (F-09).
  static StatusBadgeStyle ticket(TicketBadgeStatus status) => switch (status) {
    TicketBadgeStatus.awaitingPayment => _make('Menunggu Pembayaran', KapdhIcons.schedule, _warning),
    TicketBadgeStatus.awaitingReview => StatusBadgeStyle.fromToken(KapdhMembershipStatus.pendingReview),
    TicketBadgeStatus.paid => _make('Terkonfirmasi', KapdhIcons.confirmationNumberOutlined, _success),
    TicketBadgeStatus.checkedIn => _make('Sudah Check-in', KapdhIcons.howToReg, _success),
    TicketBadgeStatus.expired => _make('Kedaluwarsa', KapdhIcons.timerOffOutlined, _neutral),
    TicketBadgeStatus.cancelled => _make('Dibatalkan', KapdhIcons.block, _neutral),
    TicketBadgeStatus.unknown => _make('Status Tidak Dikenal', KapdhIcons.helpOutline, _neutral),
  };

  /// Event (F-09; guideline hal. 8 "Pendaftaran di Buka/Tutup").
  static StatusBadgeStyle event(EventBadgeStatus status) => switch (status) {
    EventBadgeStatus.draft => _make('Draf', KapdhIcons.editNote, _neutral),
    EventBadgeStatus.open => _make('Pendaftaran Dibuka', KapdhIcons.eventAvailable, _success),
    EventBadgeStatus.closed => _make('Pendaftaran Ditutup', KapdhIcons.eventBusy, _danger),
    EventBadgeStatus.done => _make('Selesai', KapdhIcons.eventNote, _neutral),
    EventBadgeStatus.cancelled => _make('Dibatalkan', KapdhIcons.cancel, _danger),
    EventBadgeStatus.unknown => _make('Status Tidak Dikenal', KapdhIcons.helpOutline, _neutral),
  };

  /// Penghapusan akun (F-14).
  static StatusBadgeStyle deletion(AccountDeletionStatus status) => switch (status) {
    AccountDeletionStatus.pending => _make('Permintaan Diterima', KapdhIcons.inboxOutlined, _info),
    AccountDeletionStatus.processing => _make('Sedang Diproses', KapdhIcons.hourglassTop, _warning),
    // Langkah terakhir gagal dan dicoba ulang otomatis tanpa mengulang langkah selesai (AC F14-2, kontrak account).
    AccountDeletionStatus.failed => _make('Sedang Diproses Ulang', KapdhIcons.autorenew, _warning),
    AccountDeletionStatus.completed => _make('Selesai', KapdhIcons.checkCircle, _neutral),
    AccountDeletionStatus.unknown => _make('Status Tidak Dikenal', KapdhIcons.helpOutline, _neutral),
  };

  /// Data dari cache saat tanpa koneksi (AC F05-2, prototipe layar 7).
  static final StatusBadgeStyle offline = _make('Offline', KapdhIcons.cloudOff, _warning);
}

/// Badge status berbentuk pil: ikon + label (prototipe layar 2, 4, 5, 6, 7).
class StatusBadge extends StatelessWidget {
  const StatusBadge(this.style, {super.key});

  final StatusBadgeStyle style;

  @override
  Widget build(BuildContext context) {
    // Ikon sebagai WidgetSpan: label membungkus wajar saat teks diperbesar 200 % tanpa bergantung lebar induk.
    return Semantics(
      container: true,
      label: 'Status: ${style.label}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: KapdhSpace.s1),
        decoration: BoxDecoration(color: style.background, borderRadius: BorderRadius.circular(KapdhRadius.pill)),
        child: Text.rich(
          TextSpan(
            children: [
              WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Icon(style.icon, size: 14, color: style.foreground),
                ),
              ),
              TextSpan(text: style.label),
            ],
          ),
          style: TextStyle(color: style.foreground, fontWeight: FontWeight.w600, fontSize: KapdhFontSize.caption),
        ),
      ),
    );
  }
}
