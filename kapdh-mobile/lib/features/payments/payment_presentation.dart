import 'package:kapdh_api/kapdh_api.dart';

import '../../core/format/formatters.dart';
import '../../design/design.dart';

/// Judul jenis pembayaran (PRD 3.3, D13: iuran keanggotaan organisasi, tanpa istilah "upgrade/premium").
String paymentTitle(Payment payment) => switch (payment.type) {
  PaymentType.registration => 'Iuran pendaftaran',
  PaymentType.renewal => 'Iuran perpanjangan',
  PaymentType.ticket => payment.ticket == null ? 'Pembayaran tiket' : 'Tiket ${payment.ticket!.eventTitle}',
  PaymentType.unknown => 'Pembayaran',
};

/// Iuran keanggotaan (bukan tiket).
bool isMembershipPayment(Payment payment) =>
    payment.type == PaymentType.registration || payment.type == PaymentType.renewal;

/// Jenis iuran untuk rute `/payments/new/:type`; null untuk tiket.
MembershipPaymentType? membershipTypeOf(Payment payment) => switch (payment.type) {
  PaymentType.registration => MembershipPaymentType.registration,
  PaymentType.renewal => MembershipPaymentType.renewal,
  _ => null,
};

/// Badge status pembayaran dari `stage` server (klien tidak menurunkan aturan sendiri, ARCHITECTURE §2 butir 1).
StatusBadgeStyle paymentBadge(Payment payment) => switch (payment.stage) {
  PaymentStage.awaitingReview => StatusStyles.payment(PaymentStatus.pending, proofSubmitted: true),
  PaymentStage.needsFix => StatusStyles.payment(PaymentStatus.rejected),
  PaymentStage.rejectedFinal => StatusStyles.payment(PaymentStatus.rejected, correctable: false),
  PaymentStage.awaitingTransfer => StatusStyles.payment(PaymentStatus.pending),
  PaymentStage.paid => StatusStyles.payment(PaymentStatus.paid),
  PaymentStage.cancelled => StatusStyles.payment(PaymentStatus.cancelled),
  PaymentStage.unknown => StatusStyles.payment(payment.status),
};

/// Label rekening tujuan ringkas, mis. "BSI 7123456789".
String methodSummary(PaymentMethod method) => '${method.provider} ${method.accountNumber}';

/// Jenis metode bayar (D13, ADR-026): transfer bank, e-wallet, atau QRIS statis organisasi. Jenis baru dari server
/// yang belum dikenal aplikasi ini tidak dianggap bank. Detail tiket memakai `PaymentMethodKind.fromJson` dari
/// `TicketPaymentMethodKind`.
String methodKindLabel(PaymentMethodKind kind) => switch (kind) {
  PaymentMethodKind.bank => 'Transfer bank',
  PaymentMethodKind.ewallet => 'E-wallet',
  PaymentMethodKind.qris => 'QRIS',
  PaymentMethodKind.unknown => 'Metode pembayaran',
};

/// Label baris tujuan bayar per jenis: nama penyedia, nomor tujuan dan pemilik. Untuk QRIS `account_number` berisi
/// NMID dan `account_holder` nama merchant (ADR-026 D2).
({String provider, String number, String holder}) methodFieldLabels(PaymentMethodKind kind) => switch (kind) {
  PaymentMethodKind.bank => (provider: 'Bank', number: 'Nomor', holder: 'Atas nama'),
  PaymentMethodKind.ewallet => (provider: 'E-wallet', number: 'Nomor', holder: 'Atas nama'),
  PaymentMethodKind.qris => (provider: 'Metode', number: 'NMID', holder: 'Merchant'),
  PaymentMethodKind.unknown => (provider: 'Metode', number: 'Nomor', holder: 'Atas nama'),
};

/// Tujuan bayar dua baris untuk ringkasan, mis. "BSI 7123456789\na.n. KAPDH Pusat". QRIS tidak punya nomor rekening
/// untuk ditransfer, jadi yang tampil merchant dan NMID-nya (ADR-026).
String methodDestinationText(
  PaymentMethodKind kind, {
  required String provider,
  required String accountNumber,
  required String accountHolder,
}) => kind == PaymentMethodKind.qris
    ? '${methodKindLabel(kind)} $accountHolder\nNMID $accountNumber'
    : '$provider $accountNumber\na.n. $accountHolder';

/// Label teks status untuk ringkasan (prototipe layar 5 "Ditolak, dapat diperbaiki").
String stageText(PaymentStage stage) => switch (stage) {
  PaymentStage.awaitingTransfer => 'Menunggu bukti transfer',
  PaymentStage.awaitingReview => 'Menunggu verifikasi pengurus',
  PaymentStage.needsFix => 'Ditolak, dapat diperbaiki',
  PaymentStage.rejectedFinal => 'Ditolak',
  PaymentStage.paid => 'Lunas',
  PaymentStage.cancelled => 'Dibatalkan',
  PaymentStage.unknown => 'Status tidak dikenal',
};

String _eventTitle(PaymentEventKind kind, {required bool membership}) => switch (kind) {
  PaymentEventKind.created => membership ? 'Instruksi iuran dibuat' : 'Instruksi pembayaran dibuat',
  PaymentEventKind.methodChanged => 'Rekening tujuan diganti',
  PaymentEventKind.proofSubmitted => 'Bukti transfer dikirim',
  PaymentEventKind.proofReplaced => 'Bukti transfer diganti',
  PaymentEventKind.approved => 'Dana diverifikasi pengurus',
  PaymentEventKind.rejected => 'Bukti belum dapat diterima',
  PaymentEventKind.cancelled => 'Instruksi dibatalkan',
  PaymentEventKind.adjusted => 'Penyesuaian dana dicatat',
  PaymentEventKind.unknown => 'Perubahan status',
};

String _actorSuffix(PaymentEventActor actor, PaymentEventKind kind) => switch ((actor, kind)) {
  (PaymentEventActor.admin, PaymentEventKind.proofSubmitted || PaymentEventKind.proofReplaced) => ' oleh pengurus',
  (PaymentEventActor.admin, PaymentEventKind.cancelled) => ' oleh pengurus',
  (PaymentEventActor.system, PaymentEventKind.cancelled) => ' otomatis',
  _ => '',
};

/// Entri sedang berlangsung di puncak riwayat sesuai tahap (prototipe layar 4 "Menunggu verifikasi pengurus").
TimelineEntry? _currentEntry(PaymentStage stage) => switch (stage) {
  PaymentStage.awaitingTransfer => const TimelineEntry(
    title: 'Menunggu bukti transfer',
    subtitle: 'Sedang berlangsung',
    state: TimelineState.current,
  ),
  PaymentStage.awaitingReview => const TimelineEntry(
    title: 'Menunggu verifikasi pengurus',
    subtitle: 'Sedang berlangsung',
    state: TimelineState.current,
  ),
  PaymentStage.needsFix => const TimelineEntry(
    title: 'Menunggu perbaikan bukti',
    subtitle: 'Sedang berlangsung',
    state: TimelineState.current,
  ),
  _ => null,
};

/// Riwayat terbaru di atas (prototipe layar 4 "Riwayat"; PaymentDetail.events urut terlama dahulu). Alasan
/// penolakan lama tetap tampil di histori (AC F03-3). [cardIssuedAt] menambah entri "Email terverifikasi, KTA dibuat"
/// untuk iuran pendaftaran (GET /me/membership `card_issued_at`, AC F05-1).
List<TimelineEntry> paymentTimeline(PaymentDetail payment, {DateTime? cardIssuedAt}) {
  final membership = isMembershipPayment(payment);
  final entries = <TimelineEntry>[?_currentEntry(payment.stage)];
  final events = [...payment.events]..sort((a, b) => b.at.compareTo(a.at));
  for (final event in events) {
    final reason = event.reason?.trim();
    final showReason =
        reason != null &&
        reason.isNotEmpty &&
        (event.kind == PaymentEventKind.rejected || event.kind == PaymentEventKind.cancelled);
    final version = event.proofVersion;
    final versionSuffix =
        version != null &&
            version > 0 &&
            (event.kind == PaymentEventKind.proofSubmitted || event.kind == PaymentEventKind.proofReplaced)
        ? ' (bukti ke-$version)'
        : '';
    entries.add(
      TimelineEntry(
        title:
            '${_eventTitle(event.kind, membership: membership)}${_actorSuffix(event.actor, event.kind)}$versionSuffix',
        subtitle: showReason ? '${formatDateTime(event.at)}\nAlasan: $reason' : formatDateTime(event.at),
        state: switch (event.kind) {
          PaymentEventKind.rejected || PaymentEventKind.cancelled => TimelineState.failed,
          _ => TimelineState.done,
        },
      ),
    );
  }
  if (payment.type == PaymentType.registration && cardIssuedAt != null) {
    entries.add(TimelineEntry(title: 'Email terverifikasi, KTA dibuat', subtitle: formatDateTime(cardIssuedAt)));
  }
  return entries;
}

/// Teks kelayakan kutipan iuran yang tidak dapat dibayar (FeeQuoteIneligibleReason, AC F07-5).
String ineligibleMessage(FeeQuote quote) => switch (quote.ineligibleReason) {
  FeeQuoteIneligibleReason.alreadyRegistered => 'Iuran pendaftaran Anda sudah lunas. KTA dapat dilihat di menu KTA.',
  FeeQuoteIneligibleReason.registrationRequired =>
    'Perpanjangan tersedia setelah iuran pendaftaran diverifikasi pengurus.',
  FeeQuoteIneligibleReason.renewalWindowNotOpen =>
    quote.renewalOpensAt == null
        ? 'Perpanjangan belum dibuka. Jendela perpanjangan dibuka 30 hari sebelum masa aktif berakhir.'
        : 'Perpanjangan dibuka mulai ${formatDate(quote.renewalOpensAt!)}, 30 hari sebelum masa aktif berakhir.',
  _ => 'Iuran ini belum dapat dibayar untuk status akun Anda.',
};

/// Teks kontak pengurus saat instruksi iuran disembunyikan di platform ini (rencana cadangan D13, PRD 10.1).
const String duesHiddenMessage =
    'Iuran keanggotaan untuk aplikasi di perangkat ini diselesaikan melalui pengurus. Hubungi pengurus untuk '
    'menyelesaikan iuran; status KTA diperbarui setelah pengurus memverifikasi pembayaran Anda.';
