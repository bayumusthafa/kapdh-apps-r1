import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import 'status_portal_actions.dart';

/// Pemeriksaan status untuk akun disabled atau deletion_pending (PRD 2.2, F-14): sesi dan API anggota biasa tidak
/// tersedia; pengguna dapat memeriksa ulang status, membaca kebijakan privasi (retensi D2) dan menghubungi pengurus.
class DeletionStatusScreen extends ConsumerWidget {
  const DeletionStatusScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final me = session.me;
    final pendingDeletion = me?.effectiveStatus == EffectiveStatus.deletionPending;

    return BrandSheetScaffold(
      overlap: KapdhSpace.s4,
      header: GreetingHeader(name: me?.profile.fullName ?? 'Anggota KAPDH'),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StatusHero(
              status: StatusStyles.membership(me?.effectiveStatus ?? EffectiveStatus.disabled),
              title: pendingDeletion ? 'Penghapusan akun sedang diproses' : 'Akun tidak aktif',
              message: pendingDeletion
                  ? 'Permintaan penghapusan akun Anda sudah diterima dan sedang diproses. Anda akan menerima email setelah '
                        'selesai.'
                  : 'Akun ini sedang dinonaktifkan sehingga fitur anggota tidak dapat digunakan. Hubungi pengurus bila '
                        'Anda merasa ini keliru.',
            ),
            const SizedBox(height: KapdhSpace.s5),
            InfoBox(
              message: pendingDeletion
                  ? 'Data profil, kontak dan KTA dihapus. Catatan yang wajib disimpan (mis. catatan keuangan dan audit) '
                        'dipertahankan sesuai kebijakan retensi tanpa data yang tidak diperlukan.'
                  : 'Pemulihan akun hanya dapat dilakukan pengurus setelah verifikasi identitas.',
            ),
            const SizedBox(height: KapdhSpace.s5),
            const SupportSection(subject: 'Status Akun KAPDH', title: 'Hubungi pengurus'),
            const SizedBox(height: KapdhSpace.s3),
            Align(
              alignment: Alignment.centerLeft,
              child: KapdhLinkButton(
                label: 'Kebijakan privasi',
                icon: Icons.privacy_tip_outlined,
                onPressed: () => context.push(AppRoutes.legal(AppRoutes.privacySlug)),
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
