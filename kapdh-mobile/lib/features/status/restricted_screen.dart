import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import '../account/account_screen.dart' show pausedByMaintenance;
import '../account/widgets/account_section.dart';
import '../notifications/notification_unread_count.dart';
import 'appeal_section.dart';
import 'status_portal_actions.dart';

/// Portal pembatasan untuk anggota suspended (PRD 2.2): alasan aman dari server (`suspension_message`, tanpa alasan
/// internal), kotak masuk resmi (kontrak C7, AC F13-2), pemulihan akun (sesi perangkat dan ganti password, AC F02-6),
/// banding (PRD 3.12), kontak bantuan, ketentuan komunitas, dan penghapusan akun setelah verifikasi identitas (F-14). Aplikasi utama, KTA aktif, pembayaran baru dan tindakan komunitas tidak tersedia; verifikasi KTA
/// publik juga menampilkan status ini (AC F12-4).
class RestrictedScreen extends ConsumerWidget {
  const RestrictedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final me = session.me;
    final reason = me?.suspensionMessage;
    final unread = ref.watch(notificationUnreadCountProvider);
    final gate = ref.watch(appGateProvider).status;
    final banner = AppBannerScope.of(context);

    return BrandSheetScaffold(
      overlap: KapdhSpace.s4,
      header: GreetingHeader(name: me?.profile.fullName ?? 'Anggota KAPDH'),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (banner != null) ...[banner, const SizedBox(height: KapdhSpace.s4)],
            StatusHero(
              status: StatusStyles.membership(EffectiveStatus.suspended),
              title: 'Akun Anda sedang dibatasi',
              message:
                  'Pengurus membatasi akses akun ini. Selama dibatasi, KTA, pembayaran baru dan fitur komunitas '
                  'tidak dapat digunakan. Tanggal masa keanggotaan Anda tidak berubah.',
            ),
            const SizedBox(height: KapdhSpace.s5),
            SummaryCard(
              title: 'Keterangan dari pengurus',
              tone: SummaryCardTone.danger,
              body: (reason == null || reason.trim().isEmpty)
                  ? 'Hubungi pengurus untuk mengetahui alasan dan langkah pemulihan akun.'
                  : reason,
            ),
            if (session.isOffline) ...[
              const SizedBox(height: KapdhSpace.s3),
              const InfoBox(
                tone: InfoBoxTone.warning,
                icon: Icons.cloud_off,
                message: 'Anda sedang offline. Status di atas berasal dari sinkronisasi terakhir.',
              ),
            ],
            const SizedBox(height: KapdhSpace.s5),
            // Kotak masuk resmi tetap terbuka selama dibatasi (kontrak C7 member_access `any`, AC F13-2): notifikasi
            // keamanan akun dan pemberitahuan pengurus. Tujuan deep link-nya tetap diperiksa matriks status.
            AccountSection(
              title: 'KOTAK MASUK',
              children: [
                AccountMenuTile(
                  key: const ValueKey('restricted-notifications'),
                  icon: Icons.notifications_outlined,
                  label: 'Notifikasi',
                  subtitle: 'Pemberitahuan pengurus dan keamanan akun',
                  badge: unread != null && unread > 0 ? (unread > 99 ? '99+' : '$unread') : null,
                  onTap: () => context.push(AppRoutes.notifications),
                ),
              ],
            ),
            const SizedBox(height: KapdhSpace.s5),
            // Pemulihan akun (PRD 2.2): sesi perangkat dan ganti password tetap tersedia selama dibatasi (auth.yaml
            // listSessions/revokeSession/logoutAll member_access `any`, changePassword `mobile, any`). Notifikasi
            // keamanan juga membuka Sesi perangkat. Ganti password ditunda selama pemeliharaan (PRD 4.5).
            AccountSection(
              title: 'KEAMANAN AKUN',
              children: [
                AccountMenuTile(
                  key: const ValueKey('restricted-sessions'),
                  icon: Icons.devices_outlined,
                  label: 'Sesi perangkat',
                  subtitle: 'Tinjau dan keluarkan perangkat yang tidak Anda kenali',
                  onTap: () => context.push(AppRoutes.accountSessions),
                ),
                AccountMenuTile(
                  key: const ValueKey('restricted-password'),
                  icon: Icons.lock_reset,
                  label: 'Ganti password',
                  paused: pausedByMaintenance(gate, session, AppRoutes.accountPassword),
                  onTap: () => context.push(AppRoutes.accountPassword),
                ),
              ],
            ),
            const SizedBox(height: KapdhSpace.s5),
            const SectionHeader(title: 'Banding'),
            const SizedBox(height: KapdhSpace.s2),
            const AppealSection(),
            const SizedBox(height: KapdhSpace.s5),
            const SupportSection(subject: 'Pemulihan Akun KAPDH', title: 'Hubungi pengurus'),
            const SizedBox(height: KapdhSpace.s3),
            Wrap(
              spacing: KapdhSpace.s2,
              children: [
                KapdhLinkButton(
                  label: 'Ketentuan komunitas',
                  icon: Icons.gavel_outlined,
                  onPressed: () => context.push(AppRoutes.legal(AppRoutes.communitySlug)),
                ),
                KapdhLinkButton(
                  label: 'Kebijakan privasi',
                  icon: Icons.privacy_tip_outlined,
                  onPressed: () => context.push(AppRoutes.legal(AppRoutes.privacySlug)),
                ),
              ],
            ),
            const SizedBox(height: KapdhSpace.s3),
            InfoBox(
              icon: Icons.delete_outline,
              title: 'Ingin menghapus akun?',
              message:
                  'Anda tetap dapat menghapus akun dan data pribadi setelah mengonfirmasi password, tanpa membuka '
                  'akses komunitas.',
              trailing: TextButton(
                key: const ValueKey('restricted-delete-account'),
                onPressed: () => context.push(AppRoutes.accountDelete),
                child: const Text('Hapus akun'),
              ),
            ),
            const SizedBox(height: KapdhSpace.s5),
            const StatusPortalActions(),
          ],
        ),
      ),
    );
  }
}
