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
import '../payments/payment_presentation.dart';
import '../payments/payments_repository.dart';
import '../payments/widgets/payment_layout.dart';

/// Langkah 3 pendaftaran "Biaya KTA" (prototipe layar 2; F-03, PRD 4.1, AC F01-2, F03-1, F05-1): KTA ringkas
/// berstatus Tidak Aktif dengan nomor anggota yang sudah dialokasikan, rincian iuran pendaftaran dari server
/// (register alumni baru + pembuatan KTA, D4) dan ajakan ke pembayaran. Nilai iuran tidak dihitung klien (PRD 3.3).
///
/// Perutean onboarding (kontrak C2 GET /me `registration_payment`): bukti yang sedang diperiksa atau ditolak langsung
/// membuka layar status pembayaran; instruksi yang belum berbukti dilanjutkan lewat tombol. Langkah profil minimum
/// tidak terpisah: data diri pendaftaran (F-01) sudah memenuhi isi KTA, sedangkan kota domisili dilengkapi dari
/// layar KTA/profil.
class OnboardingFeesScreen extends ConsumerStatefulWidget {
  const OnboardingFeesScreen({super.key});

  @override
  ConsumerState<OnboardingFeesScreen> createState() => _OnboardingFeesScreenState();
}

class _OnboardingFeesScreenState extends ConsumerState<OnboardingFeesScreen> {
  MyFeeQuotes? _fees;
  ApiException? _error;
  bool _forwarded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _maybeForward(ref.read(sessionProvider).me?.registrationPayment),
    );
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final fees = await ref.read(paymentsRepositoryProvider).getFees();
      if (mounted) setState(() => _fees = fees);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  /// Bukti sudah dikirim (menunggu atau ditolak): tujuan pendaftaran berikutnya adalah layar status pembayaran
  /// (prototipe layar 4, 5).
  void _maybeForward(MeMembershipPayment? payment) {
    if (!mounted || _forwarded || payment == null) return;
    if (payment.stage == MeMembershipPaymentStage.awaitingReview ||
        payment.stage == MeMembershipPaymentStage.rejected) {
      _forwarded = true;
      context.go(AppRoutes.payment(payment.id));
    }
  }

  void _continue(FeeQuote quote) {
    final open = quote.openPaymentId;
    context.push(open != null ? AppRoutes.payment(open) : AppRoutes.newPayment(PaymentType.registration));
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(sessionProvider.select((s) => s.me?.registrationPayment), (_, next) => _maybeForward(next));
    final me = ref.watch(sessionProvider.select((s) => s.me));
    final router = GoRouter.of(context);
    final header = <Widget>[
      SheetTitleRow(title: 'Daftar Alumni', onBack: router.canPop() ? () => router.pop() : null),
      const SizedBox(height: 18),
      const RegisterStepper(current: 2),
    ];
    const padding = EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s4);

    final fees = _fees;
    final error = _error;
    if (fees == null && error != null) {
      return BrandSheetScaffold(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SheetStatusBanner(),
            Padding(
              padding: padding,
              child: Column(children: header),
            ),
            Expanded(child: ErrorState.fromException(error, onRetry: () => unawaited(_load()))),
          ],
        ),
      );
    }

    final quote = fees?.registration;
    final hidden = fees?.instructionsHidden ?? false;
    final canPay = quote != null && !hidden && (quote.eligible || quote.openPaymentId != null);
    return BrandSheetScaffold(
      bottomBar: canPay
          ? KapdhButton(
              key: const ValueKey('fees-continue'),
              label: quote.openPaymentId != null ? 'Lanjutkan pembayaran' : 'Lanjut ke pembayaran',
              onPressed: () => _continue(quote),
            )
          : null,
      body: withSheetBanner(
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: padding,
            children: [
              ...header,
              if (fees != null && error != null) ...[
                // Tarik ke bawah gagal: rincian lama tetap tampil dengan pemberitahuan (PRD 4.5).
                const SizedBox(height: KapdhSpace.s4),
                RefreshFailedNotice(
                  error: error,
                  title: 'Rincian iuran terbaru belum dapat dimuat',
                  onRetry: () => unawaited(_load()),
                ),
              ],
              const SizedBox(height: 18),
              Semantics(
                header: true,
                child: const Text(
                  'KTA Anda sudah dibuat',
                  style: TextStyle(fontSize: KapdhFontSize.h2, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                'KTA akan aktif setelah iuran pendaftaran diverifikasi pengurus.',
                style: TextStyle(fontSize: 13, height: 1.5, color: context.kc.textMuted),
              ),
              if (me != null) ...[
                const SizedBox(height: 18),
                KtaMiniCard(
                  fullName: me.profile.fullName,
                  subtitle: 'Angkatan ${me.profile.cohort} | Lulus ${me.profile.graduationYear}',
                  memberNumber: me.memberNumber ?? '-',
                  status: StatusStyles.card(MemberCardStatus.inactive),
                ),
              ],
              const SizedBox(height: 18),
              if (fees == null || quote == null)
                const LoadingSkeleton(showCard: false, lines: 4, semanticsLabel: 'Memuat rincian iuran')
              else ...[
                SummaryCard(
                  key: const ValueKey('fees-summary'),
                  title: 'Rincian iuran pendaftaran',
                  labelMuted: false,
                  rows: [for (final line in quote.lines) SummaryRow(line.label, formatRupiah(line.amount))],
                  total: SummaryRow('Total', formatRupiah(quote.total)),
                  footnote:
                      'Masa aktif ${fees.periodMonths} bulan sejak iuran diverifikasi. Perpanjangan berikutnya '
                      '${formatRupiah(fees.renewal.total)} per tahun.',
                ),
                if (hidden) ...[
                  const SizedBox(height: KapdhSpace.s4),
                  const InfoBox(
                    key: ValueKey('dues-hidden'),
                    title: 'Iuran melalui pengurus',
                    message: duesHiddenMessage,
                  ),
                  const SizedBox(height: KapdhSpace.s4),
                  const SupportSection(subject: 'Iuran keanggotaan KAPDH', title: 'Hubungi pengurus'),
                ] else if (!quote.eligible && quote.openPaymentId == null) ...[
                  const SizedBox(height: KapdhSpace.s4),
                  InfoBox(tone: InfoBoxTone.warning, message: ineligibleMessage(quote)),
                  const SizedBox(height: KapdhSpace.s3),
                  KapdhButton.outlined(label: 'Lihat KTA', onPressed: () => context.go(AppRoutes.kta)),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}
