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
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import 'payment_presentation.dart';
import 'payments_repository.dart';
import 'widgets/payment_layout.dart';

/// Perpanjang KTA (F-07; PRD 3.7, 4.2; AC F07-1, F07-2, F07-5): masa keanggotaan dan jendela perpanjangan dari
/// GET /me/membership, iuran perpanjangan dari GET /me/fees, lalu alur pembayaran yang sama dengan pendaftaran
/// (`/payments/new/renewal` → instruksi bayar → bukti). Rute awal anggota expired (routeForStatus).
///
/// Tombol perpanjang hanya aktif bila server menyatakan layak (jendela dibuka 30 hari sebelum habis dan tetap
/// terbuka setelah expired); klien tidak menghitung kelayakan maupun tanggal periode baru (PRD 2.1).
class RenewalScreen extends ConsumerStatefulWidget {
  const RenewalScreen({super.key});

  @override
  ConsumerState<RenewalScreen> createState() => _RenewalScreenState();
}

class _RenewalScreenState extends ConsumerState<RenewalScreen> {
  Membership? _membership;
  MyFeeQuotes? _fees;
  ApiException? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// [quiet] = muat ulang latar (status iuran berubah di layar lain): kegagalannya tidak ditampilkan selama data lama
  /// masih ada. Muat ulang yang diminta pengguna yang gagal ditampilkan di atas data lama (PRD 4.5).
  Future<void> _load({bool quiet = false}) async {
    if (_loading) return;
    _loading = true;
    if (!quiet) setState(() => _error = null);
    final repo = ref.read(paymentsRepositoryProvider);
    try {
      final membership = await repo.getMembership();
      final fees = await repo.getFees();
      if (!mounted) return;
      setState(() {
        _membership = membership;
        _fees = fees;
        _error = null;
      });
    } on ApiException catch (error) {
      final hasData = _membership != null && _fees != null;
      if (mounted && (!quiet || !hasData)) setState(() => _error = error);
    } finally {
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    // Iuran perpanjangan berubah di layar lain (bukti terkirim, dibatalkan, diputus pengurus): muat ulang masa
    // keanggotaan dan kutipan agar tombol dan keterangan tidak usang saat pengguna kembali ke layar ini.
    ref.listen(
      sessionProvider.select((s) {
        final payment = s.me?.renewalPayment;
        return (payment?.id, payment?.stage, payment?.proofVersion, s.me?.expiresAt, s.effectiveStatus);
      }),
      (previous, next) {
        if (previous != next) unawaited(_load(quiet: true));
      },
    );
    final membership = _membership;
    final fees = _fees;
    final error = _error;
    return AppScaffold(
      title: 'Perpanjang KTA',
      fallbackLocation: AppRoutes.kta,
      body: membership == null || fees == null
          ? (error != null
                ? ErrorState.fromException(error, onRetry: () => unawaited(_load()))
                : const LoadingSkeleton(semanticsLabel: 'Memuat masa keanggotaan'))
          : RefreshIndicator(
              onRefresh: _load,
              child: _content(membership, fees, refreshError: error),
            ),
    );
  }

  Widget _content(Membership membership, MyFeeQuotes fees, {ApiException? refreshError}) {
    final me = ref.watch(sessionProvider.select((s) => s.me));
    final quote = fees.renewal;
    final open = membership.renewalPayment;
    final openId = open?.id ?? quote.openPaymentId;
    final hidden = fees.instructionsHidden;
    final starts = membership.startsAt;
    final expires = membership.expiresAt;
    final opens = membership.renewalOpensAt;

    Widget? cta;
    if (openId != null && !hidden) {
      cta = KapdhButton(
        key: const ValueKey('renewal-continue'),
        label: 'Lanjutkan pembayaran',
        onPressed: () => context.push(AppRoutes.payment(openId)),
      );
    } else if (!hidden && quote.eligible) {
      cta = KapdhButton(
        key: const ValueKey('renewal-pay'),
        label: 'Lanjut ke pembayaran',
        onPressed: () => context.push(AppRoutes.newPayment(PaymentType.renewal)),
      );
    } else if (!hidden && quote.ineligibleReason == FeeQuoteIneligibleReason.registrationRequired) {
      cta = KapdhButton(label: 'Bayar iuran pendaftaran', onPressed: () => context.go(AppRoutes.onboardingFees));
    } else if (!hidden) {
      cta = const KapdhButton(key: ValueKey('renewal-pay'), label: 'Perpanjang', onPressed: null);
    }

    return ListView(
      padding: const EdgeInsets.all(KapdhSpace.s5),
      children: [
        if (refreshError != null) ...[
          RefreshFailedNotice(
            error: refreshError,
            title: 'Data perpanjangan terbaru belum dapat dimuat',
            onRetry: () => unawaited(_load()),
          ),
          const SizedBox(height: KapdhSpace.s4),
        ],
        if (me != null)
          KtaMiniCard(
            fullName: me.profile.fullName,
            subtitle: 'Angkatan ${me.profile.cohort} | Lulus ${me.profile.graduationYear}',
            memberNumber: membership.memberNumber ?? me.memberNumber ?? '-',
            status: StatusStyles.membership(membership.effectiveStatus),
          ),
        const SizedBox(height: KapdhSpace.s4),
        SummaryCard(
          key: const ValueKey('renewal-period'),
          title: 'Masa keanggotaan',
          rows: [
            if (starts != null) SummaryRow('Mulai', formatDate(starts)),
            SummaryRow(
              membership.effectiveStatus == EffectiveStatus.expired ? 'Berakhir' : 'Berlaku sampai',
              expires == null ? 'Belum aktif' : formatDate(expires),
              emphasis: true,
              valueColor: membership.effectiveStatus == EffectiveStatus.expired ? context.kc.danger : null,
            ),
            if (opens != null)
              SummaryRow(
                'Jendela perpanjangan',
                membership.renewalEligible ? 'Dibuka sejak ${formatDate(opens)}' : 'Dibuka mulai ${formatDate(opens)}',
              ),
          ],
        ),
        const SizedBox(height: KapdhSpace.s4),
        SummaryCard(
          key: const ValueKey('renewal-fee'),
          title: 'Iuran perpanjangan',
          labelMuted: false,
          rows: [for (final line in quote.lines) SummaryRow(line.label, formatRupiah(line.amount))],
          total: SummaryRow('Total', formatRupiah(quote.total)),
          footnote:
              'Masa baru ${fees.periodMonths} bulan. Bila KTA belum kedaluwarsa, masa baru dimulai dari tanggal berakhir '
              'saat ini sehingga sisa masa aktif tidak hilang; bila sudah kedaluwarsa, dihitung sejak iuran '
              'diverifikasi pengurus.',
        ),
        if (open != null) ...[const SizedBox(height: KapdhSpace.s4), _OpenRenewalInfo(payment: open)],
        if (hidden) ...[
          const SizedBox(height: KapdhSpace.s4),
          const InfoBox(key: ValueKey('dues-hidden'), title: 'Iuran melalui pengurus', message: duesHiddenMessage),
          const SizedBox(height: KapdhSpace.s4),
          const SupportSection(subject: 'Iuran keanggotaan KAPDH', title: 'Hubungi pengurus'),
        ] else if (!quote.eligible && openId == null) ...[
          const SizedBox(height: KapdhSpace.s4),
          InfoBox(
            key: const ValueKey('renewal-ineligible'),
            tone: InfoBoxTone.warning,
            message: ineligibleMessage(quote),
          ),
        ],
        if (cta != null) ...[const SizedBox(height: KapdhSpace.s5), cta],
        if (membership.periods.isNotEmpty) ...[
          const SizedBox(height: KapdhSpace.s6),
          Semantics(
            header: true,
            child: const Text(
              'Riwayat periode',
              style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(height: 10),
          Timeline(
            entries: [
              for (final period in membership.periods)
                TimelineEntry(
                  title: period.kind == MembershipPeriodKind.activation ? 'Aktivasi KTA' : 'Perpanjangan KTA',
                  subtitle:
                      '${formatDate(period.startsAt)} - ${formatDate(period.expiresAt)}\n'
                      'Diverifikasi ${formatDateTime(period.approvedAt)}',
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// Iuran perpanjangan yang sedang berjalan (MeMembershipPayment, kontrak C2).
class _OpenRenewalInfo extends StatelessWidget {
  const _OpenRenewalInfo({required this.payment});

  final MeMembershipPayment payment;

  @override
  Widget build(BuildContext context) {
    final reason = payment.rejectionReason?.trim();
    final (InfoBoxTone tone, String message) = switch (payment.stage) {
      MeMembershipPaymentStage.awaitingProof => (
        InfoBoxTone.info,
        'Instruksi perpanjangan sebesar ${formatRupiah(payment.amount)} sudah dibuat. Lanjutkan transfer lalu unggah '
            'bukti.',
      ),
      MeMembershipPaymentStage.awaitingReview => (
        InfoBoxTone.info,
        'Bukti perpanjangan sedang diperiksa pengurus. Kami akan memberi tahu lewat notifikasi dan email.',
      ),
      MeMembershipPaymentStage.rejected => (
        InfoBoxTone.danger,
        reason == null || reason.isEmpty
            ? 'Bukti perpanjangan perlu diperbaiki. Anda tidak perlu transfer ulang.'
            : 'Bukti perpanjangan perlu diperbaiki: $reason. Anda tidak perlu transfer ulang.',
      ),
      MeMembershipPaymentStage.unknown => (InfoBoxTone.info, 'Iuran perpanjangan sedang diproses.'),
    };
    return InfoBox(
      key: const ValueKey('renewal-open'),
      tone: tone,
      title: 'Iuran perpanjangan berjalan',
      message: message,
    );
  }
}
