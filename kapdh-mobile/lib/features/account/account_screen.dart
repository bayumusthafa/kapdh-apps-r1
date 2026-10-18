import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/app_shell.dart';
import '../../app/redirect.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import '../../design/design.dart';
import '../notifications/notification_unread_count.dart';
import 'widgets/account_section.dart';
import 'widgets/profile_avatar.dart';

/// Menu yang diizinkan status akun tetapi ditahan mode baca maintenance karena tujuannya hanya mutasi (ganti
/// password, hapus akun; PRD 4.5). Penjelasannya pemeliharaan, bukan status keanggotaan (PRD 2.2).
bool pausedByMaintenance(GateStatus gate, SessionState session, String location) =>
    gate == GateStatus.maintenance &&
    !isLocationAllowed(RedirectState(gate: gate, session: session), location) &&
    isLocationAllowed(RedirectState(gate: GateStatus.ok, session: session), location);

/// Tab Akun (PRD 4.6 "Flutter akun": inbox, preferensi, profil, sesi, legal, hapus akun; F-02, F-10, F-13, F-14).
///
/// Kartu ringkasan profil (guideline hal. 7: pita hijau bermotif, foto, nama, email, kota) dengan status KTA
/// berlabel, lalu menu. Menu yang belum tersedia untuk status anggota (PRD 2.2, mis. blokir/laporan untuk KTA
/// tidak aktif) tetap terlihat dengan gembok dan penjelasan; server tetap menegakkan izin di setiap endpoint.
/// Keluar menghapus token, cache KTA dan data akun privat di perangkat serta mencabut sesi dan token push perangkat
/// ini di server (PRD 5.2, AC F13-5).
class AccountScreen extends ConsumerStatefulWidget {
  const AccountScreen({super.key});

  @override
  ConsumerState<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends ConsumerState<AccountScreen> {
  bool _signingOut = false;

  Future<void> _signOut() async {
    // Keluar atas pilihan sendiri membuka login yang bersih (tanpa tujuan tertunda dari sesi sebelumnya).
    final router = GoRouter.of(context);
    setState(() => _signingOut = true);
    try {
      await ref.read(sessionProvider.notifier).logout();
      router.go(AppRoutes.login);
    } finally {
      if (mounted) setState(() => _signingOut = false);
    }
  }

  void _open(String location, {required String label, required IconData icon}) {
    final gate = ref.read(appGateProvider);
    final session = ref.read(sessionProvider);
    if (isLocationAllowed(RedirectState(gate: gate.status, session: session), location)) {
      unawaited(context.push(location));
      return;
    }
    if (pausedByMaintenance(gate.status, session, location)) {
      unawaited(_showMaintenanceSheet(location, label: label, gate: gate));
      return;
    }
    unawaited(
      showLockedTabSheet(
        context,
        tab: ShellTab(label: label, icon: icon, selectedIcon: icon, location: location),
        status: session.effectiveStatus,
      ),
    );
  }

  /// Menu yang status akunnya boleh dibuka tetapi ditahan mode baca maintenance (PRD 4.5): penjelasannya rentang
  /// estimasi, coba lagi dan kanal dukungan (layar maintenance), bukan penjelasan status keanggotaan.
  Future<void> _showMaintenanceSheet(String location, {required String label, required AppGateState gate}) {
    final router = GoRouter.of(context);
    final until = gate.maintenanceUntil;
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
                status: const StatusBadgeStyle(
                  label: 'Pemeliharaan',
                  icon: KapdhIcons.buildOutlined,
                  foreground: KapdhColors.warning,
                  background: KapdhColors.warningBg,
                ),
                icon: KapdhIcons.buildOutlined,
                title: '$label ditunda sementara',
                message:
                    '${gate.maintenanceMessage ?? 'Layanan sedang dalam pemeliharaan.'} Perubahan data belum dapat '
                    'disimpan sampai pemeliharaan selesai; data Anda aman.',
              ),
              const SizedBox(height: KapdhSpace.s4),
              InfoBox(
                icon: KapdhIcons.schedule,
                message: until != null
                    ? 'Perkiraan selesai: ${formatDateTime(until)}. Waktu dapat berubah.'
                    : 'Perkiraan waktu selesai belum tersedia. Silakan coba lagi beberapa saat lagi.',
              ),
              const SizedBox(height: KapdhSpace.s5),
              KapdhButton(
                key: const ValueKey('account-maintenance-details'),
                label: 'Coba lagi dan hubungi bantuan',
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  // Layar maintenance memeriksa ulang status layanan dan melanjutkan ke menu ini setelah selesai.
                  router.go(Uri(path: AppRoutes.maintenance, queryParameters: {'from': location}).toString());
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

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final gate = ref.watch(appGateProvider).status;
    final me = session.me;
    final unread = ref.watch(notificationUnreadCountProvider);
    final info = ref.watch(appInfoProvider);
    final redirectState = RedirectState(gate: gate, session: session);
    bool locked(String location) => !isLocationAllowed(redirectState, location);
    bool paused(String location) => pausedByMaintenance(gate, session, location);

    AccountMenuTile tile(String location, String label, IconData icon, {String? subtitle, String? badge}) =>
        AccountMenuTile(
          key: ValueKey('account-menu-$location'),
          icon: icon,
          label: label,
          subtitle: subtitle,
          badge: badge,
          locked: locked(location),
          paused: paused(location),
          onTap: () => _open(location, label: label, icon: icon),
        );

    AccountMenuTile legal(String slug, String label, IconData icon) => AccountMenuTile(
      key: ValueKey('account-legal-$slug'),
      icon: icon,
      label: label,
      onTap: () => context.push(AppRoutes.legal(slug)),
    );

    final banner = AppBannerScope.of(context);
    return Scaffold(
      backgroundColor: KapdhColors.background,
      // Menu pendek: dibangun sekaligus (bukan sliver malas) agar seluruh baris terjangkau pembaca layar.
      body: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Header(me: me),
            ?banner,
            Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AccountSection(
                    title: 'PROFIL',
                    children: [
                      tile(
                        AppRoutes.accountProfile,
                        'Ubah profil',
                        KapdhIcons.personOutline,
                        subtitle: 'Foto, kota, profesi, keahlian, kontak',
                      ),
                      tile(
                        AppRoutes.accountPrivacy,
                        'Privasi profil',
                        KapdhIcons.visibilityOutlined,
                        subtitle: 'Atur data yang terlihat anggota lain',
                      ),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'AKTIVITAS',
                    children: [
                      tile(
                        AppRoutes.notifications,
                        'Notifikasi',
                        KapdhIcons.notificationsOutlined,
                        subtitle: 'Kotak masuk resmi',
                        badge: unread != null && unread > 0 ? (unread > 99 ? '99+' : '$unread') : null,
                      ),
                      tile(AppRoutes.payments, 'Riwayat pembayaran', KapdhIcons.receiptLongOutlined),
                      tile(AppRoutes.tickets, 'Tiket saya', KapdhIcons.confirmationNumberOutlined),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'KEAMANAN DAN NOTIFIKASI',
                    children: [
                      tile(AppRoutes.accountNotifications, 'Preferensi notifikasi', KapdhIcons.tune),
                      tile(
                        AppRoutes.accountSessions,
                        'Sesi perangkat',
                        KapdhIcons.devicesOutlined,
                        subtitle: 'Perangkat yang masuk ke akun Anda',
                      ),
                      tile(AppRoutes.accountPassword, 'Ganti password', KapdhIcons.lockReset),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'KOMUNITAS',
                    children: [
                      tile(AppRoutes.accountBlocked, 'Anggota diblokir', KapdhIcons.block),
                      tile(AppRoutes.accountReports, 'Laporan saya', KapdhIcons.flagOutlined),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'INFORMASI',
                    children: [
                      legal(AppRoutes.privacySlug, 'Kebijakan privasi', KapdhIcons.privacyTipOutlined),
                      legal(AppRoutes.termsSlug, 'Ketentuan layanan', KapdhIcons.descriptionOutlined),
                      legal(AppRoutes.communitySlug, 'Ketentuan komunitas', KapdhIcons.gavelOutlined),
                      legal(AppRoutes.helpSlug, 'Bantuan', KapdhIcons.helpOutline),
                      legal(AppRoutes.aboutSlug, 'Tentang KAPDH', KapdhIcons.infoOutline),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'DATA AKUN',
                    children: [
                      AccountMenuTile(
                        key: const ValueKey('account-menu-delete'),
                        icon: KapdhIcons.deleteOutline,
                        label: 'Hapus akun',
                        subtitle: 'Hapus akun dan data pribadi Anda',
                        danger: true,
                        paused: paused(AppRoutes.accountDelete),
                        onTap: () => _open(AppRoutes.accountDelete, label: 'Hapus akun', icon: KapdhIcons.delete),
                      ),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s6),
                  KapdhButton.outlined(
                    key: const ValueKey('account-logout'),
                    label: 'Keluar',
                    busyLabel: 'Keluar...',
                    busy: _signingOut,
                    icon: KapdhIcons.logout,
                    onPressed: _signOut,
                  ),
                  const SizedBox(height: KapdhSpace.s4),
                  Text(
                    'KAPDH Apps versi ${info.version} (${info.buildNumber})',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Pita hijau bermotif dengan kartu ringkasan profil (guideline hal. 7).
class _Header extends StatelessWidget {
  const _Header({required this.me});

  final Me? me;

  @override
  Widget build(BuildContext context) {
    final me = this.me;
    final profile = me?.profile;
    final name = profile?.fullName ?? 'Anggota KAPDH';
    final subtitleParts = [?me?.cohortCode, if (profile?.city case final city? when city.isNotEmpty) city];
    return Stack(
      children: [
        const Positioned.fill(bottom: 56, child: BrandHeader(includeTopInset: true)),
        SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s4, KapdhSpace.s5, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  header: true,
                  child: const Text(
                    'Akun',
                    style: TextStyle(
                      fontSize: KapdhFontSize.h3,
                      fontWeight: FontWeight.w600,
                      color: KapdhColors.textOnDark,
                    ),
                  ),
                ),
                const SizedBox(height: KapdhSpace.s4),
                Container(
                  padding: const EdgeInsets.all(KapdhSpace.s4),
                  decoration: BoxDecoration(
                    color: KapdhColors.surface,
                    borderRadius: BorderRadius.circular(KapdhRadius.xl),
                    boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 12, offset: Offset(0, 4))],
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ProfileAvatar(name: name, url: profile?.avatarUrl, size: 64),
                      const SizedBox(width: KapdhSpace.s4),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              name,
                              style: const TextStyle(
                                fontSize: KapdhFontSize.h3,
                                fontWeight: FontWeight.w700,
                                color: KapdhColors.primary,
                              ),
                            ),
                            if (me != null) ...[
                              Text(
                                me.email,
                                style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                              ),
                              if (subtitleParts.isNotEmpty)
                                Text(
                                  subtitleParts.join(' · '),
                                  style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhColors.textMuted),
                                ),
                              if (me.memberNumber case final number?)
                                Padding(
                                  padding: const EdgeInsets.only(top: KapdhSpace.s1),
                                  child: Text(
                                    'No. anggota $number',
                                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                                  ),
                                ),
                              const SizedBox(height: KapdhSpace.s2),
                              StatusBadge(StatusStyles.membership(me.effectiveStatus)),
                              if (me.expiresAt case final expires?)
                                Padding(
                                  padding: const EdgeInsets.only(top: KapdhSpace.s1),
                                  child: Text(
                                    'Berlaku sampai ${formatDate(expires)}',
                                    style: const TextStyle(
                                      fontSize: KapdhFontSize.caption,
                                      color: KapdhColors.textMuted,
                                    ),
                                  ),
                                ),
                            ],
                          ],
                        ),
                      ),
                    ],
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
