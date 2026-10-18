import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';
import 'deletion_portal.dart';
import 'deletion_status_check.dart';
import 'status_portal_actions.dart';

/// Portal status akun tanpa sesi untuk permintaan penghapusan dan akun nonaktif (PRD 2.2, F-14, AC F14-1).
///
/// Kontrak C1: login akun `deletion_pending`/`disabled` mengembalikan `next` tanpa sesi, dan permintaan hapus dari
/// aplikasi mencabut semua sesi. Karena itu portal ini bekerja tanpa sesi: menampilkan nomor permintaan, status dan
/// batas penyelesaian (WIB) dari login atau dari respons permintaan, menjelaskan retensi D2, menyediakan kontak
/// bantuan, dan memeriksa ulang status lewat OTP email (challenge terbatas). Tidak ada data akun lain yang dibuka.
class DeletionStatusScreen extends ConsumerWidget {
  const DeletionStatusScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final portal = ref.watch(deletionPortalProvider);
    final me = session.hasSession ? session.me : null;
    // Sesi lama (bila server masih mengirim status ini lewat GET /me) diperlakukan sama dengan hasil login.
    final account = portal.hasStatus
        ? portal.account
        : switch (me?.effectiveStatus) {
            EffectiveStatus.deletionPending => DeletionPortalAccount.deletionPending,
            EffectiveStatus.disabled => DeletionPortalAccount.disabled,
            _ => DeletionPortalAccount.unknown,
          };
    final deletion = portal.deletion;
    final banner = AppBannerScope.of(context);

    return BrandSheetScaffold(
      overlap: KapdhSpace.s4,
      header: const _PortalHeader(),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s6, KapdhSpace.s5, KapdhSpace.s6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (banner != null) ...[banner, const SizedBox(height: KapdhSpace.s4)],
            _StatusSummary(account: account, deletion: deletion, justRequested: portal.justRequested),
            if (portal.checkedAt case final checked?) ...[
              const SizedBox(height: KapdhSpace.s2),
              Text(
                'Status per ${formatDateTime(checked)}',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: KapdhFontSize.caption, color: context.kc.textMuted),
              ),
            ],
            const SizedBox(height: KapdhSpace.s5),
            if (account == DeletionPortalAccount.deletionPending || account == DeletionPortalAccount.unknown) ...[
              const InfoBox(
                icon: KapdhIcons.shieldOutlined,
                title: 'Data apa yang dihapus?',
                message:
                    'Data pribadi, kontak, foto, unggahan, file bukti transfer dan isi chat Anda dihapus. Catatan '
                    'keuangan, tiket, laporan dan audit hanya disimpan tanpa identitas. Backup harian berotasi 30 hari '
                    'dan data yang sudah dihapus tidak aktif kembali saat pemulihan (D2).',
              ),
              const SizedBox(height: KapdhSpace.s4),
            ],
            DeletionStatusCheck(initialEmail: portal.email ?? me?.email),
            const SizedBox(height: KapdhSpace.s5),
            const SupportSection(subject: 'Status Akun KAPDH', title: 'Hubungi pengurus'),
            const SizedBox(height: KapdhSpace.s3),
            Align(
              alignment: Alignment.centerLeft,
              child: KapdhLinkButton(
                label: 'Kebijakan privasi',
                icon: KapdhIcons.privacyTipOutlined,
                onPressed: () => context.push(AppRoutes.legal(AppRoutes.privacySlug)),
              ),
            ),
            const SizedBox(height: KapdhSpace.s5),
            if (session.hasSession)
              const StatusPortalActions()
            else
              KapdhButton.outlined(
                key: const ValueKey('deletion-status-login'),
                label: switch (account) {
                  DeletionPortalAccount.active || DeletionPortalAccount.registrationPending => 'Masuk',
                  _ => 'Kembali ke halaman masuk',
                },
                icon: KapdhIcons.login,
                onPressed: () {
                  ref.read(deletionPortalProvider.notifier).clear();
                  context.go(AppRoutes.login);
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _PortalHeader extends StatelessWidget {
  const _PortalHeader();

  @override
  Widget build(BuildContext context) {
    return BrandHeader(
      pattern: false,
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5, KapdhSpace.s5 + KapdhSpace.s4),
      child: Row(
        children: [
          const BrandLogoFrame(),
          const SizedBox(width: KapdhSpace.s3),
          Expanded(
            child: Semantics(
              header: true,
              child: const Text(
                'Status Akun',
                style: TextStyle(
                  fontSize: KapdhFontSize.bodyLg,
                  fontWeight: FontWeight.w600,
                  color: KapdhColors.textOnDark,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusSummary extends StatelessWidget {
  const _StatusSummary({required this.account, required this.deletion, required this.justRequested});

  final DeletionPortalAccount account;
  final AccountDeletion? deletion;
  final bool justRequested;

  static String _source(AccountDeletionSource source) => switch (source) {
    AccountDeletionSource.app => 'Aplikasi',
    AccountDeletionSource.web => 'Situs web',
    AccountDeletionSource.unknown => '-',
  };

  @override
  Widget build(BuildContext context) {
    switch (account) {
      case DeletionPortalAccount.deletionPending:
        final deletion = this.deletion;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StatusHero(
              status: deletion == null
                  ? StatusStyles.membership(EffectiveStatus.deletionPending)
                  : StatusStyles.deletion(deletion.status),
              title: 'Penghapusan akun sedang diproses',
              message: deletion?.status == AccountDeletionStatus.failed
                  ? 'Satu langkah penghapusan sedang diulang otomatis tanpa mengulang langkah yang sudah selesai. '
                        'Anda tidak perlu mengajukan ulang.'
                  : 'Akun tidak dapat dipakai masuk selama penghapusan berjalan. Anda menerima email setelah '
                        'penghapusan selesai.',
            ),
            if (justRequested) ...[
              const SizedBox(height: KapdhSpace.s4),
              Semantics(
                liveRegion: true,
                child: const InfoBox(
                  key: ValueKey('deletion-just-requested'),
                  icon: KapdhIcons.checkCircleOutline,
                  title: 'Permintaan diterima',
                  message:
                      'Anda sudah keluar dari semua perangkat, dan data akun di perangkat ini sudah dihapus. Simpan '
                      'nomor permintaan untuk komunikasi dengan pengurus.',
                ),
              ),
            ],
            if (deletion != null) ...[
              const SizedBox(height: KapdhSpace.s4),
              SummaryCard(
                key: const ValueKey('deletion-request-card'),
                title: 'Permintaan penghapusan',
                rows: [
                  SummaryRow('Nomor permintaan', deletion.requestNumber, emphasis: true),
                  SummaryRow('Status', StatusStyles.deletion(deletion.status).label),
                  SummaryRow('Diajukan', formatDateTime(deletion.requestedAt)),
                  SummaryRow('Selesai paling lambat', formatDateTime(deletion.estimatedCompletionAt)),
                  SummaryRow('Diajukan lewat', _source(deletion.source)),
                ],
              ),
              Align(
                alignment: Alignment.centerRight,
                child: KapdhLinkButton(
                  label: 'Salin nomor permintaan',
                  icon: KapdhIcons.copy,
                  onPressed: () async {
                    final messenger = ScaffoldMessenger.maybeOf(context);
                    await Clipboard.setData(ClipboardData(text: deletion.requestNumber));
                    messenger?.showSnackBar(const SnackBar(content: Text('Nomor permintaan disalin.')));
                  },
                ),
              ),
            ],
          ],
        );
      case DeletionPortalAccount.disabled:
        return StatusHero(
          status: StatusStyles.membership(EffectiveStatus.disabled),
          title: 'Akun tidak aktif',
          message:
              'Akun ini sedang dinonaktifkan sehingga tidak dapat dipakai masuk. Pemulihan atau penghapusan hanya '
              'dapat dilakukan pengurus setelah verifikasi identitas. Hubungi pengurus melalui kontak di bawah.',
        );
      case DeletionPortalAccount.active:
        return StatusHero(
          status: StatusStyles.membership(EffectiveStatus.verified),
          icon: KapdhIcons.verifiedUserOutlined,
          showBadge: false,
          title: 'Tidak ada permintaan penghapusan',
          message: 'Akun dengan email ini aktif dan tidak sedang dihapus. Silakan masuk untuk memakai aplikasi.',
        );
      case DeletionPortalAccount.registrationPending:
        return StatusHero(
          status: StatusStyles.membership(EffectiveStatus.pendingOtp),
          title: 'Pendaftaran belum diverifikasi',
          message: 'Email ini terdaftar tetapi belum diverifikasi. Masuk untuk melanjutkan verifikasi email.',
        );
      case DeletionPortalAccount.unknown:
        return StatusHero(
          status: StatusStyles.membership(EffectiveStatus.deletionPending),
          icon: KapdhIcons.manageSearch,
          showBadge: false,
          title: 'Periksa status penghapusan akun',
          message:
              'Masukkan email akun untuk menerima kode verifikasi dan melihat status permintaan penghapusan. Anda '
              'juga dapat masuk dengan email dan password untuk melihat status.',
        );
    }
  }
}
