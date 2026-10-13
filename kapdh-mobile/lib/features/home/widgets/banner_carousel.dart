import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_tokens.dart';
import '../../../core/ui/external_links.dart';
import '../shared/links.dart';
import '../shared/remote_image.dart';

/// Membuka target banner yang sudah diselesaikan server (AC F08-2):
/// - `none`: tidak dapat diketuk;
/// - target internal yang `available = false` (berita diarsipkan, event dibatalkan/selesai, halaman dihapus):
///   pesan yang jelas, bukan layar kosong;
/// - `url`: tautan luar https dengan konfirmasi domain (PRD 3.8);
/// - lainnya: rute aplikasi `/news/{slug}`, `/events/{id}`, `/legal/{slug}`; router tetap memeriksa akses.
Future<void> openBannerTarget(BuildContext context, WidgetRef ref, HomeBannerTarget target) async {
  switch (target.type) {
    case BannerTargetType.none:
      return;
    case BannerTargetType.url:
      final uri = externalLinkUri(target.url);
      if (uri == null) {
        showAppSnackBar(ref, unavailableTargetMessage);
        return;
      }
      if (!await confirmExternalLink(context, uri)) return;
      final launched = await ref.read(externalLinkLauncherProvider)(uri);
      if (!launched) showAppSnackBar(ref, 'Tidak ada aplikasi yang dapat membuka tautan ini.');
    case BannerTargetType.post:
    case BannerTargetType.event:
    case BannerTargetType.page:
    case BannerTargetType.unknown:
      final route = target.route;
      if (!target.available || route == null || !route.startsWith('/')) {
        showAppSnackBar(ref, unavailableTargetMessage);
        return;
      }
      await openContentLink(context, ref, route);
  }
}

/// Karosel banner aktif Beranda (PRD 3.8): geser manual (tanpa putar otomatis agar dapat dibaca pembaca layar dan
/// tidak bergerak sendiri, N-11), titik penanda posisi, judul sebagai label gambar.
class BannerCarousel extends ConsumerStatefulWidget {
  const BannerCarousel({super.key, required this.banners});

  final List<HomeBanner> banners;

  @override
  ConsumerState<BannerCarousel> createState() => _BannerCarouselState();
}

class _BannerCarouselState extends ConsumerState<BannerCarousel> {
  final _controller = PageController(viewportFraction: 0.92);
  int _index = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final banners = widget.banners;
    if (banners.isEmpty) return const SizedBox.shrink();
    final width = MediaQuery.sizeOf(context).width;
    return Column(
      children: [
        SizedBox(
          height: (width * 0.92 - KapdhSpace.s2) / 2.2,
          child: PageView.builder(
            key: const ValueKey('home-banners'),
            controller: _controller,
            itemCount: banners.length,
            onPageChanged: (index) => setState(() => _index = index),
            itemBuilder: (context, index) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s1),
              child: _BannerTile(
                banner: banners[index],
                position: '${index + 1} dari ${banners.length}',
                onTap: () => unawaited(openBannerTarget(context, ref, banners[index].target)),
              ),
            ),
          ),
        ),
        if (banners.length > 1) ...[
          const SizedBox(height: KapdhSpace.s2),
          ExcludeSemantics(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < banners.length; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    width: i == _index ? 18 : 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: i == _index ? KapdhColors.primary : KapdhColors.neutral300,
                      borderRadius: BorderRadius.circular(KapdhRadius.pill),
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

class _BannerTile extends StatelessWidget {
  const _BannerTile({required this.banner, required this.position, required this.onTap});

  final HomeBanner banner;
  final String position;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final target = banner.target;
    final tappable = target.type != BannerTargetType.none;
    final external = target.type == BannerTargetType.url || target.external;
    final hint = !tappable
        ? null
        : external
        ? 'membuka tautan luar'
        : (target.available ? 'membuka detail' : 'konten tidak tersedia');
    final radius = BorderRadius.circular(KapdhRadius.lg);
    return Semantics(
      container: true,
      button: tappable,
      label: 'Banner $position: ${banner.title}',
      hint: hint,
      excludeSemantics: true,
      onTap: tappable ? onTap : null,
      child: Material(
        shape: RoundedRectangleBorder(borderRadius: radius),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: tappable ? onTap : null,
          child: Stack(
            fit: StackFit.expand,
            children: [
              RemoteImage(url: banner.imageUrl, placeholderIcon: Icons.campaign_outlined),
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Color(0x00000000), Color(0xB3000000)],
                    stops: [0.45, 1],
                  ),
                ),
              ),
              Positioned(
                left: KapdhSpace.s3,
                right: KapdhSpace.s3,
                bottom: KapdhSpace.s3,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: Text(
                        banner.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: KapdhColors.textOnDark,
                          fontWeight: FontWeight.w600,
                          fontSize: KapdhFontSize.body,
                        ),
                      ),
                    ),
                    if (external) ...[const SizedBox(width: KapdhSpace.s2), const _ExternalPill()],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Penanda "Tautan luar" pada banner bertarget url (PRD 3.8).
class _ExternalPill extends StatelessWidget {
  const _ExternalPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s2, vertical: 2),
      decoration: BoxDecoration(color: KapdhColors.surface, borderRadius: BorderRadius.circular(KapdhRadius.pill)),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Tautan luar',
            style: TextStyle(fontSize: KapdhFontSize.overline, fontWeight: FontWeight.w600, color: KapdhColors.primary),
          ),
          SizedBox(width: 2),
          Icon(Icons.open_in_new, size: 12, color: KapdhColors.primary),
        ],
      ),
    );
  }
}
