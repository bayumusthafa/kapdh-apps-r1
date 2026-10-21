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
import 'theme/kapdh_focus.dart';
import 'theme/kapdh_palette.dart';
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
      if (locked[index]) return '${tab.label}, khusus anggota aktif';
      if (badgeOf(index) == 0) return tab.label;
      return [
        tab.label,
        if (chatBadge.unreadRooms > 0) '${chatBadge.unreadRooms} percakapan belum dibaca',
        if (chatBadge.pendingInvitations > 0) '${chatBadge.pendingInvitations} undangan grup',
      ].join(', ');
    }

    final p = context.kc;
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return Scaffold(
      body: navigationShell,
      // [v2] Garis rambut + bayangan ke atas (--shadow-bar-top): isi gulir tidak lagi menyatu dengan navigasi. Skala
      // label dibatasi 1,3 agar lima label tidak bertabrakan pada teks 200 % (N-11; ikon tetap 24). Container (bukan
      // DecoratedBox) agar lebar border menjadi padding: NavigationBar dimulai di bawah garis 1 px, tidak menimpanya.
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: p.surface,
          border: Border(top: BorderSide(color: p.divider)),
          boxShadow: p.shadowBarTop,
        ),
        child: MediaQuery.withClampedTextScaling(
          maxScaleFactor: 1.3,
          child: NavigationBar(
            // [v2] Indikator dan ikon terpilih berpindah dalam --dur-base 250 ms (bawaan SDK 500 ms); seketika saat
            // reduce motion.
            animationDuration: reduceMotion ? Duration.zero : KapdhMotion.base,
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
                if (tabs[i].location == AppRoutes.kta)
                  // [v2 Beranda] KTA sebagai tombol tengah menonjol: indikator pil dimatikan hanya untuk tujuan ini,
                  // ikon digambar sebagai kotak 56 bergradasi yang naik di atas bilah (kolom tab tetap 64 tinggi).
                  NavigationBarTheme(
                    data: NavigationBarTheme.of(context).copyWith(
                      indicatorColor: Colors.transparent,
                      labelTextStyle: WidgetStateProperty.resolveWith(
                        (states) => TextStyle(
                          fontSize: KapdhFontSize.caption,
                          fontWeight: states.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w600,
                          color: p.primary,
                        ),
                      ),
                    ),
                    child: NavigationDestination(
                      tooltip: tooltipOf(i),
                      label: tabs[i].label,
                      icon: _KtaTabIcon(icon: tabs[i].icon, selected: false, locked: locked[i]),
                      selectedIcon: _KtaTabIcon(icon: tabs[i].selectedIcon, selected: true, locked: locked[i]),
                    ),
                  )
                else
                  NavigationDestination(
                    tooltip: tooltipOf(i),
                    label: tabs[i].label,
                    icon: _TabIcon(icon: tabs[i].icon, locked: locked[i], count: badgeOf(i)),
                    selectedIcon: _TabIcon(icon: tabs[i].selectedIcon, locked: locked[i], count: badgeOf(i)),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Tombol tengah KTA (Beranda v2): kotak 56 radius 16 bergradasi green800 -> green600, garis permukaan 4 dan bayangan
/// hijau, naik 20 dp di atas bilah. Terpilih: isi emas, ikon gelap dan cincin primary 2 px (11:1 terhadap bilah)
/// sehingga keadaan terpilih tidak hanya dibedakan warna lemah. Ikon KTA selalu fill. Terfokus: cincin fokus 3 px.
class _KtaTabIcon extends StatelessWidget {
  const _KtaTabIcon({required this.icon, required this.selected, required this.locked});

  final IconData icon;
  final bool selected;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final p = context.kc;
    // [v2] Kotak 56 menutupi sorotan fokus bawaan tujuan (indikator dimatikan), jadi cincin fokus 3 px (WCAG 1.4.11)
    // digambar di kotak ini saat InkWell tujuan, Focus leluhur terdekat, terfokus keyboard/akses saklar. Focus.maybeOf
    // memasang dependensi sehingga ikon dibangun ulang tiap fokus berubah. Lapisan foreground selalu ada (kosong saat
    // tidak fokus, seperti KapdhFocusRing) agar subpohon kotak tidak dipasang ulang tiap fokus berpindah.
    final focused =
        (Focus.maybeOf(context)?.hasFocus ?? false) &&
        FocusManager.instance.highlightMode == FocusHighlightMode.traditional;
    final radius = BorderRadius.circular(KapdhRadius.lg);
    final box = Container(
      width: 56,
      height: 56,
      foregroundDecoration: focused
          ? BoxDecoration(
              border: Border.all(color: KapdhFocusTheme.ringOf(context), width: KapdhFocusTheme.width),
              borderRadius: radius,
            )
          : const BoxDecoration(),
      decoration: BoxDecoration(
        borderRadius: radius,
        gradient: selected
            ? null
            : const LinearGradient(
                begin: Alignment.bottomLeft,
                end: Alignment.topRight,
                colors: [KapdhColors.green800, KapdhColors.green600],
              ),
        color: selected ? KapdhColors.accent : null,
        border: Border.all(color: p.surface, width: 4),
        boxShadow: [
          if (selected) BoxShadow(color: p.primary, spreadRadius: 2),
          const BoxShadow(offset: Offset(0, 8), blurRadius: 18, spreadRadius: -4, color: Color(0x731A4B17)),
        ],
      ),
      child: Icon(KapdhIcons.badge, color: selected ? KapdhColors.onAccent : KapdhColors.onPrimary),
    );
    // Ukuran tata letak tetap 24 x 24 (seperti ikon tab lain) agar label KTA sejajar; kotak 56 digambar meluap ke atas.
    return SizedBox(
      width: 24,
      height: 24,
      child: OverflowBox(
        maxWidth: 64,
        maxHeight: 64,
        child: Transform.translate(
          offset: const Offset(0, -16),
          child: locked
              ? Badge(
                  backgroundColor: p.neutral,
                  padding: const EdgeInsets.all(2),
                  label: Icon(KapdhIcons.lock, size: 10, color: context.kc.surface),
                  child: box,
                )
              : box,
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
      return Badge(
        backgroundColor: context.kc.primary,
        textColor: context.kc.onPrimary,
        label: Text(count > 99 ? '99+' : '$count'),
        child: Icon(icon),
      );
    }
    if (!locked) return Icon(icon);
    return Badge(
      backgroundColor: context.kc.neutral,
      padding: const EdgeInsets.all(2),
      label: Icon(KapdhIcons.lock, size: 10, color: context.kc.surface),
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
      '${tab.label} adalah layanan untuk anggota terverifikasi. Status keanggotaan diperbarui pengurus setelah '
          'iuran pendaftaran organisasi diverifikasi.',
      'Bayar iuran',
      AppRoutes.onboardingFees,
    ),
    EffectiveStatus.expired => (
      '${tab.label} adalah layanan untuk anggota aktif. Masa keanggotaan Anda berakhir; hubungi pengurus atau '
          'perpanjang keanggotaan organisasi.'
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
    // [v2] Lembar masuk dalam --dur-base 250 ms; keluar dulu 200 ms bawaan SDK, tidak ada token 200, pakai fast
    // (150 ms). Tanpa geser saat reduce motion.
    sheetAnimationStyle: (MediaQuery.maybeDisableAnimationsOf(context) ?? false)
        ? AnimationStyle.noAnimation
        : const AnimationStyle(duration: KapdhMotion.base, reverseDuration: KapdhMotion.fast),
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
              title: '${tab.label} khusus anggota aktif',
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
