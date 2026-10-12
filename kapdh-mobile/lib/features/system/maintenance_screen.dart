import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/redirect.dart';
import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/format/formatters.dart';
import '../../core/session/session_controller.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';

/// Maintenance terjadwal (PRD 4.5): rentang estimasi, coba lagi dan kanal dukungan. Server menolak mutasi dengan
/// 503 MAINTENANCE; KTA tetap dapat ditunjukkan (baca terkendali).
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
    final status = session.effectiveStatus;
    final canShowKta = status != null && isRouteAllowed(status, RouteGroup.kta);

    return Scaffold(
      backgroundColor: KapdhColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(KapdhSpace.s5),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: KapdhSpace.s8),
              StatusHero(
                status: const StatusBadgeStyle(
                  label: 'Pemeliharaan',
                  icon: Icons.build_outlined,
                  foreground: KapdhColors.warning,
                  background: KapdhColors.warningBg,
                ),
                title: 'Layanan sedang dalam pemeliharaan',
                message:
                    gate.maintenanceMessage ??
                    'Kami sedang meningkatkan layanan. Data Anda aman; pengiriman data baru ditunda sementara.',
              ),
              const SizedBox(height: KapdhSpace.s5),
              InfoBox(
                icon: Icons.schedule,
                message: until != null
                    ? 'Perkiraan selesai: ${formatDateTime(until)}. Waktu dapat berubah.'
                    : 'Perkiraan waktu selesai belum tersedia. Silakan coba lagi beberapa saat lagi.',
              ),
              const SizedBox(height: KapdhSpace.s6),
              KapdhButton(label: 'Coba lagi', busyLabel: 'Memeriksa...', busy: _checking, onPressed: _retry),
              if (canShowKta) ...[
                const SizedBox(height: KapdhSpace.s3),
                KapdhButton.outlined(
                  label: 'Tampilkan KTA',
                  icon: Icons.badge_outlined,
                  onPressed: () => context.go(AppRoutes.kta),
                ),
              ],
              const SizedBox(height: KapdhSpace.s6),
              const SupportSection(subject: 'Pemeliharaan Layanan KAPDH'),
            ],
          ),
        ),
      ),
    );
  }
}
