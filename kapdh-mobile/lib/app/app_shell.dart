import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../core/app_gate/app_gate.dart';
import '../core/session/session_controller.dart';
import '../design/design.dart';
import '../features/chat/chat_list_controller.dart';
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
/// bukan menghilang diam-diam. Pita Offline/Pemeliharaan ditampilkan tiap layar tepat di bawah app bar
/// (AppStatusBanners + AppScaffold), bukan di cangkang.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  static const tabs = [
    ShellTab(label: 'Beranda', icon: KapdhIcons.homeOutlined, selectedIcon: KapdhIcons.home, location: AppRoutes.home),
    ShellTab(
      label: 'Event',
      icon: KapdhIcons.eventOutlined,
      selectedIcon: KapdhIcons.event,
      location: AppRoutes.events,
    ),
    ShellTab(label: 'KTA', icon: KapdhIcons.badgeOutlined, selectedIcon: KapdhIcons.badge, location: AppRoutes.kta),
    ShellTab(
      label: 'Jejaring',
      icon: KapdhIcons.schoolOutlined,
      selectedIcon: KapdhIcons.school,
      location: AppRoutes.network,
    ),
    ShellTab(
      label: 'Akun',
      icon: KapdhIcons.personOutline,
      selectedIcon: KapdhIcons.person,
      location: AppRoutes.account,
    ),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final gate = ref.watch(appGateProvider).status;
    final redirectState = RedirectState(gate: gate, session: session);
    final locked = [for (final tab in tabs) !isLocationAllowed(redirectState, tab.location)];
    // Lencana tab Jejaring: room berpesan belum dibaca + undangan grup tertunda (chat.yaml ChatRoomPage, F-11).
    final chatBadge = ref.watch(chatBadgeCountsProvider);
    int badgeOf(int index) => tabs[index].location == AppRoutes.network && !locked[index] ? chatBadge.total : 0;
    String tooltipOf(int index) {
      final tab = tabs[index];
      if (locked[index]) return '${tab.label}, terkunci';
      if (badgeOf(index) == 0) return tab.label;
      return [
        tab.label,
        if (chatBadge.unreadRooms > 0) '${chatBadge.unreadRooms} percakapan belum dibaca',
        if (chatBadge.pendingInvitations > 0) '${chatBadge.pendingInvitations} undangan grup',
      ].join(', ');
    }

    return Scaffold(
      body: navigationShell,
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
                tooltip: tooltipOf(i),
                label: tabs[i].label,
                icon: _TabIcon(icon: tabs[i].icon, locked: locked[i], count: badgeOf(i)),
                selectedIcon: _TabIcon(icon: tabs[i].selectedIcon, locked: locked[i], count: badgeOf(i)),
              ),
          ],
        ),
      ),
    );
  }
}

class _TabIcon extends StatelessWidget {
  const _TabIcon({required this.icon, required this.locked, this.count = 0});

  final IconData icon;
  final bool locked;

  /// Angka lencana (0 = tanpa lencana); dibacakan lewat tooltip tujuan navigasi.
  final int count;

  @override
  Widget build(BuildContext context) {
    if (!locked && count > 0) {
      return Badge(backgroundColor: KapdhColors.primary, label: Text(count > 99 ? '99+' : '$count'), child: Icon(icon));
    }
    if (!locked) return Icon(icon);
    return Badge(
      backgroundColor: KapdhColors.neutral,
      padding: const EdgeInsets.all(2),
      label: const Icon(KapdhIcons.lock, size: 10, color: KapdhColors.onPrimary),
      child: Icon(icon),
    );
  }
}

/// Lembar penjelasan tab terkunci dengan ajakan sesuai status (bayar iuran atau perpanjang; PRD 2.2). Untuk tab
/// Event, anggota expired juga diarahkan ke Tiket Saya: tiket yang sudah lunas tetap berlaku (PRD 2.2).
Future<void> showLockedTabSheet(BuildContext context, {required ShellTab tab, required EffectiveStatus? status}) {
  final showTickets = status == EffectiveStatus.expired && tab.location == AppRoutes.events;
  final (String message, String? actionLabel, String? actionLocation) = switch (status) {
    EffectiveStatus.unverified => (
      '${tab.label} terbuka setelah KTA aktif. Selesaikan iuran pendaftaran agar pengurus dapat memverifikasi '
          'keanggotaan Anda.',
      'Bayar iuran',
      AppRoutes.onboardingFees,
    ),
    EffectiveStatus.expired => (
      '${tab.label} hanya untuk anggota aktif. Perpanjang KTA untuk membuka kembali fitur ini.'
          '${showTickets ? ' Tiket yang sudah lunas tetap dapat dibuka di Tiket Saya.' : ''}',
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
              icon: KapdhIcons.lockOutline,
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
            if (showTickets) ...[
              const SizedBox(height: KapdhSpace.s2),
              KapdhButton.outlined(
                key: const ValueKey('locked-tab-tickets'),
                label: 'Lihat Tiket Saya',
                icon: KapdhIcons.confirmationNumberOutlined,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(router.push(AppRoutes.tickets));
                },
              ),
            ],
            const SizedBox(height: KapdhSpace.s2),
            TextButton(onPressed: () => Navigator.of(sheetContext).pop(), child: const Text('Tutup')),
          ],
        ),
      ),
    ),
  );
}
