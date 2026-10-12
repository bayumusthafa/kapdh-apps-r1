import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';

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
        color: KapdhColors.warningBg,
        padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s5, vertical: 10),
        child: Row(
          children: [
            const Icon(Icons.cloud_off, size: 18, color: KapdhColors.warning),
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
                style: const TextStyle(fontSize: 13, color: KapdhColors.warning),
              ),
            ),
            if (onRetry != null)
              TextButton(
                onPressed: onRetry,
                style: TextButton.styleFrom(foregroundColor: KapdhColors.warning),
                child: const Text('Coba lagi'),
              ),
          ],
        ),
      ),
    );
  }
}
