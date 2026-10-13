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
import '../../design/design.dart';
import '../notifications/notification_unread_count.dart';
import 'widgets/account_section.dart';
import 'widgets/profile_avatar.dart';

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
    final redirectState = RedirectState(gate: ref.read(appGateProvider).status, session: ref.read(sessionProvider));
    if (!isLocationAllowed(redirectState, location)) {
      unawaited(
        showLockedTabSheet(
          context,
          tab: ShellTab(label: label, icon: icon, selectedIcon: icon, location: location),
          status: ref.read(sessionProvider).effectiveStatus,
        ),
      );
      return;
    }
    unawaited(context.push(location));
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

    AccountMenuTile tile(String location, String label, IconData icon, {String? subtitle, String? badge}) =>
        AccountMenuTile(
          key: ValueKey('account-menu-$location'),
          icon: icon,
          label: label,
          subtitle: subtitle,
          badge: badge,
          locked: locked(location),
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
                        Icons.person_outline,
                        subtitle: 'Foto, kota, profesi, keahlian, kontak',
                      ),
                      tile(
                        AppRoutes.accountPrivacy,
                        'Privasi profil',
                        Icons.visibility_outlined,
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
                        Icons.notifications_outlined,
                        subtitle: 'Kotak masuk resmi',
                        badge: unread != null && unread > 0 ? (unread > 99 ? '99+' : '$unread') : null,
                      ),
                      tile(AppRoutes.payments, 'Riwayat pembayaran', Icons.receipt_long_outlined),
                      tile(AppRoutes.tickets, 'Tiket saya', Icons.confirmation_number_outlined),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'KEAMANAN DAN NOTIFIKASI',
                    children: [
                      tile(AppRoutes.accountNotifications, 'Preferensi notifikasi', Icons.tune),
                      tile(
                        AppRoutes.accountSessions,
                        'Sesi perangkat',
                        Icons.devices_outlined,
                        subtitle: 'Perangkat yang masuk ke akun Anda',
                      ),
                      tile(AppRoutes.accountPassword, 'Ganti password', Icons.lock_reset),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'KOMUNITAS',
                    children: [
                      tile(AppRoutes.accountBlocked, 'Anggota diblokir', Icons.block),
                      tile(AppRoutes.accountReports, 'Laporan saya', Icons.flag_outlined),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'INFORMASI',
                    children: [
                      legal(AppRoutes.privacySlug, 'Kebijakan privasi', Icons.privacy_tip_outlined),
                      legal(AppRoutes.termsSlug, 'Ketentuan layanan', Icons.description_outlined),
                      legal(AppRoutes.communitySlug, 'Ketentuan komunitas', Icons.gavel_outlined),
                      legal(AppRoutes.helpSlug, 'Bantuan', Icons.help_outline),
                      legal(AppRoutes.aboutSlug, 'Tentang KAPDH', Icons.info_outline),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s5),
                  AccountSection(
                    title: 'DATA AKUN',
                    children: [
                      AccountMenuTile(
                        key: const ValueKey('account-menu-delete'),
                        icon: Icons.delete_outline,
                        label: 'Hapus akun',
                        subtitle: 'Hapus akun dan data pribadi Anda',
                        danger: true,
                        onTap: () => _open(AppRoutes.accountDelete, label: 'Hapus akun', icon: Icons.delete),
                      ),
                    ],
                  ),
                  const SizedBox(height: KapdhSpace.s6),
                  KapdhButton.outlined(
                    key: const ValueKey('account-logout'),
                    label: 'Keluar',
                    busyLabel: 'Keluar...',
                    busy: _signingOut,
                    icon: Icons.logout,
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
