import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/api/api_providers.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/ui/external_links.dart';
import '../../core/ui/support_section.dart';
import '../../design/design.dart';

/// Wajib update (PRD 4.5 "Versi aplikasi di bawah minimum"): tautan toko aplikasi dari `store_links`; server juga
/// menolak mutasi dari versi lama (426 UPGRADE_REQUIRED). Dipakai pula saat server mengirim effective_status yang
/// belum dikenal versi aplikasi ini (aplikasi tidak menebak akses).
class UpdateRequiredScreen extends ConsumerStatefulWidget {
  const UpdateRequiredScreen({super.key});

  @override
  ConsumerState<UpdateRequiredScreen> createState() => _UpdateRequiredScreenState();
}

class _UpdateRequiredScreenState extends ConsumerState<UpdateRequiredScreen> {
  bool _checking = false;

  Future<void> _recheck() async {
    setState(() => _checking = true);
    try {
      await ref.read(appGateProvider.notifier).check();
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _openStore(String url) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final uri = Uri.tryParse(url);
    final opened = uri != null && await ref.read(externalLinkLauncherProvider)(uri);
    if (!opened) messenger?.showSnackBar(const SnackBar(content: Text('Toko aplikasi tidak dapat dibuka.')));
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final info = ref.watch(appInfoProvider);
    final config = gate.config;
    final (String? minimum, String? storeUrl, String storeName) = switch (info.platform) {
      DevicePlatform.android => (config?.minAppVersion.android, config?.storeLinks.android, 'Play Store'),
      DevicePlatform.ios => (config?.minAppVersion.ios, config?.storeLinks.ios, 'App Store'),
      DevicePlatform.unknown => (null, null, 'toko aplikasi'),
    };
    final versionGate = gate.status == GateStatus.updateRequired;
    final message = versionGate
        ? 'Versi aplikasi ini (${info.version}) tidak lagi didukung'
              '${minimum == null ? '' : '. Perbarui ke versi $minimum atau yang lebih baru'} untuk melanjutkan.'
        : 'Aplikasi perlu diperbarui untuk menampilkan status akun Anda dengan benar.';

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
                  label: 'Wajib Update',
                  icon: KapdhIcons.systemUpdate,
                  foreground: KapdhColors.warning,
                  background: KapdhColors.warningBg,
                ),
                title: 'Perbarui aplikasi KAPDH',
                message: message,
              ),
              const SizedBox(height: KapdhSpace.s6),
              if (storeUrl != null)
                KapdhButton(
                  label: 'Perbarui di $storeName',
                  icon: KapdhIcons.openInNew,
                  onPressed: () => _openStore(storeUrl),
                )
              else
                const InfoBox(
                  tone: InfoBoxTone.warning,
                  message: 'Tautan toko aplikasi belum tersedia. Hubungi pengurus untuk mendapatkan versi terbaru.',
                ),
              const SizedBox(height: KapdhSpace.s3),
              KapdhButton.outlined(
                label: 'Periksa lagi',
                busyLabel: 'Memeriksa...',
                busy: _checking,
                onPressed: _recheck,
              ),
              const SizedBox(height: KapdhSpace.s6),
              const SupportSection(subject: 'Pembaruan Aplikasi KAPDH'),
            ],
          ),
        ),
      ),
    );
  }
}
