import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/session/session_controller.dart';
import '../../design/design.dart';

/// Akun (F-02, F-10, F-13, F-14): menu profil, privasi, preferensi, sesi, password, tiket, riwayat pembayaran,
/// legal dan hapus akun dibangun pada irisan account-notifications. Tombol keluar sudah tersedia agar sesi selalu
/// dapat diakhiri dari aplikasi (PRD 5.2: logout menghapus cache KTA dan data akun privat).
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

  @override
  Widget build(BuildContext context) {
    return UnderConstructionScreen(
      title: 'Akun',
      feature: 'F-02, F-10, F-13, F-14',
      description:
          'Profil, privasi, preferensi notifikasi, sesi perangkat, ganti password, tiket, riwayat pembayaran, '
          'informasi legal dan hapus akun.',
      showBack: false,
      actions: [
        KapdhButton.outlined(
          key: const ValueKey('account-logout'),
          label: 'Keluar',
          busyLabel: 'Keluar...',
          busy: _signingOut,
          icon: Icons.logout,
          onPressed: _signOut,
        ),
      ],
    );
  }
}
