import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/format/formatters.dart';
import '../../../design/design.dart';
import '../payment_presentation.dart';

/// Baris judul di dalam lembar (prototipe layar 2 "Daftar Alumni", layar 3 "Pembayaran"): tombol kembali chevron
/// 44 px dan judul 20 px. Tanpa [onBack] hanya judul (layar pertama setelah OTP tidak punya tujuan kembali).
class SheetTitleRow extends StatelessWidget {
  const SheetTitleRow({super.key, required this.title, this.onBack});

  final String title;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
      child: Row(
        children: [
          if (onBack != null) ...[
            IconButton(
              tooltip: 'Kembali',
              onPressed: onBack,
              icon: const Icon(Icons.chevron_left, size: 26, color: KapdhColors.text),
            ),
            const SizedBox(width: KapdhSpace.s1),
          ],
          Expanded(
            child: Semantics(
              header: true,
              child: Text(
                title,
                style: const TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Pita sapaan hijau (prototipe layar 4, 5): logo, "Assalamu'alaikum," dan nama anggota. Tombol kembali hanya bila
/// layar dibuka dari layar lain (mis. riwayat pembayaran); dari alur pendaftaran tujuan berikutnya "Ke Beranda".
class GreetingBand extends StatelessWidget {
  const GreetingBand({super.key, required this.name, this.onBack});

  final String name;
  final VoidCallback? onBack;

  /// Seberapa jauh lembar menumpuk pita (prototipe: margin-top -16 px).
  static const double overlap = KapdhSpace.s4;

  @override
  Widget build(BuildContext context) {
    return BrandHeader(
      pattern: false,
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5 + overlap),
      child: Row(
        children: [
          if (onBack != null) ...[
            IconButton(
              tooltip: 'Kembali',
              onPressed: onBack,
              icon: const Icon(Icons.arrow_back, color: KapdhColors.textOnDark),
            ),
            const SizedBox(width: KapdhSpace.s1),
          ],
          Image.asset('assets/logo-kapdh.png', width: 44, height: 44, semanticLabel: 'Logo KAPDH'),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  "Assalamu'alaikum,",
                  style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.green100),
                ),
                Text(
                  name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: KapdhFontSize.bodyLg,
                    fontWeight: FontWeight.w600,
                    color: KapdhColors.textOnDark,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Ringkasan pembayaran (prototipe layar 4 "Iuran pendaftaran": nominal, rekening tujuan, waktu kirim; layar 5:
/// nominal, bukti ke-, status).
SummaryCard paymentSummaryCard(PaymentDetail payment, {bool showMethod = true, bool showStage = false}) {
  final submitted = payment.submittedAt;
  final period = payment.period;
  final ticket = payment.ticket;
  return SummaryCard(
    title: paymentTitle(payment),
    rows: [
      SummaryRow('Nominal', formatRupiah(payment.amount), emphasis: true),
      if (ticket != null) SummaryRow('Jadwal event', formatDateTime(ticket.eventStartsAt, zone: ticket.eventTimezone)),
      if (showMethod) SummaryRow('Rekening tujuan', payment.method.provider),
      if (submitted != null && payment.stage == PaymentStage.awaitingReview)
        SummaryRow('Dikirim', formatDateTime(submitted)),
      if (showStage && payment.proofVersion > 0) SummaryRow('Bukti ke-', '${payment.proofVersion}'),
      if (showStage)
        SummaryRow(
          'Status',
          stageText(payment.stage),
          emphasis: true,
          valueColor: payment.stage == PaymentStage.needsFix || payment.stage == PaymentStage.rejectedFinal
              ? KapdhColors.danger
              : null,
        ),
      if (payment.decidedAt != null && payment.stage == PaymentStage.paid)
        SummaryRow('Diverifikasi', formatDateTime(payment.decidedAt!)),
      if (period != null)
        SummaryRow('Masa aktif', '${formatDate(period.startsAt)} - ${formatDate(period.expiresAt)}'),
    ],
  );
}

/// Judul bagian kecil 14 px (prototipe "Rekening tujuan", "Bukti transfer", "Riwayat").
class PaymentSectionTitle extends StatelessWidget {
  const PaymentSectionTitle(this.title, {super.key});

  final String title;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(
      title,
      style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
    ),
  );
}
