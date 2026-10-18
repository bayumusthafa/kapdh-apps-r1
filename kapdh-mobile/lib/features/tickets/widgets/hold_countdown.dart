import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/format/formatters.dart';
import '../../events/event_format.dart';
import '../../../design/kapdh_icons.dart';

/// Hitung mundur batas kirim bukti reservasi (D5: 24 jam atau sampai pendaftaran ditutup). `hold_expires_at` adalah
/// stempel server, jadi dibandingkan dengan perkiraan jam server (`ServerClock.now()`), bukan jam perangkat yang bisa
/// melenceng (PRD 2.1). Saat habis, [onExpired] dipanggil sekali agar layar memuat ulang status dari server
/// (tiket tampil expired, AC F09-2); klien tidak mengubah status sendiri.
class HoldCountdown extends ConsumerStatefulWidget {
  const HoldCountdown({super.key, required this.expiresAt, required this.zone, required this.onExpired});

  final DateTime expiresAt;

  /// Zona tampilan event untuk tanggal batas.
  final String zone;
  final VoidCallback onExpired;

  @override
  ConsumerState<HoldCountdown> createState() => _HoldCountdownState();
}

class _HoldCountdownState extends ConsumerState<HoldCountdown> {
  Timer? _timer;
  bool _notified = false;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void didUpdateWidget(HoldCountdown oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.expiresAt != widget.expiresAt) {
      _notified = false;
      _start();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _start() {
    _timer ??= Timer.periodic(const Duration(seconds: 1), (_) => _tick());
  }

  Duration _remaining() => widget.expiresAt.difference(ref.read(serverClockProvider).now());

  void _tick() {
    if (!mounted) return;
    final remaining = _remaining();
    if (remaining <= Duration.zero) {
      // Batas lewat: tampilan statis, detak berhenti; status akhir datang dari server lewat [onExpired].
      _timer?.cancel();
      _timer = null;
      if (!_notified) {
        _notified = true;
        widget.onExpired();
      }
    }
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final remaining = _remaining();
    final expired = remaining <= Duration.zero;
    final deadline = formatDateTime(widget.expiresAt, zone: widget.zone);
    return Semantics(
      container: true,
      label: expired
          ? 'Batas waktu pembayaran sudah lewat'
          : 'Sisa waktu pembayaran ${describeHoldRemaining(remaining)}, batas $deadline',
      excludeSemantics: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(KapdhSpace.s4),
        decoration: BoxDecoration(
          color: expired ? context.kc.dangerBg : context.kc.warningBg,
          borderRadius: BorderRadius.circular(KapdhRadius.lg),
        ),
        child: Column(
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  expired ? KapdhIcons.timerOffOutlined : KapdhIcons.timerOutlined,
                  size: 18,
                  color: expired ? context.kc.danger : context.kc.warning,
                ),
                const SizedBox(width: KapdhSpace.s2),
                Flexible(
                  child: Text(
                    expired ? 'Batas waktu pembayaran lewat' : 'Selesaikan pembayaran dalam',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: expired ? context.kc.danger : context.kc.warning,
                    ),
                  ),
                ),
              ],
            ),
            if (!expired) ...[
              const SizedBox(height: KapdhSpace.s1),
              Text(
                formatHoldRemaining(remaining),
                key: const ValueKey('hold-countdown'),
                style: TextStyle(
                  fontSize: KapdhFontSize.h1,
                  fontWeight: FontWeight.w700,
                  color: context.kc.text,
                  fontFeatures: [const FontFeature.tabularFigures()],
                ),
              ),
            ],
            const SizedBox(height: KapdhSpace.s1),
            Text(
              'Batas kirim bukti: $deadline',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}
