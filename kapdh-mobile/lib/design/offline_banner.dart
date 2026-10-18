import 'package:flutter/material.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';
import 'kapdh_icons.dart';

/// Pita "Offline" di bawah app bar (prototipe layar 7; AC F05-2, N-03): data yang tampil berasal dari sinkronisasi
/// terakhir dan bukan bukti status saat ini. Diumumkan pembaca layar sebagai status (role=status).
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, this.syncedAt, this.message, this.onRetry});

  /// Waktu sinkronisasi terakhir; ditampilkan "Tersinkron 11 Okt 2026, 20.14 WIB".
  final DateTime? syncedAt;

  /// Teks pengganti bila tidak ada waktu sinkronisasi.
  final String? message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final detail = syncedAt != null
        ? 'Tersinkron ${formatDateTime(syncedAt!)}'
        : (message ?? 'Periksa koneksi internet Anda.');
    return Semantics(
      liveRegion: true,
      container: true,
      child: Container(
        width: double.infinity,
        color: context.kc.warningBg,
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: 10),
        child: Row(
          children: [
            Icon(KapdhIcons.cloudOff, size: KapdhIconSize.button, color: context.kc.warning),
            const SizedBox(width: 10),
            Expanded(
              child: Text.rich(
                TextSpan(
                  children: [
                    const TextSpan(
                      text: 'Offline',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    TextSpan(text: '. $detail'),
                  ],
                ),
                style: TextStyle(fontSize: 13, color: context.kc.warning),
              ),
            ),
            if (onRetry != null)
              TextButton(
                onPressed: onRetry,
                style: TextButton.styleFrom(foregroundColor: context.kc.warning),
                child: const Text('Coba lagi'),
              ),
          ],
        ),
      ),
    );
  }
}

/// Pita "Pemeliharaan" di bawah app bar (PRD 4.5 "menolak mutasi, read-only terkontrol"): data tetap dapat dibaca,
/// perubahan ditunda sampai pemeliharaan selesai. Diumumkan pembaca layar sebagai status; status tidak dibedakan
/// dengan warna saja (ikon + teks).
class MaintenanceBanner extends StatelessWidget {
  const MaintenanceBanner({super.key, this.until, this.onDetails});

  /// Perkiraan selesai; ditampilkan "sampai sekitar 12 Okt 2026, 16.00 WIB".
  final DateTime? until;

  /// Membuka layar maintenance (estimasi, coba lagi, dukungan).
  final VoidCallback? onDetails;

  @override
  Widget build(BuildContext context) {
    final detail = until != null
        ? 'Perubahan data ditunda sampai sekitar ${formatDateTime(until!)}.'
        : 'Perubahan data ditunda sementara.';
    return Semantics(
      liveRegion: true,
      container: true,
      child: Container(
        width: double.infinity,
        color: context.kc.warningBg,
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: 10),
        child: Row(
          children: [
            Icon(KapdhIcons.buildOutlined, size: KapdhIconSize.button, color: context.kc.warning),
            const SizedBox(width: 10),
            Expanded(
              child: Text.rich(
                TextSpan(
                  children: [
                    const TextSpan(
                      text: 'Pemeliharaan',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    TextSpan(text: '. $detail'),
                  ],
                ),
                style: TextStyle(fontSize: 13, color: context.kc.warning),
              ),
            ),
            if (onDetails != null)
              TextButton(
                onPressed: onDetails,
                style: TextButton.styleFrom(foregroundColor: context.kc.warning),
                child: const Text('Detail'),
              ),
          ],
        ),
      ),
    );
  }
}
