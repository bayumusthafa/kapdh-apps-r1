import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';
import 'payment_presentation.dart';
import 'payments_repository.dart';

/// Riwayat pembayaran milik sendiri, termasuk iuran dan tiket (F-03, F-07; PRD 2.2: status efektif apa pun,
/// termasuk expired, tetap dapat membaca riwayat sendiri). Urut terbaru, halaman keyset 30 item.
class PaymentsScreen extends ConsumerStatefulWidget {
  const PaymentsScreen({super.key});

  @override
  ConsumerState<PaymentsScreen> createState() => _PaymentsScreenState();
}

class _PaymentsScreenState extends ConsumerState<PaymentsScreen> {
  static const _pageSize = 30;

  final List<Payment> _items = [];
  String? _cursor;
  bool _loaded = false;
  bool _loading = false;
  bool _loadingMore = false;
  ApiException? _error;
  ApiException? _moreError;

  PaymentsRepository get _repo => ref.read(paymentsRepositoryProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await _repo.listPayments(limit: _pageSize);
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(page.items);
        _cursor = page.nextCursor;
        _loaded = true;
        _moreError = null;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadMore() async {
    final cursor = _cursor;
    if (cursor == null || _loadingMore || _loading) return;
    setState(() {
      _loadingMore = true;
      _moreError = null;
    });
    try {
      final page = await _repo.listPayments(cursor: cursor, limit: _pageSize);
      if (!mounted) return;
      setState(() {
        final known = {for (final p in _items) p.id};
        _items.addAll(page.items.where((p) => !known.contains(p.id)));
        _cursor = page.nextCursor;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _moreError = error);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(title: 'Riwayat Pembayaran', fallbackLocation: AppRoutes.account, body: _body());
  }

  Widget _body() {
    if (!_loaded) {
      final error = _error;
      if (error != null) return ErrorState.fromException(error, onRetry: () => unawaited(_refresh()));
      return const LoadingSkeleton(showCard: false, lines: 6, semanticsLabel: 'Memuat riwayat pembayaran');
    }
    if (_items.isEmpty) {
      final unverified = ref.watch(sessionProvider.select((s) => s.effectiveStatus)) == EffectiveStatus.unverified;
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          children: [
            EmptyState(
              icon: Icons.receipt_long_outlined,
              title: 'Belum ada pembayaran',
              message: 'Iuran keanggotaan dan pembayaran tiket Anda akan tampil di sini beserta statusnya.',
              actionLabel: unverified ? 'Bayar iuran' : null,
              onAction: unverified ? () => context.go(AppRoutes.onboardingFees) : null,
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: NotificationListener<ScrollNotification>(
        onNotification: (notification) {
          if (notification.metrics.extentAfter < 320) unawaited(_loadMore());
          return false;
        },
        child: ListView.separated(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          itemCount: _items.length + 1,
          separatorBuilder: (_, _) => const SizedBox(height: KapdhSpace.s3),
          itemBuilder: (context, index) {
            if (index == _items.length) return _footer();
            final payment = _items[index];
            return PaymentTile(
              key: ValueKey('payment-${payment.id}'),
              payment: payment,
              onTap: () => context.push(AppRoutes.payment(payment.id)),
            );
          },
        ),
      ),
    );
  }

  Widget _footer() {
    if (_loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(KapdhSpace.s4),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final moreError = _moreError;
    if (moreError != null) {
      return InfoBox(
        tone: InfoBoxTone.warning,
        message: moreError.message,
        trailing: TextButton(onPressed: () => unawaited(_loadMore()), child: const Text('Coba lagi')),
      );
    }
    if (_cursor != null) {
      return Center(
        child: KapdhLinkButton(label: 'Muat lagi', onPressed: () => unawaited(_loadMore())),
      );
    }
    return const SizedBox(height: KapdhSpace.s4);
  }
}

/// Satu baris riwayat pembayaran: jenis, nominal, tanggal, rekening tujuan dan badge status (label + ikon, PRD 4.5).
class PaymentTile extends StatelessWidget {
  const PaymentTile({super.key, required this.payment, required this.onTap});

  final Payment payment;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final icon = switch (payment.type) {
      PaymentType.registration => Icons.card_membership_outlined,
      PaymentType.renewal => Icons.autorenew,
      PaymentType.ticket => Icons.confirmation_number_outlined,
      PaymentType.unknown => Icons.receipt_long_outlined,
    };
    final badge = paymentBadge(payment);
    final title = paymentTitle(payment);
    final amount = formatRupiah(payment.amount);
    final date = formatDate(payment.createdAt);
    return Semantics(
      button: true,
      label: '$title, $amount, $date, status ${badge.label}',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: KapdhColors.surface,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: KapdhColors.divider),
          borderRadius: BorderRadius.circular(KapdhRadius.lg),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(color: KapdhColors.green50, borderRadius: BorderRadius.circular(10)),
                  child: Icon(icon, color: KapdhColors.primary, size: 22),
                ),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '$amount · $date',
                        style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                      ),
                      const SizedBox(height: KapdhSpace.s2),
                      StatusBadge(badge),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: KapdhColors.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
