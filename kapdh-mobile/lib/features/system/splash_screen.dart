import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/kapdh_palette.dart';
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

    // [v2] Mode terang: gradasi abu terang (KapdhGradients.splash) dengan judul, spinner dan aksi primary (emas di abu
    // hanya 1,4:1); mode gelap tetap hijau tua surfaceDark. Ikon status bar mengikuti latar.
    final p = context.kc;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: p.isDark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: p.isDark ? KapdhColors.surfaceDark : const Color(0xFFEEEFED),
        body: DecoratedBox(
          decoration: BoxDecoration(gradient: p.isDark ? null : KapdhGradients.splash),
          child: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(KapdhSpace.s6),
                // Tablet: pesan masalah koneksi tidak melebar melewati 600 dp agar baris tetap nyaman dibaca.
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: ContentWidth.maxContentWidth),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Image.asset('assets/logo-kapdh.png', width: 120, height: 120, semanticLabel: 'Logo KAPDH'),
                      const SizedBox(height: KapdhSpace.s4),
                      Text(
                        'Keluarga Alumni\nPesantren Darel Hikmah',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: KapdhFontSize.bodyLg, fontWeight: FontWeight.w600, color: p.primary),
                      ),
                      const SizedBox(height: KapdhSpace.s8),
                      if (issue == SessionIssue.none || _retrying)
                        SizedBox(
                          width: 32,
                          height: 32,
                          child: CircularProgressIndicator(color: p.primary, semanticsLabel: 'Memuat aplikasi'),
                        )
                      else
                        _ConnectionProblem(issue: issue, onRetry: _retry),
                    ],
                  ),
                ),
              ),
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
        KapdhIcons.cloudOff,
        'Tanpa koneksi',
        'Periksa koneksi internet Anda lalu coba lagi. Sesi Anda tetap tersimpan di perangkat ini.',
      ),
      SessionIssue.storage => (
        KapdhIcons.phonelinkLock,
        'Data sesi belum dapat dibaca',
        'Penyimpanan aman perangkat sedang tidak dapat dibuka. Coba lagi; bila terus berulang, tutup lalu buka '
            'kembali aplikasi. Sesi Anda tidak dihapus.',
      ),
      _ => (
        KapdhIcons.dnsOutlined,
        'Server belum dapat dihubungi',
        'Layanan sedang sibuk atau bermasalah. Coba lagi beberapa saat lagi; sesi Anda tetap tersimpan.',
      ),
    };
    final p = context.kc;
    return Semantics(
      liveRegion: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 40, color: p.primary),
          const SizedBox(height: KapdhSpace.s3),
          Text(
            title,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: KapdhFontSize.h3, fontWeight: FontWeight.w600, color: p.text),
          ),
          const SizedBox(height: KapdhSpace.s2),
          Text(
            message,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: p.textMuted),
          ),
          const SizedBox(height: KapdhSpace.s5),
          // [v2] Warna teks dan garis (p.primary) diambil dari outlinedButtonTheme agar garis fokus 3 px tema tetap
          // berlaku: hijau di abu terang, emas di hijau tua surfaceDark (palet gelap). Hanya padding yang ditimpa.
          OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(KapdhIcons.refresh),
            label: const Text('Coba lagi'),
            style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: KapdhSpace.s6)),
          ),
        ],
      ),
    );
  }
}
