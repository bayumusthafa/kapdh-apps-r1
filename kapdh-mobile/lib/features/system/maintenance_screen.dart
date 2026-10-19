import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme/kapdh_palette.dart';
import '../../app/redirect.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';

/// Maintenance terjadwal (PRD 4.5): rentang estimasi, coba lagi dan kanal dukungan. Server hanya menolak mutasi
/// dengan 503 MAINTENANCE; anggota dengan sesi dapat lanjut dalam mode baca (KTA, tiket, riwayat, berita, kotak
/// masuk) dengan pita pemeliharaan di bawah app bar, sedangkan alur mutasi kembali ke layar ini.
class MaintenanceScreen extends ConsumerStatefulWidget {
  const MaintenanceScreen({super.key});

  @override
  ConsumerState<MaintenanceScreen> createState() => _MaintenanceScreenState();
}

class _MaintenanceScreenState extends ConsumerState<MaintenanceScreen> {
  bool _checking = false;

  Future<void> _retry() async {
    setState(() => _checking = true);
    try {
      await ref.read(appGateProvider.notifier).check();
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final session = ref.watch(sessionProvider);
    final until = gate.maintenanceUntil;
    final redirectState = RedirectState(gate: gate.status, session: session);
    final readOnlyTarget = readOnlyLanding(redirectState, GoRouterState.of(context).uri);
    final canShowKta = readOnlyTarget != AppRoutes.kta && isLocationAllowed(redirectState, AppRoutes.kta);

    return Scaffold(
      backgroundColor: context.kc.background,
      body: SafeArea(
        child: ContentWidth(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(KapdhSpace.s5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: KapdhSpace.s8),
                StatusHero(
                  status: StatusBadgeStyle(
                    label: 'Pemeliharaan',
                    icon: KapdhIcons.buildOutlined,
                    foreground: context.kc.warning,
                    background: context.kc.warningBg,
                  ),
                  title: 'Layanan sedang dalam pemeliharaan',
                  message:
                      gate.maintenanceMessage ??
                      'Kami sedang meningkatkan layanan. Data Anda aman; pengiriman data baru ditunda sementara.',
                ),
                const SizedBox(height: KapdhSpace.s5),
                InfoBox(
                  icon: KapdhIcons.schedule,
                  message: until != null
                      ? 'Perkiraan selesai: ${formatDateTime(until)}. Waktu dapat berubah.'
                      : 'Perkiraan waktu selesai belum tersedia. Silakan coba lagi beberapa saat lagi.',
                ),
                const SizedBox(height: KapdhSpace.s6),
                KapdhButton(label: 'Coba lagi', busyLabel: 'Memeriksa...', busy: _checking, onPressed: _retry),
                if (readOnlyTarget != null) ...[
                  const SizedBox(height: KapdhSpace.s3),
                  KapdhButton.outlined(
                    label: 'Lanjut dalam mode baca',
                    icon: KapdhIcons.chromeReaderModeOutlined,
                    onPressed: () => context.go(readOnlyTarget),
                  ),
                ],
                if (canShowKta) ...[
                  const SizedBox(height: KapdhSpace.s3),
                  KapdhButton.outlined(
                    label: 'Tampilkan KTA',
                    icon: KapdhIcons.badgeOutlined,
                    onPressed: () => context.go(AppRoutes.kta),
                  ),
                ],
                const SizedBox(height: KapdhSpace.s6),
                const SupportSection(subject: 'Pemeliharaan Layanan KAPDH'),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
