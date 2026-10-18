import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/app_gate/app_gate.dart';
import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import '../../core/welcome/welcome_gate.dart';
import '../../design/design.dart';

/// Splash (PRD 4.6 Flutter sistem): memeriksa gerbang aplikasi (GET /public/config: versi minimum, maintenance),
/// memulihkan sesi dan membaca penanda Welcome (pemasangan baru/pembaruan) secara paralel. Router berpindah sendiri saat keduanya siap (redirect.dart). Tanpa koneksi
/// dan tanpa snapshot sesi, layar menampilkan "Tanpa koneksi" dengan tombol coba lagi; pengguna tidak dikeluarkan.
class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  bool _retrying = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(_start);
  }

  Future<void> _start() async {
    if (!mounted) return;
    await Future.wait([
      ref.read(appGateProvider.notifier).check(),
      ref.read(sessionProvider.notifier).bootstrap(),
      ref.read(welcomeProvider.notifier).load(),
    ]);
  }

  Future<void> _retry() async {
    setState(() => _retrying = true);
    try {
      await _start();
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final gate = ref.watch(appGateProvider);
    final issue = session.phase == SessionPhase.unknown && gate.status != GateStatus.checking
        ? session.issue
        : SessionIssue.none;

    return Scaffold(
      backgroundColor: KapdhColors.surfaceDark,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(KapdhSpace.s6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Image.asset('assets/logo-kapdh.png', width: 120, height: 120, semanticLabel: 'Logo KAPDH'),
                const SizedBox(height: KapdhSpace.s4),
                const Text(
                  'Keluarga Alumni\nPesantren Darel Hikmah',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: KapdhFontSize.bodyLg,
                    fontWeight: FontWeight.w600,
                    color: KapdhColors.textOnDark,
                  ),
                ),
                const SizedBox(height: KapdhSpace.s8),
                if (issue == SessionIssue.none || _retrying)
                  const SizedBox(
                    width: 32,
                    height: 32,
                    child: CircularProgressIndicator(color: KapdhColors.accent, semanticsLabel: 'Memuat aplikasi'),
                  )
                else
                  _ConnectionProblem(issue: issue, onRetry: _retry),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ConnectionProblem extends StatelessWidget {
  const _ConnectionProblem({required this.issue, required this.onRetry});

  final SessionIssue issue;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, String title, String message) = switch (issue) {
      SessionIssue.offline => (
        Icons.cloud_off,
        'Tanpa koneksi',
        'Periksa koneksi internet Anda lalu coba lagi. Sesi Anda tetap tersimpan di perangkat ini.',
      ),
      SessionIssue.storage => (
        Icons.phonelink_lock,
        'Data sesi belum dapat dibaca',
        'Penyimpanan aman perangkat sedang tidak dapat dibuka. Coba lagi; bila terus berulang, tutup lalu buka '
            'kembali aplikasi. Sesi Anda tidak dihapus.',
      ),
      _ => (
        Icons.dns_outlined,
        'Server belum dapat dihubungi',
        'Layanan sedang sibuk atau bermasalah. Coba lagi beberapa saat lagi; sesi Anda tetap tersimpan.',
      ),
    };
    return Semantics(
      liveRegion: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 40, color: KapdhColors.accent),
          const SizedBox(height: KapdhSpace.s3),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: KapdhFontSize.h3,
              fontWeight: FontWeight.w600,
              color: KapdhColors.textOnDark,
            ),
          ),
          const SizedBox(height: KapdhSpace.s2),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhExtraColors.mutedOnDark),
          ),
          const SizedBox(height: KapdhSpace.s5),
          OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Coba lagi'),
            style: OutlinedButton.styleFrom(
              foregroundColor: KapdhColors.accent,
              side: const BorderSide(color: KapdhColors.accent),
              padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s6),
            ),
          ),
        ],
      ),
    );
  }
}
