import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';
import '../proof_file.dart';
import '../proof_submission.dart';
import 'payment_layout.dart';

/// Aturan berkas bukti di bawah tile (prototipe layar 3; N-10).
const String proofRulesCaption = 'Foto JPG/PNG maks 5 MB atau PDF maks 10 MB.';

/// Lembar pilihan sumber bukti: kamera, galeri, atau PDF (N-10: PDF hanya untuk bukti pembayaran).
Future<ProofSource?> showProofSourceSheet(BuildContext context) {
  return showModalBottomSheet<ProofSource>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s2, 0, KapdhSpace.s2, KapdhSpace.s4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(KapdhSpace.s4, 0, KapdhSpace.s4, KapdhSpace.s2),
              child: PaymentSectionTitle('Pilih bukti transfer'),
            ),
            for (final (source, icon, title, subtitle) in const [
              (ProofSource.camera, KapdhIcons.photoCameraOutlined, 'Ambil foto', 'Foto bukti transfer dengan kamera'),
              (
                ProofSource.gallery,
                KapdhIcons.photoLibraryOutlined,
                'Pilih dari galeri',
                'Tangkapan layar aplikasi bank',
              ),
              (ProofSource.pdf, KapdhIcons.pictureAsPdfOutlined, 'Pilih PDF', 'Bukti transfer PDF maks 10 MB'),
            ])
              ListTile(
                minTileHeight: KapdhSize.touchTargetMin + KapdhSpace.s2,
                leading: Icon(icon, color: context.kc.primary),
                title: Text(title),
                subtitle: Text(subtitle),
                onTap: () => Navigator.of(sheetContext).pop(source),
              ),
          ],
        ),
      ),
    ),
  );
}

/// Bagian "Bukti transfer" (prototipe layar 3): tile unggah bergaris putus-putus, aturan berkas, catatan opsional
/// untuk pengurus, dan pemberitahuan "Memeriksa status" bila hasil pengiriman belum diketahui (PRD 4.5).
class ProofUploadSection extends StatelessWidget {
  const ProofUploadSection({
    super.key,
    required this.proof,
    required this.phase,
    required this.progress,
    required this.errorText,
    required this.onPick,
    required this.noteController,
    required this.unknownOutcome,
    required this.onCheckStatus,
    this.title = 'Bukti transfer',
  });

  final PickedProof? proof;
  final ProofSubmitPhase phase;
  final double? progress;
  final String? errorText;

  /// Null = nonaktif (sedang mengirim).
  final VoidCallback? onPick;
  final TextEditingController noteController;
  final bool unknownOutcome;
  final VoidCallback? onCheckStatus;
  final String title;

  @override
  Widget build(BuildContext context) {
    final busy = phase != ProofSubmitPhase.idle;
    final picked = proof;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PaymentSectionTitle(title),
        const SizedBox(height: KapdhSpace.s2),
        UploadTile(
          key: const ValueKey('proof-upload-tile'),
          fileName: picked?.name,
          fileSizeBytes: picked?.sizeBytes,
          isPdf: picked?.isPdf ?? false,
          progress: phase == ProofSubmitPhase.uploading ? (progress ?? 0) : null,
          errorText: errorText,
          onPick: busy ? null : onPick,
          emptyTitle: 'Pilih bukti transfer',
          emptySubtitle: 'Foto JPG/PNG atau PDF',
        ),
        const SizedBox(height: KapdhSpace.s2),
        Text(
          proofRulesCaption,
          style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
        ),
        const SizedBox(height: KapdhSpace.s4),
        KapdhTextField(
          key: const ValueKey('proof-note'),
          label: 'Catatan untuk pengurus (opsional)',
          controller: noteController,
          hint: 'Mis. transfer dari BSI a.n. Ahmad',
          maxLines: 2,
          enabled: !busy,
          inputFormatters: [LengthLimitingTextInputFormatter(200)],
          helperText: 'Membantu pengurus mencocokkan transfer. Tanggal transfer tidak menjadi dasar aktivasi.',
        ),
        if (unknownOutcome) ...[
          const SizedBox(height: KapdhSpace.s4),
          InfoBox(
            key: const ValueKey('proof-checking-status'),
            tone: InfoBoxTone.warning,
            icon: KapdhIcons.syncProblem,
            title: 'Memeriksa status',
            message:
                'Koneksi terputus saat mengirim bukti. Anda tidak perlu transfer ulang. Status pengiriman diperiksa '
                'lebih dahulu sebelum bukti dikirim lagi.',
            trailing: onCheckStatus == null
                ? null
                : TextButton(onPressed: busy ? null : onCheckStatus, child: const Text('Periksa')),
          ),
        ],
      ],
    );
  }
}
