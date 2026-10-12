import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../app/theme/kapdh_tokens.dart';
import 'kapdh_button.dart';

/// Keadaan kosong dengan pesan dan tindakan spesifik (PRD 4.5, N-03).
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    this.message,
    this.icon = Icons.inbox_outlined,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final String? message;
  final IconData icon;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return _CenteredState(
      icon: icon,
      iconColor: KapdhColors.primary,
      iconBackground: KapdhColors.green50,
      title: title,
      message: message,
      action: actionLabel != null && onAction != null
          ? KapdhButton.outlined(label: actionLabel!, onPressed: onAction, expand: false)
          : null,
    );
  }
}

/// Keadaan galat dari [ApiException] lewat katalog galat terbangkit (PRD 5.2): offline dibedakan dari "tidak
/// ditemukan" (PRD 4.5), dan request_id ditampilkan untuk dilaporkan ke bantuan (N-14).
class ErrorState extends StatelessWidget {
  const ErrorState({
    super.key,
    required this.title,
    required this.message,
    this.icon = Icons.error_outline,
    this.onRetry,
    this.retryLabel = 'Coba lagi',
    this.requestId,
  });

  factory ErrorState.fromException(ApiException error, {Key? key, VoidCallback? onRetry}) {
    final (String title, IconData icon) = switch (error.ui.action) {
      ErrorUiAction.showOffline => ('Tidak ada koneksi', Icons.cloud_off),
      ErrorUiAction.showNotFound => ('Data tidak ditemukan', Icons.search_off),
      ErrorUiAction.showForbidden => ('Akses ditolak', Icons.lock_outline),
      ErrorUiAction.refreshStatus || ErrorUiAction.goToRestricted => ('Akses belum tersedia', Icons.lock_outline),
      ErrorUiAction.showMaintenance => ('Sedang pemeliharaan', Icons.build_outlined),
      ErrorUiAction.showCountdown => ('Terlalu banyak permintaan', Icons.timer_outlined),
      _ => ('Terjadi kesalahan', Icons.error_outline),
    };
    // Coba lagi tidak ditawarkan bila mengulang tidak akan mengubah hasil (izin/data tidak ada).
    final retryable = switch (error.ui.action) {
      ErrorUiAction.showNotFound || ErrorUiAction.showForbidden => false,
      _ => true,
    };
    return ErrorState(
      key: key,
      title: title,
      message: error.message,
      icon: icon,
      onRetry: retryable ? onRetry : null,
      requestId: error.requestId,
    );
  }

  final String title;
  final String message;
  final IconData icon;
  final VoidCallback? onRetry;
  final String retryLabel;
  final String? requestId;

  @override
  Widget build(BuildContext context) {
    return _CenteredState(
      icon: icon,
      iconColor: KapdhColors.danger,
      iconBackground: KapdhColors.dangerBg,
      title: title,
      message: message,
      footnote: requestId == null ? null : 'Kode bantuan: $requestId',
      action: onRetry != null
          ? KapdhButton.outlined(label: retryLabel, onPressed: onRetry, icon: Icons.refresh, expand: false)
          : null,
    );
  }
}

class _CenteredState extends StatelessWidget {
  const _CenteredState({
    required this.icon,
    required this.iconColor,
    required this.iconBackground,
    required this.title,
    this.message,
    this.footnote,
    this.action,
  });

  final IconData icon;
  final Color iconColor;
  final Color iconBackground;
  final String title;
  final String? message;
  final String? footnote;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(KapdhSpace.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ExcludeSemantics(
              child: Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(color: iconBackground, shape: BoxShape.circle),
                child: Icon(icon, size: 30, color: iconColor),
              ),
            ),
            const SizedBox(height: KapdhSpace.s4),
            Semantics(
              header: true,
              child: Text(
                title,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600),
              ),
            ),
            if (message != null) ...[
              const SizedBox(height: KapdhSpace.s2),
              Text(
                message!,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhColors.textMuted),
              ),
            ],
            if (action != null) ...[const SizedBox(height: KapdhSpace.s5), action!],
            if (footnote != null) ...[
              const SizedBox(height: KapdhSpace.s4),
              SelectableText(
                footnote!,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: KapdhFontSize.overline, color: KapdhColors.textMuted),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Kerangka pemuatan berdenyut (N-03); diumumkan pembaca layar sebagai "Memuat".
class LoadingSkeleton extends StatefulWidget {
  const LoadingSkeleton({super.key, this.lines = 3, this.showCard = true, this.semanticsLabel = 'Memuat'});

  /// Jumlah baris teks tiruan.
  final int lines;

  /// Tampilkan blok kartu besar di atas baris (mis. KTA atau banner).
  final bool showCard;
  final String semanticsLabel;

  @override
  State<LoadingSkeleton> createState() => _LoadingSkeletonState();
}

class _LoadingSkeletonState extends State<LoadingSkeleton> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
    lowerBound: 0.45,
    upperBound: 1,
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget block({double? width, required double height, double radius = KapdhRadius.sm}) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(color: KapdhColors.neutral200, borderRadius: BorderRadius.circular(radius)),
    );
    return Semantics(
      label: widget.semanticsLabel,
      liveRegion: true,
      excludeSemantics: true,
      child: FadeTransition(
        opacity: _controller,
        child: Padding(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.showCard) ...[
                block(height: 160, radius: KapdhRadius.lg),
                const SizedBox(height: KapdhSpace.s5),
              ],
              for (var i = 0; i < widget.lines; i++) ...[
                block(height: 14, width: i.isEven ? double.infinity : 180),
                const SizedBox(height: KapdhSpace.s3),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
