import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';

enum TimelineState {
  /// Sudah terjadi: lingkaran hijau dengan centang.
  done,

  /// Sedang berlangsung: lingkaran biru dengan titik putih.
  current,

  /// Belum terjadi: lingkaran putih bergaris abu.
  upcoming,

  /// Gagal/ditolak: lingkaran merah dengan silang.
  failed,
}

/// Satu kejadian pada [Timeline].
@immutable
class TimelineEntry {
  const TimelineEntry({required this.title, this.subtitle, this.state = TimelineState.done});

  final String title;

  /// Mis. waktu "12 Okt 2026, 14.20 WIB" atau "Sedang berlangsung".
  final String? subtitle;
  final TimelineState state;
}

/// Riwayat status terbaru di atas (prototipe layar 4 "Riwayat"; PaymentDetail.events).
class Timeline extends StatelessWidget {
  const Timeline({super.key, required this.entries});

  final List<TimelineEntry> entries;

  static String _stateLabel(TimelineState state) => switch (state) {
    TimelineState.done => 'selesai',
    TimelineState.current => 'sedang berlangsung',
    TimelineState.upcoming => 'belum terjadi',
    TimelineState.failed => 'gagal',
  };

  @override
  Widget build(BuildContext context) {
    Widget marker(TimelineState state) {
      const size = 22.0;
      return switch (state) {
        TimelineState.done => Container(
          width: size,
          height: size,
          decoration: const BoxDecoration(color: KapdhColors.primary, shape: BoxShape.circle),
          child: const Icon(Icons.check, size: 14, color: KapdhColors.onPrimary),
        ),
        TimelineState.current => Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: const BoxDecoration(color: KapdhColors.info, shape: BoxShape.circle),
          child: Container(
            width: 8,
            height: 8,
            decoration: const BoxDecoration(color: KapdhColors.surface, shape: BoxShape.circle),
          ),
        ),
        TimelineState.upcoming => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: KapdhColors.surface,
            shape: BoxShape.circle,
            border: Border.all(color: KapdhColors.border, width: 1.5),
          ),
        ),
        TimelineState.failed => Container(
          width: size,
          height: size,
          decoration: const BoxDecoration(color: KapdhColors.danger, shape: BoxShape.circle),
          child: const Icon(Icons.close, size: 14, color: KapdhColors.onPrimary),
        ),
      };
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < entries.length; i++) ...[
          if (i > 0) const SizedBox(height: KapdhSpace.s3),
          Semantics(
            label:
                '${entries[i].title}, ${_stateLabel(entries[i].state)}'
                '${entries[i].subtitle == null ? '' : ', ${entries[i].subtitle}'}',
            excludeSemantics: true,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(padding: const EdgeInsets.only(top: 1), child: marker(entries[i].state)),
                const SizedBox(width: KapdhSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(entries[i].title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                      if (entries[i].subtitle != null)
                        Text(
                          entries[i].subtitle!,
                          style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
