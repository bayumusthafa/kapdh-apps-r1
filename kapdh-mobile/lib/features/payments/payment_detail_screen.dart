import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/error_presenter.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/external_links.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import 'payment_presentation.dart';
import 'payment_updates.dart';
import 'payments_repository.dart';
import 'proof_file.dart';
import 'proof_submission.dart';
import 'widgets/adjustment_card.dart';
import 'widgets/payment_layout.dart';
import 'widgets/proof_upload_section.dart';

/// Status dan tindakan satu pembayaran milik sendiri (F-03, F-07; deep link `/payments/{id}`, ARCHITECTURE §4.7).
///
/// Tampilan mengikuti `stage` dari server (klien tidak menurunkan aturan sendiri):
/// - awaiting_transfer: instruksi bayar dan unggah bukti (prototipe layar 3; AC F03-1), rekening tujuan dapat
///   diganti sebelum bukti pertama (PRD 4.3);
/// - awaiting_review: menunggu verifikasi dengan riwayat dan "Ganti bukti" (prototipe layar 4; AC F03-2);
/// - needs_fix: catatan pengurus dan unggah ulang pada payment yang sama (prototipe layar 5; AC F03-3, F04-2);
/// - paid, cancelled, rejected_final: hasil akhir beserta riwayat dan penyesuaian/refund (D6).
///
/// Kirim bukti memakai `expected_proof_version` dan Idempotency-Key tersimpan; bila jaringan putus, status payment
/// diperiksa lebih dahulu sebelum mutasi diulang dan pengguna tidak diminta transfer ulang (PRD 4.3, 4.5;
/// AC F03-4). Instruksi iuran yang disembunyikan untuk platform ini (D13) hanya menampilkan status dan kontak.
class PaymentDetailScreen extends ConsumerStatefulWidget {
  const PaymentDetailScreen({super.key, required this.paymentId});

  /// Parameter rute `paymentId`.
  final String paymentId;

  @override
  ConsumerState<PaymentDetailScreen> createState() => _PaymentDetailScreenState();
}

class _PaymentDetailScreenState extends ConsumerState<PaymentDetailScreen> {
  PaymentDetail? _payment;
  ApiException? _loadError;
  bool _loading = false;
  DateTime? _cardIssuedAt;
  List<PaymentMethod>? _methods;
  String? _changingMethodId;
  bool _cancelling = false;

  // Bukti transfer.
  bool _editingProof = false;
  PickedProof? _proof;
  String? _proofError;
  ProofSubmitPhase _phase = ProofSubmitPhase.idle;
  double? _progress;
  bool _unknownOutcome = false;
  final _note = TextEditingController();
  late final ProofSubmitter _submitter;
  late final AppLifecycleListener _lifecycle;
  StreamSubscription<NotificationCreatedPayload>? _updates;

  PaymentsRepository get _repo => ref.read(paymentsRepositoryProvider);

  bool get _busy => _phase != ProofSubmitPhase.idle || _changingMethodId != null || _cancelling;

  @override
  void initState() {
    super.initState();
    _submitter = ProofSubmitter(ref.read(paymentsRepositoryProvider));
    // Kembali ke aplikasi (mis. setelah transfer di aplikasi bank atau keputusan pengurus): muat status terbaru.
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_load(quiet: true)));
    // Keputusan pengurus tiba sebagai notifikasi realtime: status dimuat ulang tanpa menunggu pengguna menarik layar.
    _updates = ref.read(paymentUpdatesProvider).listen((_) => unawaited(_load(quiet: true)));
    unawaited(_load());
  }

  @override
  void dispose() {
    unawaited(_updates?.cancel());
    _lifecycle.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (_loading || (quiet && _busy)) return;
    _loading = true;
    if (!quiet) setState(() => _loadError = null);
    try {
      final payment = await _repo.getPayment(widget.paymentId);
      if (!mounted) return;
      _apply(payment);
      unawaited(_loadExtras(payment));
    } on ApiException catch (error) {
      if (!mounted) return;
      // Muat ulang diam-diam yang gagal tidak menghapus data yang sedang tampil.
      if (!quiet || _payment == null) setState(() => _loadError = error);
    } finally {
      _loading = false;
    }
  }

  /// Data pelengkap yang tidak menghalangi layar: tanggal KTA dibuat untuk riwayat pendaftaran dan daftar rekening
  /// aktif untuk mengganti tujuan.
  Future<void> _loadExtras(PaymentDetail payment) async {
    if (payment.type == PaymentType.registration && _cardIssuedAt == null) {
      try {
        final membership = await _repo.getMembership();
        if (mounted) setState(() => _cardIssuedAt = membership.cardIssuedAt);
      } on ApiException {
        // Entri "KTA dibuat" hanya pelengkap riwayat.
      }
    }
    if (payment.stage == PaymentStage.awaitingTransfer &&
        payment.actions.canChangeMethod &&
        !payment.instructionsHidden &&
        _methods == null) {
      await _reloadMethods();
    }
  }

  Future<void> _reloadMethods() async {
    try {
      final methods = await _repo.listMethods();
      if (mounted) setState(() => _methods = methods);
    } on ApiException {
      if (mounted) setState(() => _methods = const []);
    }
  }

  void _apply(PaymentDetail payment) {
    setState(() {
      _payment = payment;
      _loadError = null;
      if (!payment.actions.canSubmitProof) _editingProof = false;
    });
    // Iuran yang baru diputus atau dibatalkan: status keanggotaan dan penunjuk iuran di /me ikut diperbarui
    // (perutean PRD 2.2, kartu KTA AC F05-1).
    final me = ref.read(sessionProvider).me;
    final tracked = me?.registrationPayment?.id == payment.id || me?.renewalPayment?.id == payment.id;
    final terminal = payment.stage == PaymentStage.paid || payment.stage == PaymentStage.cancelled;
    if (tracked && terminal) unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
  }

  void _snack(String message) {
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _announce(String message) {
    final view = View.maybeOf(context);
    if (view == null) return;
    unawaited(SemanticsService.sendAnnouncement(view, message, Directionality.of(context)));
  }

  Future<void> _present(ApiException error, {VoidCallback? onRetry}) =>
      ref.read(errorPresenterProvider).present(error, onRetry: onRetry, onReload: () => unawaited(_load()));

  String _fallbackFor(PaymentDetail? payment) {
    if (payment == null || payment.stage != PaymentStage.awaitingTransfer) return AppRoutes.payments;
    return switch (payment.type) {
      PaymentType.registration => AppRoutes.onboardingFees,
      PaymentType.renewal => AppRoutes.renewal,
      PaymentType.ticket when payment.ticket != null => AppRoutes.ticket(payment.ticket!.ticketId),
      _ => AppRoutes.payments,
    };
  }

  void _back() {
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop();
    } else {
      router.go(_fallbackFor(_payment));
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tindakan.

  Future<void> _copyAccount(PaymentMethod method) async {
    await Clipboard.setData(ClipboardData(text: method.accountNumber));
    if (mounted) _snack('Nomor rekening ${method.provider} disalin');
  }

  Future<void> _changeMethod(PaymentMethod method) async {
    final payment = _payment;
    if (payment == null || _busy) return;
    setState(() => _changingMethodId = method.id);
    try {
      final updated = await _repo.changeMethod(payment, method.id);
      if (!mounted) return;
      _apply(updated);
      _snack('Rekening tujuan diganti ke ${method.provider}. Nominal tidak berubah.');
    } on ApiException catch (error) {
      if (!mounted) return;
      final current = currentPaymentOf(error);
      if (current != null) _apply(current);
      if (error.code == ErrorCode.validationError) unawaited(_reloadMethods());
      unawaited(_present(error, onRetry: () => unawaited(_changeMethod(method))));
    } finally {
      if (mounted) setState(() => _changingMethodId = null);
    }
  }

  Future<void> _pickProof() async {
    final source = await showProofSourceSheet(context);
    if (source == null || !mounted) return;
    final result = await ref.read(proofPickerProvider).pick(source);
    if (!mounted) return;
    switch (result) {
      case ProofPickCancelled():
        return;
      case ProofPicked(:final proof):
        setState(() {
          _proof = proof;
          _proofError = null;
          if (_unknownOutcome) {
            // Berkas baru = payload baru; versi bukti yang diharapkan tetap mencegah penggandaan bila pengiriman
            // lama ternyata sudah diterima (server menjawab PROOF_VERSION_CONFLICT dengan status terbaru).
            _submitter.forgetPending();
            _unknownOutcome = false;
          }
        });
      case ProofPickRejected(:final message):
        setState(() => _proofError = message);
    }
  }

  void _onPhase(ProofSubmitPhase phase, double? progress) {
    if (!mounted) return;
    setState(() {
      _phase = phase;
      _progress = progress;
    });
  }

  Future<void> _submitProof() async {
    final payment = _payment;
    if (payment == null || _busy) return;
    if (_unknownOutcome) return _checkStatus();
    final proof = _proof;
    if (proof == null) {
      setState(() => _proofError = 'Pilih bukti transfer terlebih dahulu.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() => _proofError = null);
    final outcome = await _submitter.submit(
      paymentId: payment.id,
      expectedProofVersion: payment.proofVersion,
      proof: proof,
      transferNote: _note.text,
      onPhase: _onPhase,
    );
    await _handleOutcome(outcome);
  }

  Future<void> _checkStatus() async {
    if (!_submitter.hasUnknownOutcome) {
      setState(() => _unknownOutcome = false);
      return;
    }
    final outcome = await _submitter.checkStatus(onPhase: _onPhase);
    await _handleOutcome(outcome);
  }

  Future<void> _handleOutcome(ProofSubmitOutcome outcome) async {
    if (!mounted) return;
    switch (outcome) {
      case ProofSubmitted(:final payment):
        setState(() {
          _unknownOutcome = false;
          _proof = null;
          _proofError = null;
          _note.clear();
          _editingProof = false;
        });
        _apply(payment);
        unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
        // Layar berganti ke "Menunggu Verifikasi" sebagai tanda berhasil. Snackbar tidak dipakai karena akan menutup
        // tombol "Ganti bukti"/"Ke Beranda" di bawah; pembaca layar tetap mendapat pengumuman (N-11).
        _announce('Bukti pembayaran terkirim. Pengurus akan memeriksanya.');
        // Alur pendaftaran: layar menunggu adalah tujuan akhir (prototipe layar 4 "Ke Beranda"), bukan kembali ke
        // Biaya KTA.
        final router = GoRouter.of(context);
        if (payment.type == PaymentType.registration && router.canPop()) router.go(AppRoutes.payment(payment.id));
      case ProofUploadFailed(:final error):
        setState(() => _unknownOutcome = false);
        if (error.code == ErrorCode.fileInvalid) {
          setState(() => _proofError = error.message);
        } else if (error.isNetwork) {
          setState(() => _proofError = 'Unggahan terputus karena koneksi. Periksa koneksi lalu kirim lagi.');
        } else {
          await _present(error, onRetry: () => unawaited(_submitProof()));
        }
      case ProofSubmitRejected(:final error, :final current):
        setState(() => _unknownOutcome = false);
        if (current != null) _apply(current);
        if (error.code == ErrorCode.fileInvalid) {
          setState(() => _proofError = '${error.message} Pilih berkas lagi.');
        } else {
          if (error.code == ErrorCode.forbidden) unawaited(_load(quiet: true));
          await _present(error);
        }
      case ProofSubmitUnknown():
        setState(() => _unknownOutcome = true);
    }
  }

  Future<void> _cancelInstruction() async {
    final payment = _payment;
    if (payment == null || _busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Batalkan instruksi pembayaran?'),
        content: const Text(
          'Instruksi ini tidak berlaku lagi. Jangan transfer ke rekening pada instruksi yang dibatalkan. Anda dapat '
          'membuat instruksi baru kapan saja.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('Kembali')),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: TextButton.styleFrom(foregroundColor: KapdhColors.danger),
            child: const Text('Batalkan instruksi'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _cancelling = true);
    try {
      final updated = await _repo.cancel(_payment ?? payment);
      if (!mounted) return;
      _apply(updated);
      _snack('Instruksi pembayaran dibatalkan.');
    } on ApiException catch (error) {
      if (!mounted) return;
      final current = currentPaymentOf(error);
      if (current != null) _apply(current);
      unawaited(_present(error, onRetry: () => unawaited(_cancelInstruction())));
    } finally {
      if (mounted) setState(() => _cancelling = false);
    }
  }

  Future<Map<String, List<String>>> _submitDestination(
    PaymentAdjustmentSummary adjustment,
    RefundDestinationInput input,
  ) async {
    final payment = _payment;
    if (payment == null) return const {};
    try {
      final updated = await _repo.setRefundDestination(payment.id, adjustment, input);
      if (!mounted) return const {};
      _apply(updated);
      _snack('Rekening tujuan refund terkirim ke bendahara.');
      return const {};
    } on ApiException catch (error) {
      final current = currentPaymentOf(error);
      if (current != null && mounted) _apply(current);
      if (error.code == ErrorCode.validationError && error.fieldErrors.isNotEmpty) return error.fieldErrors;
      return {
        '_': [error.message],
      };
    }
  }

  Future<void> _contactSupport() async {
    final support = ref.read(appGateProvider).support;
    final email = (support?.email.isNotEmpty ?? false) ? support!.email : SupportContactCard.fallbackEmail;
    final opened = await ref.read(externalLinkLauncherProvider)(
      supportEmailUri(email, subject: 'Iuran keanggotaan KAPDH'),
    );
    if (!opened && mounted) _snack('Tidak ada aplikasi email. Hubungi pengurus di $email.');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tampilan.

  @override
  Widget build(BuildContext context) {
    final payment = _payment;
    if (payment == null) {
      final error = _loadError;
      return AppScaffold(
        title: 'Status Pembayaran',
        fallbackLocation: AppRoutes.payments,
        body: error != null
            ? ErrorState.fromException(error, onRetry: () => unawaited(_load()))
            : const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat status pembayaran'),
      );
    }
    final hiddenStage = payment.stage == PaymentStage.awaitingTransfer || payment.stage == PaymentStage.needsFix;
    if (payment.instructionsHidden && hiddenStage) return _hiddenView(payment);
    if (payment.stage == PaymentStage.awaitingTransfer || (_editingProof && payment.actions.canSubmitProof)) {
      return _instructionView(payment);
    }
    return switch (payment.stage) {
      PaymentStage.awaitingReview => _waitingView(payment),
      PaymentStage.needsFix => _needsFixView(payment),
      _ => _outcomeView(payment),
    };
  }

  String? get _busyLabel => switch (_phase) {
    ProofSubmitPhase.uploading =>
      _progress == null ? 'Mengunggah bukti...' : 'Mengunggah ${(_progress! * 100).round()}%',
    ProofSubmitPhase.submitting => 'Mengirim bukti...',
    ProofSubmitPhase.checking => 'Memeriksa status...',
    ProofSubmitPhase.idle => null,
  };

  /// Instruksi bayar dan unggah bukti (prototipe layar 3); juga mode ganti/unggah ulang bukti dari layar 4/5.
  Widget _instructionView(PaymentDetail payment) {
    final replacing = payment.stage != PaymentStage.awaitingTransfer;
    final title = !replacing
        ? 'Pembayaran'
        : (payment.stage == PaymentStage.needsFix ? 'Unggah ulang bukti' : 'Ganti bukti');
    final canSubmit = payment.actions.canSubmitProof && !_busy && (_proof != null || _unknownOutcome);
    final hold = payment.ticket?.holdExpiresAt;
    return PopScope(
      canPop: !replacing && !_busy,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && replacing && !_busy) setState(() => _editingProof = false);
      },
      child: BrandSheetScaffold(
        bottomBar: KapdhButton(
          key: const ValueKey('proof-submit'),
          label: _unknownOutcome ? 'Periksa status pengiriman' : 'Kirim bukti pembayaran',
          busy: _phase != ProofSubmitPhase.idle,
          busyLabel: _busyLabel,
          onPressed: canSubmit ? () => unawaited(_submitProof()) : null,
        ),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s4),
          children: [
            SheetTitleRow(
              title: title,
              onBack: _busy ? null : () => replacing ? setState(() => _editingProof = false) : _back(),
            ),
            if (payment.type == PaymentType.registration && !replacing) ...[
              const SizedBox(height: KapdhSpace.s4),
              const RegisterStepper(current: 3, compact: true),
            ],
            if (payment.type != PaymentType.registration) ...[
              const SizedBox(height: KapdhSpace.s2),
              Text(paymentTitle(payment), style: const TextStyle(fontSize: 13, color: KapdhColors.textMuted)),
            ],
            const SizedBox(height: KapdhSpace.s4),
            AmountCopyBox(amount: payment.amount, onCopied: () => _snack('Nominal disalin')),
            if (hold != null) ...[
              const SizedBox(height: KapdhSpace.s3),
              InfoBox(
                tone: InfoBoxTone.warning,
                icon: Icons.timer_outlined,
                message:
                    'Kirim bukti sebelum ${formatDateTime(hold, zone: payment.ticket!.eventTimezone)}. Setelah itu '
                    'reservasi berakhir dan kursi dilepas.',
              ),
            ],
            const SizedBox(height: KapdhSpace.s4),
            if (replacing) _methodReadOnly(payment) else ..._methodChoices(payment),
            const SizedBox(height: KapdhSpace.s4),
            ProofUploadSection(
              title: replacing ? 'Bukti transfer pengganti' : 'Bukti transfer',
              proof: _proof,
              phase: _phase,
              progress: _progress,
              errorText: _proofError,
              onPick: payment.actions.canSubmitProof ? () => unawaited(_pickProof()) : null,
              noteController: _note,
              unknownOutcome: _unknownOutcome,
              onCheckStatus: () => unawaited(_checkStatus()),
            ),
            if (!payment.actions.canSubmitProof) ...[
              const SizedBox(height: KapdhSpace.s3),
              const InfoBox(
                tone: InfoBoxTone.warning,
                message: 'Bukti tidak dapat dikirim untuk pembayaran ini. Muat ulang untuk melihat status terbaru.',
              ),
            ],
            if (replacing && payment.proofVersion > 0) ...[
              const SizedBox(height: KapdhSpace.s3),
              InfoBox(
                message:
                    'Bukti ke-${payment.proofVersion} akan diganti. Bukti lama tetap tersimpan di riwayat untuk '
                    'pengurus; Anda tidak perlu transfer ulang.',
              ),
            ],
            if (!replacing && payment.actions.canCancel) ...[
              const SizedBox(height: KapdhSpace.s3),
              Center(
                child: KapdhLinkButton(
                  label: _cancelling ? 'Membatalkan...' : 'Batalkan instruksi',
                  onPressed: _busy ? null : () => unawaited(_cancelInstruction()),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// Pilihan rekening tujuan (prototipe layar 3 "Rekening tujuan"): rekening snapshot terpilih dengan tombol Salin;
  /// rekening aktif lain dapat dipilih sebelum bukti pertama (PUT method, PRD 4.3).
  List<Widget> _methodChoices(PaymentDetail payment) {
    final selected = payment.method;
    final others = [
      for (final method in _methods ?? const <PaymentMethod>[])
        if (method.id != selected.id) method,
    ];
    final canChange = payment.actions.canChangeMethod && !_busy;
    final instructions = selected.instructions?.trim();
    return [
      const PaymentSectionTitle('Rekening tujuan'),
      const SizedBox(height: KapdhSpace.s2),
      if (!payment.methodActive) ...[
        const InfoBox(
          tone: InfoBoxTone.warning,
          message: 'Rekening tujuan ini sudah dinonaktifkan pengurus. Pilih rekening lain sebelum transfer.',
        ),
        const SizedBox(height: KapdhSpace.s2),
      ],
      MethodRadioCard(
        key: ValueKey('method-${selected.id}'),
        title: selected.provider,
        selected: true,
        onSelected: null,
        accountNumber: selected.accountNumber,
        accountHolder: selected.accountHolder,
        onCopy: () => unawaited(_copyAccount(selected)),
      ),
      if (instructions != null && instructions.isNotEmpty) ...[
        const SizedBox(height: KapdhSpace.s2),
        InfoBox(message: instructions),
      ],
      for (final method in others) ...[
        const SizedBox(height: KapdhSpace.s2),
        MethodRadioCard(
          key: ValueKey('method-${method.id}'),
          title: method.provider,
          selected: false,
          hint: _changingMethodId == method.id ? 'Mengganti rekening tujuan...' : 'Ketuk untuk melihat nomor tujuan',
          onSelected: canChange ? () => unawaited(_changeMethod(method)) : null,
        ),
      ],
    ];
  }

  Widget _methodReadOnly(PaymentDetail payment) => SummaryCard(
    title: 'Rekening tujuan',
    rows: [
      SummaryRow('Bank', payment.method.provider),
      SummaryRow('Nomor', payment.method.accountNumber),
      SummaryRow('Atas nama', payment.method.accountHolder),
    ],
  );

  Widget _greetingScaffold({required Widget body, required Widget bottomBar}) {
    final name = ref.watch(sessionProvider.select((s) => s.me?.profile.fullName)) ?? '';
    final router = GoRouter.of(context);
    return BrandSheetScaffold(
      header: GreetingBand(name: name, onBack: router.canPop() ? () => router.pop() : null),
      overlap: GreetingBand.overlap,
      bottomBar: bottomBar,
      body: RefreshIndicator(onRefresh: _load, child: body),
    );
  }

  List<Widget> _historySection(PaymentDetail payment) => [
    const SizedBox(height: 18),
    const PaymentSectionTitle('Riwayat'),
    const SizedBox(height: 10),
    Timeline(entries: paymentTimeline(payment, cardIssuedAt: _cardIssuedAt)),
  ];

  List<Widget> _adjustmentsSection(PaymentDetail payment) => [
    for (final adjustment in payment.adjustments) ...[
      const SizedBox(height: KapdhSpace.s4),
      AdjustmentCard(
        key: ValueKey('adjustment-${adjustment.id}-${adjustment.version}'),
        adjustment: adjustment,
        onSubmitDestination: (input) => _submitDestination(adjustment, input),
      ),
    ],
  ];

  /// Menunggu verifikasi pengurus (prototipe layar 4).
  Widget _waitingView(PaymentDetail payment) {
    final ticket = payment.type == PaymentType.ticket;
    return _greetingScaffold(
      bottomBar: Row(
        children: [
          if (payment.actions.canSubmitProof) ...[
            Expanded(
              child: KapdhButton.outlined(
                key: const ValueKey('proof-replace'),
                label: 'Ganti bukti',
                onPressed: () => setState(() => _editingProof = true),
              ),
            ),
            const SizedBox(width: 10),
          ],
          Expanded(
            child: KapdhButton.solid(label: 'Ke Beranda', onPressed: () => context.go(AppRoutes.home)),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s4),
        children: [
          StatusHero(
            status: paymentBadge(payment),
            title: 'Bukti pembayaran sedang diperiksa',
            message: ticket
                ? 'Pengurus akan mencocokkan transfer Anda sebelum check-in dibuka. Kursi Anda tetap ditahan selama '
                      'bukti diperiksa. Kami akan memberi tahu lewat notifikasi dan email.'
                : 'Pengurus akan mencocokkan transfer Anda. Biasanya selesai dalam 1 hari kerja. Kami akan memberi '
                      'tahu lewat notifikasi dan email.',
          ),
          const SizedBox(height: 18),
          paymentSummaryCard(payment),
          ..._adjustmentsSection(payment),
          ..._historySection(payment),
        ],
      ),
    );
  }

  /// Bukti ditolak dan dapat diperbaiki pada payment yang sama (prototipe layar 5; AC F03-3, F04-2).
  Widget _needsFixView(PaymentDetail payment) {
    final decided = payment.decidedAt;
    final reason = payment.rejectionReason?.trim();
    return _greetingScaffold(
      bottomBar: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          KapdhButton(
            key: const ValueKey('proof-reupload'),
            label: 'Unggah ulang bukti',
            onPressed: payment.actions.canSubmitProof ? () => setState(() => _editingProof = true) : null,
          ),
          Center(
            child: KapdhLinkButton(label: 'Hubungi pengurus', onPressed: () => unawaited(_contactSupport())),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s4),
        children: [
          StatusHero(
            status: paymentBadge(payment),
            icon: Icons.error_outline,
            title: 'Bukti pembayaran belum dapat diterima',
            message:
                'Anda tidak perlu transfer ulang bila dana sudah dikirim. Cukup perbaiki bukti sesuai catatan '
                'pengurus.',
          ),
          const SizedBox(height: 18),
          SummaryCard(
            key: const ValueKey('rejection-note'),
            tone: SummaryCardTone.danger,
            title: 'Catatan dari pengurus',
            body: reason == null || reason.isEmpty ? 'Pengurus tidak menuliskan catatan. Hubungi pengurus.' : reason,
            footnote: decided == null ? null : formatDateTime(decided),
          ),
          const SizedBox(height: 18),
          paymentSummaryCard(payment, showMethod: false, showStage: true),
          ..._historySection(payment),
        ],
      ),
    );
  }

  /// Instruksi iuran disembunyikan untuk platform ini (rencana cadangan D13): status, riwayat dan kontak pengurus,
  /// tanpa rekening tujuan maupun unggah bukti.
  Widget _hiddenView(PaymentDetail payment) {
    return AppScaffold(
      title: 'Status Pembayaran',
      fallbackLocation: AppRoutes.payments,
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          children: [
            StatusHero(status: paymentBadge(payment), title: paymentTitle(payment), message: stageText(payment.stage)),
            const SizedBox(height: KapdhSpace.s4),
            const InfoBox(key: ValueKey('dues-hidden'), message: duesHiddenMessage),
            const SizedBox(height: KapdhSpace.s4),
            paymentSummaryCard(payment, showMethod: false, showStage: true),
            const SizedBox(height: KapdhSpace.s4),
            const SupportSection(subject: 'Iuran keanggotaan KAPDH', title: 'Hubungi pengurus'),
            ..._historySection(payment),
          ],
        ),
      ),
    );
  }

  /// Hasil akhir: lunas, dibatalkan, atau ditolak final (tiket).
  Widget _outcomeView(PaymentDetail payment) {
    final membership = isMembershipPayment(payment);
    final ticket = payment.ticket;
    final ticketCancelled = ticket?.ticketStatus == PaymentTicketStatus.cancelled;
    final (String title, String message, IconData? icon) = switch (payment.stage) {
      PaymentStage.paid when payment.type == PaymentType.registration => (
        'Iuran pendaftaran diterima',
        'Dana sudah diverifikasi pengurus dan KTA Anda aktif. Terima kasih telah menyelesaikan iuran keanggotaan.',
        null,
      ),
      PaymentStage.paid when payment.type == PaymentType.renewal => (
        'Perpanjangan KTA berhasil',
        'Dana sudah diverifikasi pengurus dan masa aktif KTA Anda sudah diperpanjang.',
        null,
      ),
      PaymentStage.paid when ticketCancelled => (
        'Pembayaran tiket diterima',
        'Dana sudah diverifikasi, tetapi tiket tidak aktif karena dibatalkan. Pengembalian dana diproses bendahara.',
        null,
      ),
      PaymentStage.paid => ('Pembayaran tiket diterima', 'Dana sudah diverifikasi dan tiket Anda terkonfirmasi.', null),
      PaymentStage.cancelled => (
        'Instruksi pembayaran dibatalkan',
        payment.cancelReason?.trim().isNotEmpty ?? false
            ? 'Alasan: ${payment.cancelReason!.trim()}'
            : 'Instruksi ini tidak berlaku lagi. Jangan transfer ke rekening pada instruksi ini.',
        null,
      ),
      PaymentStage.rejectedFinal => (
        'Bukti pembayaran ditolak',
        'Reservasi tiket dibatalkan dan kursi dilepas. Anda dapat mendaftar ulang bila kuota masih tersedia.',
        Icons.cancel_outlined,
      ),
      _ => ('Status pembayaran', stageText(payment.stage), null),
    };
    final reason = payment.rejectionReason?.trim();
    final membershipType = membershipTypeOf(payment);
    return AppScaffold(
      title: 'Status Pembayaran',
      fallbackLocation: AppRoutes.payments,
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          children: [
            StatusHero(status: paymentBadge(payment), icon: icon, title: title, message: message),
            if (payment.stage == PaymentStage.rejectedFinal && reason != null && reason.isNotEmpty) ...[
              const SizedBox(height: KapdhSpace.s4),
              SummaryCard(tone: SummaryCardTone.danger, title: 'Catatan dari pengurus', body: reason),
            ],
            const SizedBox(height: KapdhSpace.s4),
            paymentSummaryCard(payment, showStage: payment.stage != PaymentStage.paid),
            ..._adjustmentsSection(payment),
            const SizedBox(height: KapdhSpace.s5),
            if (payment.stage == PaymentStage.paid && membership)
              KapdhButton.solid(
                label: 'Lihat KTA',
                icon: Icons.badge_outlined,
                onPressed: () => context.go(AppRoutes.kta),
              ),
            if (payment.stage == PaymentStage.paid && ticket != null && !ticketCancelled)
              KapdhButton.solid(
                label: 'Lihat tiket',
                icon: Icons.confirmation_number_outlined,
                onPressed: () => context.push(AppRoutes.ticket(ticket.ticketId)),
              ),
            if (payment.stage == PaymentStage.cancelled && membershipType != null)
              KapdhButton.solid(
                label: 'Buat instruksi baru',
                onPressed: () => context.push(AppRoutes.newPayment(PaymentType.fromJson(membershipType.value))),
              ),
            if ((payment.stage == PaymentStage.cancelled || payment.stage == PaymentStage.rejectedFinal) &&
                ticket != null)
              KapdhButton.outlined(
                label: 'Lihat event',
                onPressed: () => context.push(AppRoutes.event(ticket.eventId)),
              ),
            ..._historySection(payment),
          ],
        ),
      ),
    );
  }
}
