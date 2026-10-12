import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../app/theme/kapdh_tokens.dart';

/// Kerangka layar dalam aplikasi (prototipe layar 6, 7; guideline hal. 6): app bar putih 56 px bergaris bawah,
/// judul di tengah, tombol kembali 48 px, pita opsional (mis. OfflineBanner) di bawah app bar.
class AppScaffold extends StatelessWidget {
  const AppScaffold({
    super.key,
    required this.title,
    required this.body,
    this.showBack = true,
    this.fallbackLocation = '/',
    this.actions,
    this.banner,
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

  /// Ditampilkan tepat di bawah app bar dan tidak ikut bergulir.
  final Widget? banner;
  final Widget? bottomNavigationBar;
  final Widget? floatingActionButton;
  final Color backgroundColor;

  void _back(BuildContext context) {
    final router = GoRouter.maybeOf(context);
    if (router != null) {
      if (router.canPop()) {
        router.pop();
      } else {
        router.go(fallbackLocation);
      }
      return;
    }
    Navigator.maybePop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: backgroundColor,
      appBar: AppBar(
        title: Semantics(header: true, child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis)),
        automaticallyImplyLeading: false,
        leading: showBack
            ? IconButton(
                tooltip: 'Kembali',
                icon: const Icon(Icons.chevron_left, size: 28),
                onPressed: () => _back(context),
              )
            : null,
        actions: actions,
        bottom: const PreferredSize(preferredSize: Size.fromHeight(1), child: Divider(height: 1)),
      ),
      body: banner == null
          ? body
          : Column(
              children: [
                banner!,
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
