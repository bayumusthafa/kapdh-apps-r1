import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/api/error_presenter.dart';
import '../../../core/ui/external_links.dart';
import '../../../design/design.dart';
import '../payments_repository.dart';

/// Pembuat [ImageProvider] untuk berkas privat dari URL bertanda tangan (PRD 5.4): bawaan [NetworkImage] yang hanya
/// menyimpan gambar di memori, tidak pernah di cache disk (respons `Cache-Control: private, no-store`; bukti bayar
/// tidak boleh tertinggal di perangkat setelah logout, PRD 5.2, N-09). Uji menggantinya dengan gambar memori.
typedef PrivateImageProviderFactory = ImageProvider<Object> Function(String url);

final privateImageProviderFactoryProvider = Provider<PrivateImageProviderFactory>(
  (ref) =>
      (url) => NetworkImage(url),
);

/// Tautan "Lihat bukti" untuk bukti aktif milik sendiri (`PaymentDetail.proof_file_id`, kontrak payments.yaml; F-03,
/// AC F03-2, F03-3). Setiap ketukan meminta URL baca baru lewat GET /files/{fileId}/access (berlaku <= 10 menit,
/// files.yaml getFileAccess), sehingga URL yang kedaluwarsa tidak pernah dipakai ulang. Gambar dibuka layar penuh
/// di aplikasi (memori saja); PDF dibuka aplikasi penampil perangkat sesuai `mime`. Berkas yang tidak tersedia lagi
/// (404) dijelaskan tanpa membedakan alasannya (N-09).
class ProofPreviewLink extends ConsumerStatefulWidget {
  const ProofPreviewLink({super.key, required this.fileId, required this.proofVersion});

  final String fileId;

  /// Versi bukti aktif (`proof_version`) untuk label.
  final int proofVersion;

  @override
  ConsumerState<ProofPreviewLink> createState() => _ProofPreviewLinkState();
}

class _ProofPreviewLinkState extends ConsumerState<ProofPreviewLink> {
  bool _opening = false;

  String get _label => widget.proofVersion > 0 ? 'Bukti transfer ke-${widget.proofVersion}' : 'Bukti transfer';

  void _snack(String message) {
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _open() async {
    if (_opening) return;
    setState(() => _opening = true);
    try {
      final access = await ref.read(paymentsRepositoryProvider).proofAccess(widget.fileId);
      if (!mounted) return;
      setState(() => _opening = false);
      final mime = access.mime.toLowerCase();
      if (mime.startsWith('image/')) {
        await showDialog<void>(
          context: context,
          useRootNavigator: true,
          builder: (_) => ProofImageViewer(fileId: widget.fileId, label: _label, initial: access),
        );
      } else if (mime == 'application/pdf') {
        final uri = Uri.tryParse(access.url);
        final opened = uri != null && await ref.read(externalLinkLauncherProvider)(uri);
        if (!opened && mounted) _snack('Tidak ada aplikasi untuk membuka PDF bukti di perangkat ini.');
      } else {
        _snack('Pratinjau jenis berkas bukti ini belum didukung aplikasi.');
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == ErrorCode.notFound) {
        _snack(proofUnavailableMessage);
      } else {
        unawaited(ref.read(errorPresenterProvider).present(error, onRetry: () => unawaited(_open())));
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Semantics(
        // Status memuat dibacakan lewat label tombol (N-11).
        liveRegion: _opening,
        child: KapdhLinkButton(
          key: const ValueKey('proof-view'),
          label: _opening ? 'Membuka bukti...' : 'Lihat bukti yang dikirim',
          icon: Icons.image_search_outlined,
          onPressed: _opening ? null : () => unawaited(_open()),
        ),
      ),
    );
  }
}

/// Pesan untuk berkas bukti yang tidak dapat dibuka lagi (404 tanpa alasan, N-09).
const proofUnavailableMessage =
    'Berkas bukti ini tidak tersedia lagi. Hubungi pengurus bila Anda perlu memastikan bukti yang diperiksa.';

/// Penampil gambar bukti layar penuh (dapat diperbesar). Gambar yang gagal dimuat, misalnya karena URL bertanda
/// tangan sudah kedaluwarsa saat dibuka lama, dimuat ulang dengan URL baru dari GET /files/{fileId}/access.
class ProofImageViewer extends ConsumerStatefulWidget {
  const ProofImageViewer({super.key, required this.fileId, required this.label, required this.initial});

  final String fileId;
  final String label;
  final FileAccess initial;

  @override
  ConsumerState<ProofImageViewer> createState() => _ProofImageViewerState();
}

class _ProofImageViewerState extends ConsumerState<ProofImageViewer> {
  late FileAccess _access = widget.initial;
  bool _refreshing = false;
  String? _unavailable;

  Future<void> _reload() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      final access = await ref.read(paymentsRepositoryProvider).proofAccess(widget.fileId);
      if (!mounted) return;
      setState(() {
        _access = access;
        _unavailable = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _unavailable = error.code == ErrorCode.notFound ? proofUnavailableMessage : error.message);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Widget _message(String text, {bool retry = true}) => Padding(
    padding: const EdgeInsets.all(KapdhSpace.s5),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(color: KapdhColors.onPrimary, fontSize: KapdhFontSize.body),
          ),
        ),
        if (retry) ...[
          const SizedBox(height: KapdhSpace.s3),
          _refreshing
              ? const CircularProgressIndicator(color: KapdhColors.onPrimary, semanticsLabel: 'Memuat ulang bukti')
              : TextButton.icon(
                  key: const ValueKey('proof-viewer-reload'),
                  style: TextButton.styleFrom(
                    foregroundColor: KapdhColors.onPrimary,
                    minimumSize: const Size(KapdhSize.touchTargetMin, KapdhSize.touchTargetMin),
                  ),
                  onPressed: () => unawaited(_reload()),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Muat ulang'),
                ),
        ],
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final unavailable = _unavailable;
    return Dialog.fullscreen(
      backgroundColor: Colors.black,
      child: Stack(
        children: [
          Center(
            child: unavailable != null
                ? _message(unavailable)
                : InteractiveViewer(
                    child: Image(
                      key: ValueKey('proof-image-${_access.url}'),
                      image: ref.watch(privateImageProviderFactoryProvider)(_access.url),
                      semanticLabel: widget.label,
                      fit: BoxFit.contain,
                      loadingBuilder: (_, child, progress) => progress == null
                          ? child
                          : const CircularProgressIndicator(
                              color: KapdhColors.onPrimary,
                              semanticsLabel: 'Memuat bukti',
                            ),
                      errorBuilder: (_, _, _) =>
                          _message('Bukti tidak dapat dimuat. Tautan mungkin sudah kedaluwarsa atau koneksi terputus.'),
                    ),
                  ),
          ),
          SafeArea(
            child: Row(
              children: [
                IconButton(
                  key: const ValueKey('proof-viewer-close'),
                  tooltip: 'Tutup',
                  color: KapdhColors.onPrimary,
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(context).pop(),
                ),
                Expanded(
                  child: Text(
                    widget.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: KapdhColors.onPrimary,
                      fontSize: KapdhFontSize.body,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
