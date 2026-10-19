import 'package:flutter/material.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import 'kapdh_button.dart';
import 'kapdh_icons.dart';

/// Keadaan kosong dengan pesan dan tindakan spesifik (PRD 4.5, N-03).
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    this.message,
    this.icon = KapdhIcons.inboxOutlined,
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
      iconColor: context.kc.primary,
      iconBackground: context.kc.tintStrong,
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
    this.icon = KapdhIcons.errorOutline,
    this.onRetry,
    this.retryLabel = 'Coba lagi',
    this.requestId,
  });

  factory ErrorState.fromException(ApiException error, {Key? key, VoidCallback? onRetry}) {
    final (String title, IconData icon) = switch (error.ui.action) {
      ErrorUiAction.showOffline => ('Tidak ada koneksi', KapdhIcons.cloudOff),
      ErrorUiAction.showNotFound => ('Data tidak ditemukan', KapdhIcons.searchOff),
      ErrorUiAction.showForbidden => ('Akses ditolak', KapdhIcons.lockOutline),
      ErrorUiAction.refreshStatus || ErrorUiAction.goToRestricted => ('Akses belum tersedia', KapdhIcons.lockOutline),
      ErrorUiAction.showMaintenance => ('Sedang pemeliharaan', KapdhIcons.buildOutlined),
      ErrorUiAction.showCountdown => ('Terlalu banyak permintaan', KapdhIcons.timerOutlined),
      _ => ('Terjadi kesalahan', KapdhIcons.errorOutline),
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
      iconColor: context.kc.danger,
      iconBackground: context.kc.dangerBg,
      title: title,
      message: message,
      footnote: requestId == null ? null : 'Kode bantuan: $requestId',
      action: onRetry != null
          ? KapdhButton.outlined(label: retryLabel, onPressed: onRetry, icon: KapdhIcons.refresh, expand: false)
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
                // [v2] Persegi membulat 24 (dulu lingkaran).
                decoration: BoxDecoration(color: iconBackground, borderRadius: BorderRadius.circular(KapdhRadius.xl)),
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
                style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: context.kc.textMuted),
              ),
            ],
            if (action != null) ...[const SizedBox(height: KapdhSpace.s5), action!],
            if (footnote != null) ...[
              const SizedBox(height: KapdhSpace.s4),
              SelectableText(
                footnote!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: KapdhFontSize.overline, color: context.kc.textMuted),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Kilau (shimmer) v2 di atas kerangka pemuatan: blok anak digambar warna [KapdhPalette.skeleton], lalu pita terang
/// bergeser 1,4 s. Statis bila pengguna mematikan animasi (N-11).
class KapdhShimmer extends StatefulWidget {
  const KapdhShimmer({super.key, required this.child});

  final Widget child;

  @override
  State<KapdhShimmer> createState() => _KapdhShimmerState();
}

class _KapdhShimmerState extends State<KapdhShimmer> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduceMotion) {
      if (_controller.isAnimating) _controller.stop();
      return widget.child;
    }
    if (!_controller.isAnimating) _controller.repeat();
    final p = context.kc;
    return AnimatedBuilder(
      animation: _controller,
      child: widget.child,
      builder: (context, child) => ShaderMask(
        blendMode: BlendMode.srcATop,
        shaderCallback: (rect) => LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: [p.skeleton, p.skeletonShine, p.skeleton],
          stops: const [0.3, 0.5, 0.7],
          transform: _SlideGradient(Curves.easeInOutCubic.transform(_controller.value)),
        ).createShader(rect),
        child: child,
      ),
    );
  }
}

/// Menggeser gradasi selebar 3x kotak dari kanan ke kiri (CSS background-position 100% -> 0).
class _SlideGradient extends GradientTransform {
  const _SlideGradient(this.t);

  final double t;

  @override
  Matrix4? transform(Rect bounds, {TextDirection? textDirection}) =>
      Matrix4.translationValues(bounds.width * (1 - 2 * t), 0, 0)..scaleByDouble(3, 1, 1, 1);
}

/// Blok kerangka pemuatan berwarna [KapdhPalette.skeleton] (dipakai di dalam [KapdhShimmer]).
class SkeletonBlock extends StatelessWidget {
  const SkeletonBlock({super.key, this.width, required this.height, this.radius = KapdhRadius.sm, this.circle = false});

  final double? width;
  final double height;
  final double radius;
  final bool circle;

  @override
  Widget build(BuildContext context) => Container(
    width: width,
    height: height,
    decoration: BoxDecoration(
      color: context.kc.skeleton,
      shape: circle ? BoxShape.circle : BoxShape.rectangle,
      borderRadius: circle ? null : BorderRadius.circular(radius),
    ),
  );
}

/// Kerangka pemuatan berkilau (N-03); diumumkan pembaca layar sebagai "Memuat".
class LoadingSkeleton extends StatelessWidget {
  const LoadingSkeleton({super.key, this.lines = 3, this.showCard = true, this.semanticsLabel = 'Memuat'});

  /// Jumlah baris teks tiruan.
  final int lines;

  /// Tampilkan blok kartu besar di atas baris (mis. KTA atau banner).
  final bool showCard;
  final String semanticsLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: semanticsLabel,
      liveRegion: true,
      excludeSemantics: true,
      child: KapdhShimmer(
        child: Padding(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (showCard) ...[
                const SkeletonBlock(height: 160, radius: KapdhRadius.lg),
                const SizedBox(height: KapdhSpace.s5),
              ],
              for (var i = 0; i < lines; i++) ...[
                SkeletonBlock(height: 14, width: i.isEven ? double.infinity : 180),
                const SizedBox(height: KapdhSpace.s3),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
