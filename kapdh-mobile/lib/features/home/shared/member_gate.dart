import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../../app/routes.dart';
import '../../../app/theme/kapdh_tokens.dart';
import '../../../design/design.dart';

/// Status anggota aktif (verified/expiring) dari GET /me: beranda, berita, daftar event, peserta dan reservasi
/// (kontrak C4/C5, PRD 2.2). Status dihitung server; klien hanya membaca label kontrak.
bool isActiveMember(EffectiveStatus? status) =>
    status == EffectiveStatus.verified || status == EffectiveStatus.expiring;

/// Penjelasan fitur khusus anggota aktif untuk status lain (PRD 2.2: unverified dan expired tidak membuka berita,
/// daftar event, direktori dan chat), dengan ajakan sesuai status. Server tetap menolak dengan 403
/// MEMBERSHIP_REQUIRED; layar ini mencegah request yang pasti ditolak dan menjelaskan jalan keluarnya.
class MemberOnlyNotice extends StatelessWidget {
  const MemberOnlyNotice({super.key, required this.feature, required this.status});

  /// Nama fitur, mis. "Berita".
  final String feature;
  final EffectiveStatus? status;

  @override
  Widget build(BuildContext context) {
    final current = status ?? EffectiveStatus.unknown;
    final (String message, String? actionLabel, String? route) = switch (current) {
      EffectiveStatus.unverified => (
        '$feature terbuka setelah KTA aktif. Selesaikan iuran pendaftaran agar pengurus dapat memverifikasi '
            'keanggotaan Anda.',
        'Bayar iuran',
        AppRoutes.onboardingFees,
      ),
      EffectiveStatus.expired => (
        '$feature hanya untuk anggota aktif. Perpanjang KTA untuk membukanya kembali. Tiket yang sudah lunas tetap '
            'dapat dibuka di Tiket Saya.',
        'Perpanjang KTA',
        AppRoutes.renewal,
      ),
      _ => ('$feature belum tersedia untuk status akun Anda.', null, null),
    };
    return ListView(
      padding: const EdgeInsets.fromLTRB(KapdhSpace.s5, KapdhSpace.s8, KapdhSpace.s5, KapdhSpace.s8),
      children: [
        StatusHero(
          status: StatusStyles.membership(current),
          icon: KapdhIcons.lockOutline,
          title: '$feature khusus anggota aktif',
          message: message,
        ),
        if (actionLabel != null && route != null) ...[
          const SizedBox(height: KapdhSpace.s5),
          KapdhButton(label: actionLabel, onPressed: () => context.go(route)),
        ],
      ],
    );
  }
}
