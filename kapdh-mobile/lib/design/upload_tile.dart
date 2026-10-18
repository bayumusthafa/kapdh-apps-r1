import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';
import '../core/format/formatters.dart';
import 'kapdh_icons.dart';

/// Garis tepi putus-putus 1 px bersudut membulat (prototipe layar 3: `border: 1px dashed`). Dipasang sebagai
/// `foregroundPainter` agar tidak tertutup isian latar tile.
class DashedBorderPainter extends CustomPainter {
  const DashedBorderPainter({required this.color, required this.radius});

  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final rect = RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius)).deflate(0.5);
    final path = Path()..addRRect(rect);
    const dash = 5.0;
    const gap = 4.0;
    for (final ui.PathMetric metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        canvas.drawPath(metric.extractPath(distance, distance + dash), paint);
        distance += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(DashedBorderPainter oldDelegate) => oldDelegate.color != color || oldDelegate.radius != radius;
}

/// Tile unggah bukti/berkas bergaris putus-putus hijau (prototipe layar 3 "Bukti transfer"; N-10).
///
/// Keadaan: kosong (ajakan memilih), terpilih (nama + ukuran + "Ganti"), mengunggah ([progress]) dan galat
/// ([errorText], mis. FILE_INVALID dengan aturan tipe/ukuran).
class UploadTile extends StatelessWidget {
  const UploadTile({
    super.key,
    this.fileName,
    this.fileSizeBytes,
    this.isPdf = false,
    this.onPick,
    this.progress,
    this.errorText,
    this.emptyTitle = 'Pilih bukti transfer',
    this.emptySubtitle = 'Foto JPG/PNG atau PDF',
  });

  final String? fileName;
  final int? fileSizeBytes;
  final bool isPdf;

  /// Membuka pemilih berkas; null = nonaktif.
  final VoidCallback? onPick;

  /// 0..1 saat mengunggah; null bila tidak sedang mengunggah.
  final double? progress;
  final String? errorText;
  final String emptyTitle;
  final String emptySubtitle;

  @override
  Widget build(BuildContext context) {
    final hasFile = fileName != null;
    final uploading = progress != null;
    final hasError = errorText != null;
    final borderColor = hasError ? KapdhColors.danger : KapdhColors.primary;
    final title = hasFile ? fileName! : emptyTitle;
    final subtitle = uploading
        ? 'Mengunggah ${(progress!.clamp(0, 1) * 100).round()}%'
        : (hasFile && fileSizeBytes != null ? formatFileSize(fileSizeBytes!) : (hasFile ? null : emptySubtitle));
    final actionLabel = hasFile ? 'Ganti' : 'Pilih';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: onPick != null && !uploading,
          enabled: onPick != null && !uploading,
          label: hasFile ? 'Berkas terpilih $title. $actionLabel berkas' : '$emptyTitle. $emptySubtitle',
          excludeSemantics: true,
          onTap: uploading ? null : onPick,
          // Garis dilukis DI ATAS isian Material (foregroundPainter); bila sebagai painter biasa, isian hijau muda
          // menutupinya sepenuhnya.
          child: CustomPaint(
            foregroundPainter: DashedBorderPainter(color: borderColor, radius: 12),
            child: Material(
              color: hasError ? KapdhColors.dangerBg : KapdhColors.green50,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: uploading ? null : onPick,
                child: Padding(
                  padding: const EdgeInsets.all(KapdhSpace.s3),
                  child: Row(
                    children: [
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: hasError ? KapdhColors.surface : KapdhColors.green100,
                          borderRadius: BorderRadius.circular(KapdhSpace.s2),
                        ),
                        child: Icon(
                          hasError
                              ? KapdhIcons.errorOutline
                              : (hasFile
                                    ? (isPdf ? KapdhIcons.pictureAsPdfOutlined : KapdhIcons.imageOutlined)
                                    : KapdhIcons.uploadFile),
                          color: hasError ? KapdhColors.danger : KapdhColors.primary,
                        ),
                      ),
                      const SizedBox(width: KapdhSpace.s3),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                            ),
                            if (subtitle != null)
                              Text(
                                subtitle,
                                style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                              ),
                            if (uploading) ...[
                              const SizedBox(height: KapdhSpace.s1),
                              LinearProgressIndicator(value: progress, minHeight: 4),
                            ],
                          ],
                        ),
                      ),
                      if (!uploading && onPick != null)
                        Padding(
                          padding: const EdgeInsets.only(left: KapdhSpace.s2),
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(minHeight: KapdhSize.touchTargetMin),
                            child: Center(
                              widthFactor: 1,
                              child: Text(
                                actionLabel,
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: KapdhColors.primary,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        if (hasError) ...[
          const SizedBox(height: KapdhSpace.s2),
          Text(
            errorText!,
            style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.danger),
          ),
        ],
      ],
    );
  }
}
