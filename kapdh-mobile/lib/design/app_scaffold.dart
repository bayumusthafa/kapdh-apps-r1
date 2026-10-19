import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../app/theme/kapdh_palette.dart';
import '../app/theme/kapdh_tokens.dart';
import '../core/ui/back_navigation.dart';
import 'kapdh_icons.dart';

/// Pita status global (Offline, Pemeliharaan) yang dipasang aplikasi di atas Navigator (`MaterialApp.builder`).
///
/// Setiap [AppScaffold] menampilkannya tepat di bawah app bar, sesuai prototipe layar 7, sehingga semua layar
/// dalam aplikasi (tab shell maupun detail) memakai posisi yang sama dan tidak ada pita ganda. Layar yang tidak
/// memakai [AppScaffold] (mis. beranda dengan kepala sapaan) menampilkan [AppBannerScope.of] sendiri di bawah
/// kepalanya.
class AppBannerScope extends InheritedWidget {
  const AppBannerScope({super.key, required this.banner, required super.child});

  /// Pita yang berlaku saat ini; null bila tidak ada.
  final Widget? banner;

  static Widget? of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppBannerScope>()?.banner;

  @override
  bool updateShouldNotify(AppBannerScope oldWidget) => oldWidget.banner != banner;
}

/// Kerangka layar dalam aplikasi (prototipe layar 6, 7; guideline hal. 6): app bar putih 56 px bergaris bawah,
/// judul di tengah, tombol kembali panah kiri 48 px, pita di bawah app bar: [banner] milik layar atau pita global
/// [AppBannerScope] (Offline/Pemeliharaan).
class AppScaffold extends StatelessWidget {
  const AppScaffold({
    super.key,
    required this.title,
    required this.body,
    this.showBack = true,
    this.fallbackLocation = '/',
    this.actions,
    this.banner,
    this.header,
    this.showGlobalBanner = true,
    this.bottomNavigationBar,
    this.floatingActionButton,
    this.backgroundColor,
  });

  final String title;
  final Widget body;

  /// Bilah selebar layar di bawah app bar dan pita global, di atas isi (mis. TabBar). Tidak ikut dibatasi
  /// [ContentWidth] di tablet.
  final Widget? header;

  /// Tampilkan tombol kembali; bila tidak ada halaman sebelumnya, kembali ke [fallbackLocation].
  final bool showBack;
  final String fallbackLocation;
  final List<Widget>? actions;

  /// Ditampilkan tepat di bawah app bar dan tidak ikut bergulir. Bila diisi, menggantikan pita global (layar yang
  /// memberi pita Offline sendiri, mis. KTA dengan waktu sinkron kartu, tidak menampilkan dua pita).
  final Widget? banner;

  /// Tampilkan pita global [AppBannerScope] bila [banner] kosong.
  final bool showGlobalBanner;
  final Widget? bottomNavigationBar;
  final Widget? floatingActionButton;

  /// Bawaan latar palet aktif (terang/gelap).
  final Color? backgroundColor;

  /// Sama dengan tombol kembali sistem: `PopScope` halaman (mis. "Buang perubahan?" di Ubah Profil) dihormati,
  /// tidak dilewati seperti `GoRouter.pop`, sehingga isian formulir tidak hilang diam-diam (PRD 4.5). Bila tidak ada
  /// halaman yang dapat ditutup, kembali ke [fallbackLocation].
  ///
  /// Bila halaman benar-benar tertutup (bukan ditahan `PopScope`), lokasi baru dilewatkan lagi ke redirect seperti
  /// `GoRouter.pop`: halaman di bawahnya yang tidak diizinkan matriks rute untuk status sekarang (mis. daftar event
  /// bagi anggota expired yang membuka detail event lewat deep link, PRD 2.2) diganti rute status, tanpa request ke
  /// layar yang terlarang. Aturan yang sama ([popThenRedirect]) dipakai tombol kembali sistem aplikasi.
  Future<void> _back(BuildContext context) async {
    final router = GoRouter.maybeOf(context);
    if (router == null) {
      await Navigator.maybePop(context);
      return;
    }
    final handled = await popThenRedirect(router, router.routerDelegate.popRoute);
    if (!handled) router.go(fallbackLocation);
  }

  @override
  Widget build(BuildContext context) {
    final effectiveBanner = banner ?? (showGlobalBanner ? AppBannerScope.of(context) : null);
    return Scaffold(
      backgroundColor: backgroundColor ?? context.kc.background,
      appBar: AppBar(
        title: Semantics(header: true, child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis)),
        automaticallyImplyLeading: false,
        leading: showBack
            ? IconButton(
                tooltip: 'Kembali',
                // Panah kiri di app bar (prototipe layar 6, 7; guideline hal. 6). Chevron hanya untuk baris judul di
                // dalam lembar (prototipe layar 1, 3).
                icon: const Icon(KapdhIcons.arrowBack, size: KapdhIconSize.lg),
                onPressed: () => unawaited(_back(context)),
              )
            : null,
        actions: actions,
        bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1)),
      ),
      body: effectiveBanner == null && header == null
          ? ContentWidth(child: body)
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ?effectiveBanner,
                ?header,
                Expanded(child: ContentWidth(child: body)),
              ],
            ),
      bottomNavigationBar: bottomNavigationBar,
      floatingActionButton: floatingActionButton,
    );
  }
}

/// Judul bagian dengan aksi opsional di kanan (mis. "Riwayat", "Lihat semua"). Judul dan aksi sebaris bila muat; bila
/// tidak (teks besar di layar sempit, N-11), aksi turun ke bawah judul alih-alih meluap.
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.title, this.actionLabel, this.onAction});

  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    // OverflowBar (sejalan dengan HomeSectionTitle): bila muat, judul kiri dan aksi kanan sebaris, tengah vertikal;
    // bila tidak, aksi turun ke bawah judul, rata kiri. Tanpa celah tambahan, seperti Row v2 (padding tombol sudah
    // memberi jarak), agar ambang sebaris tidak bergeser di teks normal. Target sentuh 48 dari textButtonTheme.
    return OverflowBar(
      alignment: MainAxisAlignment.spaceBetween,
      children: [
        Semantics(
          header: true,
          child: Text(
            title,
            style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w700), // [v2: dulu w600]
          ),
        ),
        if (actionLabel != null && onAction != null) TextButton(onPressed: onAction, child: Text(actionLabel!)),
      ],
    );
  }
}

/// Lebar isi maksimum di layar lebar/tablet (redesain v2, mockup `--content-max-w`): bila layar lebih lebar dari
/// [maxWidth] + gutter 2 x 20, isi dibatasi [maxWidth] di tengah (mengisi tinggi bila induk membatasi tinggi,
/// menyusut ke tinggi isi di dalam scroll view); latar, app bar dan navigasi tetap selebar layar. Di ponsel [child]
/// dikembalikan apa adanya sehingga tata letak tidak berubah.
class ContentWidth extends StatelessWidget {
  const ContentWidth({super.key, required this.child, this.maxWidth = maxContentWidth});

  /// Lebar baca maksimum isi layar (dp).
  static const double maxContentWidth = 600;

  final Widget child;
  final double maxWidth;

  /// Inset horizontal agar isi selebar [maxContentWidth] di tengah (untuk sliver/ListView yang tidak dapat dibungkus);
  /// di ponsel sama dengan [base].
  static double inset(BuildContext context, double base) {
    final width = MediaQuery.sizeOf(context).width;
    final centered = (width - maxContentWidth) / 2;
    return centered > base ? centered : base;
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    if (width <= maxWidth + 2 * KapdhSpace.s5) return child;
    return Align(
      alignment: Alignment.topCenter,
      heightFactor: 1,
      child: SizedBox(width: maxWidth, child: child),
    );
  }
}
