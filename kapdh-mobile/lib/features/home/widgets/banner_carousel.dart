import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/theme/kapdh_focus.dart';
import '../../../app/theme/kapdh_palette.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../shared/links.dart';
import '../shared/remote_image.dart';
import '../../../design/kapdh_icons.dart';

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
      await confirmAndLaunchExternal(context, ref, uri);
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

/// Rasio tampil gambar banner (lebar : tinggi), sama dengan ukuran berkas yang disarankan 1760 x 800 px
/// (docs/konten/konten-peluncuran.md). Ubin banner tepat berasio ini sehingga gambar 2,2:1 tampil utuh.
const double bannerAspectRatio = 2.2;

/// Bagian lebar karosel yang dipakai satu halaman banner; sisanya mengintip banner berikutnya.
const double bannerViewportFraction = 0.92;

/// Karosel banner aktif Beranda (PRD 3.8): geser manual (tanpa putar otomatis agar dapat dibaca pembaca layar dan
/// tidak bergerak sendiri, N-11), titik penanda posisi, judul sebagai label gambar.
/// [v2] Karena tanpa putar otomatis, reduce motion cukup mematikan animasi perpindahan halaman dan titik.
class BannerCarousel extends ConsumerStatefulWidget {
  const BannerCarousel({super.key, required this.banners});

  final List<HomeBanner> banners;

  @override
  ConsumerState<BannerCarousel> createState() => _BannerCarouselState();
}

class _BannerCarouselState extends ConsumerState<BannerCarousel> {
  final _controller = PageController(viewportFraction: bannerViewportFraction);
  int _index = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// [v2] Membawa halaman [index] tepat ke posisinya (mis. ubin terfokus keyboard yang setengah di luar layar):
  /// kurva easeOut 250 ms, atau lompat langsung saat reduce motion.
  void _showPage(int index) {
    if (!_controller.hasClients) return;
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      _controller.jumpToPage(index);
    } else {
      unawaited(_controller.animateToPage(index, duration: KapdhMotion.base, curve: KapdhMotion.easeOut));
    }
  }

  @override
  Widget build(BuildContext context) {
    final banners = widget.banners;
    if (banners.isEmpty) return const SizedBox.shrink();
    return LayoutBuilder(
      builder: (context, constraints) {
        // Tinggi dihitung dari lebar ubin yang sebenarnya, bukan lebar layar: Beranda memberi padding samping, dan
        // setiap halaman PageView selebar [bannerViewportFraction] dari karosel dikurangi padding s1 kiri-kanan.
        // Dengan lebar layar, ubin lebih pendek dari 2,2:1 sehingga BoxFit.cover memotong sisi kiri-kanan gambar.
        final available = constraints.hasBoundedWidth ? constraints.maxWidth : MediaQuery.sizeOf(context).width;
        final tileWidth = available * bannerViewportFraction - 2 * KapdhSpace.s1;
        return _carousel(banners, height: tileWidth / bannerAspectRatio, available: available);
      },
    );
  }

  Widget _carousel(List<HomeBanner> banners, {required double height, required double available}) {
    // [v2] Titik halaman di dalam banner (kanan bawah ubin aktif): nonaktif putih 60 %, aktif emas melebar 250 ms.
    final dotsRight = available * (1 - bannerViewportFraction) / 2 + KapdhSpace.s1 + KapdhSpace.s3;
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return Stack(
      children: [
        SizedBox(
          height: height,
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
                onFocused: () => _showPage(index),
              ),
            ),
          ),
        ),
        if (banners.length > 1)
          Positioned(
            right: dotsRight,
            bottom: KapdhSpace.s3,
            child: ExcludeSemantics(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var i = 0; i < banners.length; i++)
                    AnimatedContainer(
                      // [v2] Tanpa animasi saat reduce motion.
                      duration: reduceMotion ? Duration.zero : KapdhMotion.base,
                      curve: KapdhMotion.easeOut,
                      margin: const EdgeInsets.symmetric(horizontal: 3),
                      width: i == _index ? 18 : 6,
                      height: 6,
                      decoration: BoxDecoration(
                        color: i == _index ? KapdhColors.accent : const Color(0x99FFFFFF),
                        borderRadius: BorderRadius.circular(KapdhRadius.pill),
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _BannerTile extends StatelessWidget {
  const _BannerTile({required this.banner, required this.position, required this.onTap, required this.onFocused});

  final HomeBanner banner;
  final String position;
  final VoidCallback onTap;

  /// Dipanggil saat ubin menerima fokus keyboard/akses saklar.
  final VoidCallback onFocused;

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
      // [v2] Cincin fokus 3 px di atas ubin (WCAG 1.4.11), mengikuti fokus InkWell: ubin tanpa target tidak dapat
      // difokus, kecuali pada navigasi arah (D-pad) yang memang memfokus InkWell nonaktif dan menyorotnya.
      child: KapdhFocusRing(
        radius: radius,
        builder: (onFocusChange) => DecoratedBox(
          // [v2] Bayangan --shadow-sm dan latar tint selama gambar dimuat.
          decoration: BoxDecoration(borderRadius: radius, boxShadow: context.kc.shadowSm),
          child: Material(
            color: context.kc.tint,
            shape: RoundedRectangleBorder(borderRadius: radius),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              fit: StackFit.expand,
              children: [
                RemoteImage(url: banner.imageUrl, placeholderIcon: KapdhIcons.campaignOutlined),
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
                  // Ruang kanan untuk titik halaman.
                  right: 52,
                  bottom: KapdhSpace.s3,
                  child: MediaQuery.withClampedTextScaling(
                    // Keterangan di atas gambar berasio tetap: judul dan pil 'Tautan luar' dibatasi 1,3 bersama (N-11).
                    maxScaleFactor: 1.3,
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
                              fontWeight: FontWeight.w700,
                              height: 1.35,
                              fontSize: KapdhFontSize.body,
                            ),
                          ),
                        ),
                        if (external) ...[const SizedBox(width: KapdhSpace.s2), const _ExternalPill()],
                      ],
                    ),
                  ),
                ),
                // Lapisan tinta di atas gambar agar ripple tekan dan sorotan fokus keyboard terlihat.
                Positioned.fill(
                  child: Material(
                    type: MaterialType.transparency,
                    child: InkWell(
                      onTap: tappable ? onTap : null,
                      // [v2] Fokus menyalakan cincin dan membawa halaman ubin ini ke posisinya.
                      onFocusChange: (focused) {
                        onFocusChange(focused);
                        if (focused) onFocused();
                      },
                    ),
                  ),
                ),
              ],
            ),
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
      decoration: BoxDecoration(color: context.kc.surface, borderRadius: BorderRadius.circular(KapdhRadius.pill)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Tautan luar',
            style: TextStyle(fontSize: KapdhFontSize.overline, fontWeight: FontWeight.w600, color: context.kc.primary),
          ),
          const SizedBox(width: 2),
          Icon(KapdhIcons.openInNew, size: 12, color: context.kc.primary),
        ],
      ),
    );
  }
}
