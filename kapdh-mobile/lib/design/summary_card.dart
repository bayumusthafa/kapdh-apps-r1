import 'package:flutter/material.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';

/// Satu baris label/nilai pada [SummaryCard].
@immutable
class SummaryRow {
  const SummaryRow(this.label, this.value, {this.emphasis = false, this.valueColor});

  final String label;
  final String value;

  /// Nilai tebal (mis. nominal).
  final bool emphasis;
  final Color? valueColor;
}

enum SummaryCardTone {
  /// Kartu putih bergaris abu (prototipe layar 2, 4).
  plain,

  /// Kartu catatan penolakan bergaris merah muda dengan judul merah (prototipe layar 5).
  danger,
}

/// Kartu ringkasan (prototipe layar 2 "Rincian iuran pendaftaran", layar 4 "Iuran pendaftaran", layar 5
/// "Catatan dari pengurus"): judul, baris label/nilai, total opsional, teks bebas dan catatan kaki.
class SummaryCard extends StatelessWidget {
  const SummaryCard({
    super.key,
    required this.title,
    this.rows = const [],
    this.total,
    this.body,
    this.footnote,
    this.tone = SummaryCardTone.plain,
    this.labelMuted = true,
  });

  final String title;
  final List<SummaryRow> rows;

  /// Baris total di bawah garis pemisah, nilai hijau tebal 16 px (prototipe layar 2).
  final SummaryRow? total;

  /// Paragraf bebas (mis. alasan penolakan).
  final String? body;

  /// Teks kecil abu di bagian bawah.
  final String? footnote;
  final SummaryCardTone tone;

  /// Label baris abu (prototipe layar 4) atau hitam (rincian biaya layar 2).
  final bool labelMuted;

  @override
  Widget build(BuildContext context) {
    final danger = tone == SummaryCardTone.danger;
    Widget row(SummaryRow r, {bool isTotal = false}) {
      final size = isTotal ? KapdhFontSize.bodyLg : (labelMuted ? 13.0 : KapdhFontSize.body);
      return MergeSemantics(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(
                r.label,
                style: TextStyle(
                  fontSize: size,
                  fontWeight: isTotal ? FontWeight.w700 : FontWeight.w400,
                  color: labelMuted && !isTotal ? context.kc.textMuted : context.kc.text,
                ),
              ),
            ),
            const SizedBox(width: KapdhSpace.s3),
            Flexible(
              child: Text(
                r.value,
                textAlign: TextAlign.right,
                style: TextStyle(
                  fontSize: size,
                  fontWeight: isTotal ? FontWeight.w700 : (r.emphasis ? FontWeight.w600 : FontWeight.w400),
                  color: r.valueColor == null
                      ? (isTotal ? context.kc.primary : context.kc.text)
                      : context.kc.resolve(r.valueColor!),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s4, vertical: 14),
      decoration: BoxDecoration(
        color: context.kc.surface,
        // [v2] Garis rambut cardBorder + --shadow-sm (dulu garis divider saja).
        border: Border.all(color: danger ? context.kc.rejectionBorder : context.kc.cardBorder),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
        boxShadow: context.kc.shadowSm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              title,
              style: TextStyle(
                fontSize: KapdhFontSize.body,
                fontWeight: FontWeight.w600,
                color: danger ? context.kc.danger : context.kc.text,
              ),
            ),
          ),
          if (body != null) ...[
            const SizedBox(height: KapdhSpace.s2),
            Text(body!, style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.55)),
          ],
          for (final r in rows) ...[const SizedBox(height: KapdhSpace.s2), row(r)],
          if (total != null) ...[
            const SizedBox(height: KapdhSpace.s3),
            const Divider(),
            const SizedBox(height: KapdhSpace.s3),
            row(total!, isTotal: true),
          ],
          if (footnote != null) ...[
            const SizedBox(height: KapdhSpace.s2),
            Text(
              footnote!,
              style: TextStyle(fontSize: KapdhFontSize.caption, height: 1.5, color: context.kc.textMuted),
            ),
          ],
        ],
      ),
    );
  }
}
