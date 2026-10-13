import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import 'appeal_section.dart';
import 'status_portal_actions.dart';

/// Portal pembatasan untuk anggota suspended (PRD 2.2): alasan aman dari server (`suspension_message`, tanpa alasan
/// internal), banding (PRD 3.12), kontak bantuan, ketentuan komunitas, dan penghapusan akun setelah verifikasi
/// identitas (F-14). Aplikasi utama, KTA aktif, pembayaran baru dan tindakan komunitas tidak tersedia; verifikasi KTA
/// publik juga menampilkan status ini (AC F12-4).
class RestrictedScreen extends ConsumerWidget {
  const RestrictedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final me = session.me;
    final reason = me?.suspensionMessage;
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
