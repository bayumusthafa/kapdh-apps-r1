import 'dart:async';

import 'package:flutter/material.dart';

import '../app/theme/kapdh_tokens.dart';

/// Kode QRIS statis resmi organisasi pada instruksi pembayaran (ADR-026; `PaymentMethod.qr_image_url`, berkas publik
/// purpose `payment_qr`). QRIS ini tanpa nominal: anggota memindainya lalu memasukkan nominal sendiri, kemudian
/// mengunggah bukti seperti transfer biasa (tidak ada payment gateway).
///
/// Kartu putih dengan gambar sekitar 280 lp yang tidak dipotong ([BoxFit.contain]) dan tidak dihaluskan
/// ([FilterQuality.none], tanpa anti-alias) agar modul QR tetap tajam untuk dipindai. Mengetuk gambar atau tombol
/// "Perbesar QRIS" membuka [QrisImageViewer]. Gambar yang gagal dimuat diganti tempat kosong berpesan dengan tombol
/// muat ulang (PRD 4.5).
///
/// [image] dibuat pemanggil dari penyedia gambar publik aplikasi (cache disk) agar design system tidak bergantung
/// pada folder fitur. Kartu ini hanya dipasang di tampilan instruksi bayar, yang tidak pernah tampil saat instruksi
/// iuran disembunyikan untuk platform ini (D13).
class QrisImageCard extends StatefulWidget {
  const QrisImageCard({super.key, required this.image, required this.merchantName});

  /// Gambar QRIS dari URL publik `qr_image_url`.
  final ImageProvider<Object> image;

  /// Nama merchant QRIS (`account_holder`) untuk label pembaca layar dan judul penampil.
  final String merchantName;

  /// Sisi kotak gambar maksimum (lp); menyusut di layar yang lebih sempit.
  static const double imageSize = 280;

  @override
  State<QrisImageCard> createState() => _QrisImageCardState();
}

class _QrisImageCardState extends State<QrisImageCard> with _QrisImageLoad<QrisImageCard> {
  @override
  ImageProvider<Object> get qrisImage => widget.image;

  @override
  void didUpdateWidget(QrisImageCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.image != widget.image) resetLoad();
  }

  void _open() => unawaited(QrisImageViewer.show(context, image: widget.image, merchantName: widget.merchantName));

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('qris-card'),
      width: double.infinity,
      padding: const EdgeInsets.all(KapdhSpace.s4),
      decoration: BoxDecoration(
        color: KapdhColors.surface,
        border: Border.all(color: KapdhColors.divider),
        borderRadius: BorderRadius.circular(KapdhRadius.lg),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final side = constraints.maxWidth < QrisImageCard.imageSize ? constraints.maxWidth : QrisImageCard.imageSize;
          if (failed) {
            return Center(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: side, maxWidth: side),
                child: _QrisLoadError(retrying: retrying, onRetry: () => unawaited(retry())),
              ),
            );
          }
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                button: true,
                label: 'Kode QRIS ${widget.merchantName}, ketuk untuk memperbesar',
                excludeSemantics: true,
                onTap: _open,
                child: Material(
                  color: KapdhColors.surface,
                  child: InkWell(
                    key: const ValueKey('qris-image'),
                    onTap: _open,
                    child: SizedBox.square(dimension: side, child: buildQrisImage()),
                  ),
                ),
              ),
              const SizedBox(height: KapdhSpace.s2),
              TextButton.icon(
                key: const ValueKey('qris-enlarge'),
                onPressed: _open,
                style: TextButton.styleFrom(
                  foregroundColor: KapdhColors.primary,
                  minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
                  textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
                icon: const Icon(Icons.zoom_in, size: 18),
                label: const Text('Perbesar QRIS'),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Penampil QRIS layar penuh berlatar putih (ADR-026): gambar dapat diperbesar dan digeser tanpa dihaluskan,
/// tombol "Tutup", dan petunjuk memindai karena kamera ponsel yang sama tidak dapat memindai layarnya sendiri.
class QrisImageViewer extends StatefulWidget {
  const QrisImageViewer({super.key, required this.image, required this.merchantName});

  final ImageProvider<Object> image;
  final String merchantName;

  /// Petunjuk memindai di bawah gambar.
  static const scanHint =
      'Pindai dari perangkat lain, atau simpan tangkapan layar lalu pilih unggah QR dari galeri di aplikasi '
      'bank/e-wallet.';

  /// Membuka penampil di atas seluruh layar (navigator akar, di atas bilah navigasi bawah).
  static Future<void> show(
    BuildContext context, {
    required ImageProvider<Object> image,
    required String merchantName,
  }) => showDialog<void>(
    context: context,
    useRootNavigator: true,
    builder: (_) => QrisImageViewer(image: image, merchantName: merchantName),
  );

  @override
  State<QrisImageViewer> createState() => _QrisImageViewerState();
}

class _QrisImageViewerState extends State<QrisImageViewer> with _QrisImageLoad<QrisImageViewer> {
  @override
  ImageProvider<Object> get qrisImage => widget.image;

  @override
  void didUpdateWidget(QrisImageViewer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.image != widget.image) resetLoad();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog.fullscreen(
      key: const ValueKey('qris-viewer'),
      backgroundColor: KapdhColors.surface,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s2, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        'QRIS ${widget.merchantName}',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: KapdhFontSize.h3,
                          fontWeight: FontWeight.w600,
                          color: KapdhColors.text,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: KapdhSpace.s2),
                  TextButton.icon(
                    key: const ValueKey('qris-viewer-close'),
                    onPressed: () => Navigator.of(context).pop(),
                    style: TextButton.styleFrom(
                      foregroundColor: KapdhColors.primary,
                      minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
                    ),
                    icon: const Icon(Icons.close),
                    label: const Text('Tutup'),
                  ),
                ],
              ),
            ),
            Expanded(
              child: failed
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(KapdhSpace.s5),
                        child: _QrisLoadError(retrying: retrying, onRetry: () => unawaited(retry())),
                      ),
                    )
                  : InteractiveViewer(
                      minScale: 1,
                      maxScale: 6,
                      child: Center(
                        child: Padding(
                          padding: const EdgeInsets.all(KapdhSpace.s4),
                          child: Semantics(
                            image: true,
                            label: 'Kode QRIS ${widget.merchantName}',
                            child: buildQrisImage(),
                          ),
                        ),
                      ),
                    ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s2, KapdhSpace.s5, KapdhSpace.s5),
              child: Text(
                QrisImageViewer.scanHint,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Status muat gambar QRIS bersama kartu dan penampil. `errorBuilder` berjalan saat build sehingga galat dicatat
/// sesudah frame; muat ulang mengeluarkan gambar gagal dari cache gambar (termasuk yang sedang dipakai) lalu memasang
/// [Image] baru agar provider dimuat sekali lagi.
mixin _QrisImageLoad<T extends StatefulWidget> on State<T> {
  ImageProvider<Object> get qrisImage;

  bool failed = false;
  bool retrying = false;
  int _attempt = 0;

  void resetLoad() {
    failed = false;
    retrying = false;
    _attempt++;
  }

  void _markFailed() {
    if (failed) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !failed) setState(() => failed = true);
    });
  }

  Future<void> retry() async {
    if (retrying) return;
    setState(() => retrying = true);
    await qrisImage.evict();
    if (!mounted) return;
    setState(resetLoad);
  }

  Widget buildQrisImage() => Image(
    key: ValueKey('qris-image-$_attempt'),
    image: qrisImage,
    fit: BoxFit.contain,
    filterQuality: FilterQuality.none,
    isAntiAlias: false,
    excludeFromSemantics: true,
    frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
      if (wasSynchronouslyLoaded || frame != null) return child;
      // Tempat kosong statis (tanpa animasi) selama gambar dimuat.
      return const Center(child: Icon(Icons.qr_code_2, size: 48, color: KapdhColors.neutral300));
    },
    errorBuilder: (context, error, stackTrace) {
      _markFailed();
      return const SizedBox.shrink();
    },
  );
}

/// Pesan gambar QRIS gagal dimuat dengan tombol muat ulang (dibacakan pembaca layar, N-11).
class _QrisLoadError extends StatelessWidget {
  const _QrisLoadError({required this.retrying, required this.onRetry});

  final bool retrying;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('qris-error'),
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.qr_code_2, size: 40, color: KapdhColors.neutral300),
        const SizedBox(height: KapdhSpace.s2),
        Semantics(
          liveRegion: true,
          child: const Text(
            'Gambar QRIS belum dapat dimuat',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600, color: KapdhColors.text),
          ),
        ),
        const SizedBox(height: KapdhSpace.s1),
        const Text(
          'Periksa koneksi lalu muat ulang.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
        ),
        const SizedBox(height: KapdhSpace.s2),
        TextButton.icon(
          key: const ValueKey('qris-retry'),
          onPressed: retrying ? null : onRetry,
          style: TextButton.styleFrom(
            foregroundColor: KapdhColors.primary,
            minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
          ),
          icon: const Icon(Icons.refresh),
          label: Text(retrying ? 'Memuat ulang...' : 'Muat ulang'),
        ),
      ],
    );
  }
}
