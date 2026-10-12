import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../core/app_gate/app_gate.dart';
import '../core/session/session_controller.dart';
import '../design/design.dart';
import 'redirect.dart';
import 'routes.dart';
import 'theme/kapdh_tokens.dart';

/// Satu tab navigasi bawah.
@immutable
class ShellTab {
  const ShellTab({required this.label, required this.icon, required this.selectedIcon, required this.location});

  final String label;
  final IconData icon;
  final IconData selectedIcon;
  final String location;
}

/// Cangkang navigasi bawah (ARCHITECTURE §8.4; guideline hal. 7): Beranda, Event, KTA, Jejaring, Akun. Tab yang
/// belum boleh dibuka status anggota (PRD 2.2) tetap terlihat dengan ikon gembok dan menjelaskan cara membukanya,
/// bukan menghilang diam-diam. Status offline ditampilkan di atas navigasi.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  static const tabs = [
    ShellTab(label: 'Beranda', icon: Icons.home_outlined, selectedIcon: Icons.home, location: AppRoutes.home),
    ShellTab(label: 'Event', icon: Icons.event_outlined, selectedIcon: Icons.event, location: AppRoutes.events),
    ShellTab(label: 'KTA', icon: Icons.badge_outlined, selectedIcon: Icons.badge, location: AppRoutes.kta),
    ShellTab(label: 'Jejaring', icon: Icons.school_outlined, selectedIcon: Icons.school, location: AppRoutes.network),
    ShellTab(label: 'Akun', icon: Icons.person_outline, selectedIcon: Icons.person, location: AppRoutes.account),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final gate = ref.watch(appGateProvider).status;
    final redirectState = RedirectState(gate: gate, session: session);
    final locked = [for (final tab in tabs) !isLocationAllowed(redirectState, tab.location)];

    return Scaffold(
      body: Column(
        children: [
          Expanded(child: navigationShell),
          if (session.isOffline)
            OfflineBanner(
              syncedAt: session.syncedAt,
              onRetry: () => ref.read(sessionProvider.notifier).refreshQuietly(),
            ),
        ],
      ),
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: KapdhColors.divider)),
        ),
        child: NavigationBar(
          selectedIndex: navigationShell.currentIndex,
          labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
          onDestinationSelected: (index) {
            if (locked[index]) {
              showLockedTabSheet(context, tab: tabs[index], status: session.effectiveStatus);
              return;
            }
            navigationShell.goBranch(index, initialLocation: index == navigationShell.currentIndex);
          },
          destinations: [
            for (var i = 0; i < tabs.length; i++)
              NavigationDestination(
                tooltip: locked[i] ? '${tabs[i].label}, terkunci' : tabs[i].label,
                label: tabs[i].label,
                icon: _TabIcon(icon: tabs[i].icon, locked: locked[i]),
                selectedIcon: _TabIcon(icon: tabs[i].selectedIcon, locked: locked[i]),
              ),
          ],
        ),
      ),
    );
  }
}

class _TabIcon extends StatelessWidget {
  const _TabIcon({required this.icon, required this.locked});

  final IconData icon;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    if (!locked) return Icon(icon);
    return Badge(
      backgroundColor: KapdhColors.neutral,
      padding: const EdgeInsets.all(2),
      label: const Icon(Icons.lock, size: 10, color: KapdhColors.onPrimary),
      child: Icon(icon),
    );
  }
}

/// Lembar penjelasan tab terkunci dengan ajakan sesuai status (bayar iuran atau perpanjang; PRD 2.2).
Future<void> showLockedTabSheet(BuildContext context, {required ShellTab tab, required EffectiveStatus? status}) {
  final (String message, String? actionLabel, String? actionLocation) = switch (status) {
    EffectiveStatus.unverified => (
      '${tab.label} terbuka setelah KTA aktif. Selesaikan iuran pendaftaran agar pengurus dapat memverifikasi '
          'keanggotaan Anda.',
      'Bayar iuran',
      AppRoutes.onboardingFees,
    ),
    EffectiveStatus.expired => (
      '${tab.label} hanya untuk anggota aktif. Perpanjang KTA untuk membuka kembali fitur ini. Tiket yang sudah '
          'lunas tetap dapat dilihat di menu Akun.',
      'Perpanjang KTA',
      AppRoutes.renewal,
    ),
    _ => ('${tab.label} belum tersedia untuk status akun Anda.', null, null),
  };
  final router = GoRouter.of(context);
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    // Tinggi mengikuti isi dan dapat digulir saat teks diperbesar (N-11).
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, 0, KapdhSpace.s5, KapdhSpace.s5),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StatusHero(
              status: status == null
                  ? StatusStyles.membership(EffectiveStatus.unknown)
                  : StatusStyles.membership(status),
              icon: Icons.lock_outline,
              title: '${tab.label} terkunci',
              message: message,
            ),
            const SizedBox(height: KapdhSpace.s5),
            if (actionLabel != null && actionLocation != null)
              KapdhButton(
                label: actionLabel,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  router.go(actionLocation);
                },
              ),
            const SizedBox(height: KapdhSpace.s2),
            TextButton(onPressed: () => Navigator.of(sheetContext).pop(), child: const Text('Tutup')),
          ],
        ),
      ),
    ),
  );
}
