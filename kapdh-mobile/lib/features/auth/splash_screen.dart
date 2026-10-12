import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../core/auth/session.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  @override
  void initState() {
    super.initState();
    // Pengecekan versi minimum dan maintenance (GET /public/config) ditambahkan pada irisan berikutnya.
    Future.microtask(() => ref.read(sessionProvider.notifier).bootstrap());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: KapdhColors.surfaceDark,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset('assets/logo-kapdh.png', width: 120, semanticLabel: 'Logo KAPDH'),
            const SizedBox(height: KapdhSpace.s6),
            const CircularProgressIndicator(color: KapdhColors.accent),
          ],
        ),
      ),
    );
  }
}
