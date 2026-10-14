import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../app/theme/kapdh_tokens.dart';
import '../core/ui/back_navigation.dart';

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
    this.showGlobalBanner = true,
    this.bottomNavigationBar,
    this.floatingActionButton,
    this.backgroundColor = KapdhColors.background,
  });

  final String title;
  final Widget body;

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
  final Color backgroundColor;

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
      backgroundColor: backgroundColor,
      appBar: AppBar(
        title: Semantics(header: true, child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis)),
        automaticallyImplyLeading: false,
        leading: showBack
            ? IconButton(
                tooltip: 'Kembali',
                // Panah kiri di app bar (prototipe layar 6, 7; guideline hal. 6). Chevron hanya untuk baris judul di
                // dalam lembar (prototipe layar 1, 3).
                icon: const Icon(Icons.arrow_back, size: 24),
                onPressed: () => unawaited(_back(context)),
              )
            : null,
        actions: actions,
        bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1)),
      ),
      body: effectiveBanner == null
          ? body
          : Column(
              children: [
                effectiveBanner,
                Expanded(child: body),
              ],
            ),
      bottomNavigationBar: bottomNavigationBar,
      floatingActionButton: floatingActionButton,
    );
  }
}

/// Judul bagian dengan aksi opsional di kanan (mis. "Riwayat", "Lihat semua").
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.title, this.actionLabel, this.onAction});

  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: const TextStyle(fontSize: KapdhFontSize.body, fontWeight: FontWeight.w600),
            ),
          ),
        ),
        if (actionLabel != null && onAction != null) TextButton(onPressed: onAction, child: Text(actionLabel!)),
      ],
    );
  }
}
