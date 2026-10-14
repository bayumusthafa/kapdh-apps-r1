import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import 'payment_presentation.dart';
import 'payments_repository.dart';
import 'proof_submission.dart';

enum _Step { loading, creating, checking, unknown, failed, blocked }

/// Penyebab instruksi iuran tidak dapat dibuat dari aplikasi.
enum _Block { hidden, ineligible, noMethods, unknownType }

/// Membuat instruksi iuran pendaftaran atau perpanjangan lalu membuka layar instruksi bayar (F-03, F-07;
/// AC F03-1, F07-5). Rute ini hanya mutasi (ARCHITECTURE §8.4, `isMutationOnlyRoute`).
///
/// Urutan: kutipan GET /me/fees (payment terbuka, kelayakan, D13) → rekening aktif → POST /me/payments dengan
/// rekening pertama dan Idempotency-Key tersimpan. Nominal dihitung dan disnapshot server; rekening dapat diganti di
/// layar instruksi sebelum bukti pertama. Bila jaringan putus saat membuat instruksi, layar menampilkan "Memeriksa
/// status": payment terbuka dicari lebih dahulu sebelum permintaan diulang dengan key yang sama, sehingga tidak
/// pernah ada instruksi ganda (PRD 4.3, 4.5).
class NewPaymentScreen extends ConsumerStatefulWidget {
  const NewPaymentScreen({super.key, required this.type});

  /// Parameter rute `type` (`registration` atau `renewal`).
  final String type;

  @override
  ConsumerState<NewPaymentScreen> createState() => _NewPaymentScreenState();
}

class _NewPaymentScreenState extends ConsumerState<NewPaymentScreen> {
  _Step _step = _Step.loading;
  _Block? _block;
  FeeQuote? _quote;
  ApiException? _error;

  PaymentsRepository get _repo => ref.read(paymentsRepositoryProvider);

  MembershipPaymentType get _type => MembershipPaymentType.fromJson(widget.type);

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  void _set(_Step step, {_Block? block, ApiException? error}) {
    if (!mounted) return;
    setState(() {
      _step = step;
      _block = block;
      _error = error;
    });
  }

  Future<void> _start() async {
    final type = _type;
    if (type == MembershipPaymentType.unknown) return _set(_Step.blocked, block: _Block.unknownType);
    _set(_Step.loading);
    final MyFeeQuotes fees;
    final List<PaymentMethod> methods;
    try {
      fees = await _repo.getFees();
      final quote = type == MembershipPaymentType.registration ? fees.registration : fees.renewal;
      _quote = quote;
      final open = quote.openPaymentId;
      if (open != null) return await _openResolved(type, open);
      if (fees.instructionsHidden) return _set(_Step.blocked, block: _Block.hidden);
      if (!quote.eligible) return _set(_Step.blocked, block: _Block.ineligible);
      methods = await _repo.listMethods();
    } on ApiException catch (error) {
      return _set(_Step.failed, error: error);
    }
    if (methods.isEmpty) return _set(_Step.blocked, block: _Block.noMethods);
    await _create(type, methods.first.id, checked: false);
  }

  Future<void> _create(MembershipPaymentType type, String methodId, {required bool checked}) async {
    _set(_Step.creating);
    try {
      final payment = await _repo.createInstruction(type, methodId);
      unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
      return _open(payment.id);
    } on ApiException catch (error) {
      if (!mounted) return;
      if (isOutcomeUnknown(error)) {
        if (checked) return _set(_Step.unknown, error: error);
        return _check(type, methodId);
      }
      switch (error.code) {
        case ErrorCode.forbidden:
          // Instruksi iuran disembunyikan untuk platform ini (D13).
          return _set(_Step.blocked, block: _Block.hidden);
        case ErrorCode.paymentStateConflict:
        case ErrorCode.membershipRequired:
        case ErrorCode.accountSuspended:
          // Status keanggotaan sudah berubah (sudah lunas, belum terdaftar, dibatasi): muat ulang /me lalu router
          // mengarahkan ulang bila perlu.
          unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
          return _set(_Step.failed, error: error);
        default:
          return _set(_Step.failed, error: error);
      }
    }
  }

  /// Memeriksa status (PRD 4.5): cari payment terbuka hasil permintaan yang terputus sebelum mengulang mutasi.
  Future<void> _check(MembershipPaymentType type, String methodId) async {
    _set(_Step.checking);
    try {
      final fees = await _repo.getFees();
      final quote = type == MembershipPaymentType.registration ? fees.registration : fees.renewal;
      final open = quote.openPaymentId;
      if (open != null) return await _openResolved(type, open);
    } on ApiException catch (error) {
      if (isOutcomeUnknown(error)) return _set(_Step.unknown, error: error);
      return _set(_Step.failed, error: error);
    }
    // Belum ada payment: ulangi dengan Idempotency-Key yang sama (payload sama).
    await _create(type, methodId, checked: true);
  }

  /// Payment terbuka ditemukan lewat GET /me/fees: hasil pembuatan instruksi sudah diketahui, jadi key yang mungkin
  /// tertinggal dari permintaan terputus dilepas sebelum layar instruksi dibuka. Tanpa ini key lama (retensi 24 jam)
  /// akan me-replay instruksi yang sama setelah instruksi itu dibatalkan (PRD 4.3, 4.5; AC F03-4).
  Future<void> _openResolved(MembershipPaymentType type, String paymentId) async {
    try {
      await _repo.resolveCreate(type);
    } on Object catch (error) {
      // Penyimpanan aman gagal: instruksi tetap dibuka; replay instruksi batal ditangani createInstruction.
      debugPrint('pembayaran: key pembuatan instruksi gagal dilepas (${error.runtimeType})');
    }
    _open(paymentId);
  }

  void _open(String paymentId) {
    if (!mounted) return;
    // Mengganti rute ini agar tombol kembali tidak membuat instruksi lagi.
    context.pushReplacement(AppRoutes.payment(paymentId));
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: 'Pembayaran',
      fallbackLocation: _type == MembershipPaymentType.renewal ? AppRoutes.renewal : AppRoutes.onboardingFees,
      body: switch (_step) {
        _Step.loading || _Step.creating => _Progress(
          message: _step == _Step.loading ? 'Memuat iuran...' : 'Menyiapkan instruksi pembayaran...',
        ),
        _Step.checking => const _Progress(
          message: 'Memeriksa status',
          detail: 'Koneksi sempat terputus. Kami memeriksa apakah instruksi sudah dibuat sebelum mencoba lagi.',
        ),
        _Step.unknown => _UnknownOutcome(onRetry: () => unawaited(_start())),
        _Step.failed => _failed(),
        _Step.blocked => _blocked(),
      },
    );
  }

  Widget _failed() => ErrorState.fromException(_error!, onRetry: () => unawaited(_start()));

  Widget _blocked() {
    switch (_block) {
      case _Block.hidden:
        return ListView(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          children: const [
            InfoBox(key: ValueKey('dues-hidden'), title: 'Iuran melalui pengurus', message: duesHiddenMessage),
            SizedBox(height: KapdhSpace.s4),
            SupportSection(subject: 'Iuran keanggotaan KAPDH', title: 'Hubungi pengurus'),
          ],
        );
      case _Block.ineligible:
        final quote = _quote!;
        final (String label, String location) = switch (quote.ineligibleReason) {
          FeeQuoteIneligibleReason.registrationRequired => ('Bayar iuran pendaftaran', AppRoutes.onboardingFees),
          FeeQuoteIneligibleReason.alreadyRegistered => ('Lihat KTA', AppRoutes.kta),
          _ => ('Lihat KTA', AppRoutes.kta),
        };
        return EmptyState(
          icon: Icons.event_available_outlined,
          title: 'Iuran belum dapat dibayar',
          message: ineligibleMessage(quote),
          actionLabel: label,
          onAction: () => context.go(location),
        );
      case _Block.noMethods:
        return ListView(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          children: const [
            EmptyState(
              icon: Icons.account_balance_outlined,
              title: 'Rekening tujuan belum tersedia',
              message: 'Pengurus belum mengaktifkan rekening tujuan transfer. Silakan hubungi pengurus.',
            ),
            SupportSection(subject: 'Iuran keanggotaan KAPDH', title: 'Hubungi pengurus'),
          ],
        );
      case _Block.unknownType:
      case null:
        return EmptyState(
          icon: Icons.search_off,
          title: 'Jenis pembayaran tidak dikenal',
          message: 'Buka pembayaran dari menu KTA atau riwayat pembayaran.',
          actionLabel: 'Riwayat pembayaran',
          onAction: () => context.go(AppRoutes.payments),
        );
    }
  }
}

class _Progress extends StatelessWidget {
  const _Progress({required this.message, this.detail});

  final String message;
  final String? detail;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(KapdhSpace.s6),
        child: Semantics(
          liveRegion: true,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: KapdhSpace.s4),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
              ),
              if (detail != null) ...[
                const SizedBox(height: KapdhSpace.s2),
                Text(
                  detail!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Hasil pembuatan instruksi belum diketahui dan pemeriksaan status juga gagal (masih offline).
class _UnknownOutcome extends StatelessWidget {
  const _UnknownOutcome({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(KapdhSpace.s5),
      children: [
        const InfoBox(
          key: ValueKey('create-checking-status'),
          tone: InfoBoxTone.warning,
          icon: Icons.sync_problem,
          title: 'Memeriksa status',
          message:
              'Koneksi terputus sehingga status instruksi belum dapat dipastikan. Jangan transfer dulu. Coba lagi saat '
              'koneksi kembali; instruksi tidak akan dibuat ganda.',
        ),
        const SizedBox(height: KapdhSpace.s4),
        KapdhButton.outlined(label: 'Periksa status', icon: Icons.refresh, onPressed: onRetry),
      ],
    );
  }
}
