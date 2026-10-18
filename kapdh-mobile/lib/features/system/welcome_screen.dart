import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/kapdh_tokens.dart';
import '../../core/welcome/welcome_gate.dart';
import '../../design/design.dart';

/// Welcome setelah splash untuk pemasangan baru atau pembaruan aplikasi (core/welcome): latar mesh zamrud, logo,
/// sapaan dan dua pilihan, "Daftar KAPDH Apps" ke /register dan "Sudah Punya Akun? Masuk" ke /login. Memilih salah satunya menandai
/// Welcome selesai untuk build ini sehingga peluncuran berikutnya langsung ke layar Masuk.
class WelcomeScreen extends ConsumerWidget {
  const WelcomeScreen({super.key});

  static const greeting = 'Welcome to';
  static const appName = 'KAPDH Apps';
  static const tagline = 'Sarana silaturahmi untuk mempererat kebersamaan dan kekeluargaan alumni.';
  static const registerLabel = 'Daftar KAPDH Apps';
  static const loginLabel = 'Sudah Punya Akun? Masuk';

  void _open(BuildContext context, WidgetRef ref, String route) {
    // Pindah dulu, baru tandai: redirect yang dipicu penanda tidak sempat mengalihkan dari /welcome.
    context.go(route);
    unawaited(ref.read(welcomeProvider.notifier).markSeen());
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: KapdhColors.surfaceDark,
        body: BrandMeshBackground(
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(KapdhSpace.s6, 0, KapdhSpace.s6, KapdhSpace.s5),
              child: Column(
                children: [
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, constraints) => SingleChildScrollView(
                        child: ConstrainedBox(
                          constraints: BoxConstraints(minHeight: constraints.maxHeight),
                          child: const Center(child: _Intro()),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: KapdhSpace.s4),
                  KapdhButton.accent(label: registerLabel, onPressed: () => _open(context, ref, AppRoutes.register)),
                  const SizedBox(height: KapdhSpace.s3),
                  KapdhButton.outlinedOnDark(label: loginLabel, onPressed: () => _open(context, ref, AppRoutes.login)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Intro extends StatelessWidget {
  const _Intro();

  @override
  Widget build(BuildContext context) {
    final logo = (MediaQuery.sizeOf(context).width * 0.5).clamp(140.0, 220.0);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: KapdhSpace.s6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Cahaya lembut di belakang logo: lingkaran hijau logo tetap terpisah dari latar hijau gelap.
          DecoratedBox(
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              boxShadow: [BoxShadow(color: Color(0x2EFFFFFF), blurRadius: 48, spreadRadius: 6)],
            ),
            child: Image.asset('assets/logo-kapdh.png', width: logo, height: logo, semanticLabel: 'Logo KAPDH'),
          ),
          const SizedBox(height: KapdhSpace.s8),
          Semantics(
            header: true,
            child: const Column(
              children: [
                Text(
                  WelcomeScreen.greeting,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: KapdhFontSize.h2, color: KapdhColors.green100, height: 1.3),
                ),
                Text(
                  WelcomeScreen.appName,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: KapdhFontSize.display,
                    fontWeight: FontWeight.w700,
                    color: KapdhColors.accent,
                    height: 1.25,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: KapdhSpace.s3),
          const Text(
            WelcomeScreen.tagline,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: KapdhFontSize.body, color: KapdhExtraColors.mutedOnDark, height: 1.5),
          ),
        ],
      ),
    );
  }
}
