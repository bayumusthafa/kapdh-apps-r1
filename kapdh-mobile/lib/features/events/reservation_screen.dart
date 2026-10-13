import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../design/design.dart';
import '../home/shared/content_widgets.dart';
import '../home/shared/remote_image.dart';
import 'event_format.dart';
import 'events_controllers.dart';
import 'reservation.dart';

/// Konfirmasi pendaftaran event berbayar (guideline hal. 8 "Detail Tiket"): nama event, peserta (satu orang, diri
/// sendiri, tanpa tipe atau jumlah tiket; PRD 3.9 disahkan v3.2), harga tiket, metode pembayaran dan total.
/// Mengirim reservasi dengan `expected_price` yang ditampilkan; harga yang berubah di server ditolak tanpa hold dan
/// ditampilkan untuk dikonfirmasi ulang (PRD 4.4). Berhasil: lanjut ke layar pembayaran bersama untuk unggah bukti
/// sebelum batas hold (D5).
class ReservationScreen extends ConsumerStatefulWidget {
  const ReservationScreen({super.key, required this.eventId});

  final String eventId;

  @override
  ConsumerState<ReservationScreen> createState() => _ReservationScreenState();
}

class _ReservationScreenState extends ConsumerState<ReservationScreen> {
  String? _methodId;
  String? _methodError;
  bool _busy = false;

  /// Harga saat layar ini pertama dibuka; harga terbaru dari server yang berbeda ditandai agar anggota memeriksa
  /// ulang sebelum mengirim (PRD 4.4 `expected_price`).
  String? _initialPrice;

  @override
  Widget build(BuildContext context) {
    final event = ref.watch(eventDetailControllerProvider(widget.eventId)).event;
    final maintenance = ref.watch(appGateProvider.select((gate) => gate.status == GateStatus.maintenance));
    if (event == null) {
      return const AppScaffold(
        title: 'Konfirmasi Pendaftaran',
        body: LoadingSkeleton(semanticsLabel: 'Memuat event'),
      );
    }
    _initialPrice ??= event.price;
    final priceChanged = event.price != _initialPrice;
    final methods = ref.watch(paymentMethodsProvider);
    final price = formatEventPrice(event.price, isFree: event.isFree);
    final canSubmit = event.canReserve && !event.isFree && _methodId != null && !_busy && !maintenance;
    return AppScaffold(
      title: 'Konfirmasi Pendaftaran',
      body: ListView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, KapdhSpace.s6),
        children: [
          const _Label('Nama Event'),
          _EventSummaryCard(event: event),
          const SizedBox(height: KapdhSpace.s4),
          const _Label('Peserta'),
          const InfoBox(
            icon: Icons.person_outline,
            message:
                'Satu tiket untuk Anda sendiri. Satu anggota hanya dapat memiliki satu tiket aktif per event; tidak '
                'ada pemesanan untuk rombongan atau tamu.',
          ),
          const SizedBox(height: KapdhSpace.s4),
          const _Label('Harga Tiket'),
          _ValueBox(text: price, key: const ValueKey('reservation-price')),
          if (priceChanged) ...[
            const SizedBox(height: KapdhSpace.s2),
            InfoBox(
              tone: InfoBoxTone.warning,
              title: 'Harga tiket berubah',
              message:
                  'Pengurus mengubah harga menjadi $price. Periksa kembali sebelum melanjutkan; Anda belum terdaftar.',
            ),
          ],
          const SizedBox(height: KapdhSpace.s4),
          const _Label('Metode Pembayaran'),
          methods.when(
            loading: () => const LoadingSkeleton(showCard: false, lines: 2, semanticsLabel: 'Memuat metode pembayaran'),
            error: (error, _) => InfoBox(
              tone: InfoBoxTone.danger,
              message: error is ApiException ? error.message : 'Metode pembayaran belum dapat dimuat.',
              trailing: TextButton(
                onPressed: () => ref.invalidate(paymentMethodsProvider),
                child: const Text('Coba lagi'),
              ),
            ),
            data: (items) => items.isEmpty
                ? const InfoBox(
                    tone: InfoBoxTone.warning,
                    message: 'Belum ada rekening tujuan aktif. Hubungi pengurus sebelum mendaftar event berbayar.',
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final method in items) ...[
                        MethodRadioCard(
                          key: ValueKey('method-${method.id}'),
                          title: method.provider,
                          selected: _methodId == method.id,
                          accountNumber: method.accountNumber,
                          accountHolder: method.accountHolder,
                          hint: method.kind == PaymentMethodKind.ewallet ? 'E-wallet' : 'Transfer bank',
                          onSelected: _busy
                              ? null
                              : () => setState(() {
                                  _methodId = method.id;
                                  _methodError = null;
                                }),
                        ),
                        const SizedBox(height: KapdhSpace.s2),
                      ],
                      if (_methodError != null)
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            _methodError!,
                            style: const TextStyle(color: KapdhColors.danger, fontSize: KapdhFontSize.caption),
                          ),
                        ),
                    ],
                  ),
          ),
          const SizedBox(height: KapdhSpace.s4),
          SummaryCard(
            title: 'Ringkasan',
            labelMuted: false,
            rows: [SummaryRow('Tiket untuk 1 orang (Anda sendiri)', price)],
            total: SummaryRow('Total Pembayaran', price),
          ),
          const SizedBox(height: KapdhSpace.s3),
          InfoBox(
            icon: Icons.timer_outlined,
            message:
                'Kursi ditahan maksimal ${event.holdHours} jam atau sampai pendaftaran ditutup '
                '(${formatDateTime(event.registrationClosesAt, zone: event.timezone)}), mana yang lebih dahulu. '
                'Kirim bukti transfer sebelum batas itu; reservasi tanpa bukti berakhir otomatis.',
          ),
          const SizedBox(height: KapdhSpace.s3),
          InfoBox(
            icon: Icons.policy_outlined,
            title: 'Pembatalan dan refund',
            message: event.cancellationPolicy.summary,
          ),
          if (event.isFree) ...[
            const SizedBox(height: KapdhSpace.s3),
            const InfoBox(
              tone: InfoBoxTone.warning,
              message: 'Event ini kini gratis. Kembali ke detail event untuk mendaftar tanpa pembayaran.',
            ),
          ],
          if (!event.canReserve) ...[
            const SizedBox(height: KapdhSpace.s3),
            InfoBox(
              tone: InfoBoxTone.danger,
              message: 'Pendaftaran tidak dapat dilanjutkan: ${registrationStateStyle(event.registrationState).label}.',
            ),
          ],
          if (maintenance) ...[
            const SizedBox(height: KapdhSpace.s3),
            const InfoBox(
              tone: InfoBoxTone.warning,
              message: 'Pendaftaran ditunda selama pemeliharaan. Coba lagi setelah layanan normal.',
            ),
          ],
        ],
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: KapdhColors.surface,
          border: Border(top: BorderSide(color: KapdhColors.divider)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s3, KapdhSpace.s5, KapdhSpace.s3),
            // Column min: bilah bawah setinggi tombolnya saja, bukan seluruh layar.
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                KapdhButton(
                  key: const ValueKey('reservation-submit'),
                  label: priceChanged ? 'Setuju Harga Baru dan Daftar' : 'Daftar dan Lanjut Bayar',
                  busy: _busy,
                  busyLabel: 'Mendaftarkan…',
                  semanticsHint: _methodId == null ? 'Pilih metode pembayaran lebih dahulu' : null,
                  onPressed: canSubmit ? () => unawaited(_submit(event)) : null,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submit(EventDetail event) async {
    setState(() {
      _busy = true;
      _methodError = null;
    });
    final outcome = await submitReservation(context, ref, event: event, paymentMethodId: _methodId);
    if (!mounted) return;
    setState(() => _busy = false);
    switch (outcome) {
      case final ReservationDone done:
        // Layar detail event yang membuka layar ini meneruskan ke pembayaran atau detail tiket.
        Navigator.of(context).pop(done);
      case ReservationPriceChanged():
        // Detail event sudah diganti `current`; build berikutnya menandai harga baru untuk dikonfirmasi ulang.
        break;
      case ReservationInvalidMethod(:final message):
        setState(() {
          _methodId = null;
          _methodError = message;
        });
      case ReservationNetworkFailed():
        showReservationRetry(ref, () {
          if (mounted) unawaited(_submit(event));
        });
      case ReservationStopped():
        break;
    }
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: KapdhSpace.s2),
    child: Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
  );
}

class _ValueBox extends StatelessWidget {
  const _ValueBox({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.md),
      ),
      child: Text(
        text,
        style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _EventSummaryCard extends StatelessWidget {
  const _EventSummaryCard({required this.event});

  final EventDetail event;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(KapdhSpace.s3),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: Row(
        children: [
          RemoteImage(
            url: event.coverUrl,
            width: 88,
            height: 64,
            borderRadius: BorderRadius.circular(KapdhRadius.md),
            placeholderIcon: Icons.event,
          ),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  event.title,
                  style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: KapdhSpace.s1),
                IconLine(
                  icon: Icons.calendar_today_outlined,
                  text: formatEventSchedule(event.startsAt, event.endsAt, event.timezone),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
