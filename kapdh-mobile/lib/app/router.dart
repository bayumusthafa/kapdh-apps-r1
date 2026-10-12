import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/auth/session.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/otp_screen.dart';
import '../features/auth/register_screen.dart';
import '../features/auth/splash_screen.dart';
import '../features/home/placeholder_screen.dart';
import 'redirect.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final session = ValueNotifier<SessionState>(ref.read(sessionProvider));
  ref.listen(sessionProvider, (_, next) => session.value = next);
  ref.onDispose(session.dispose);

  return GoRouter(
    initialLocation: '/splash',
    refreshListenable: session,
    redirect: (context, state) => redirectFor(session.value, state.matchedLocation),
    routes: [
      GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
      GoRoute(path: '/register', builder: (_, __) => const RegisterScreen()),
      GoRoute(path: '/register/otp', builder: (_, __) => const OtpScreen()),
      GoRoute(path: '/onboarding', builder: (_, __) => const PlaceholderScreen(title: 'Biaya KTA', note: 'Layar biaya, instruksi bayar dan unggah bukti dibangun pada irisan Iuran (F-03).')),
      GoRoute(path: '/home', builder: (_, __) => const PlaceholderScreen(title: 'Beranda', note: 'Beranda dibangun pada irisan Konten (F-08).')),
      GoRoute(path: '/kta', builder: (_, __) => const PlaceholderScreen(title: 'Kartu Tanda Anggota', note: 'KTA dan cache offline dibangun pada irisan KTA (F-05).')),
      GoRoute(path: '/renewal', builder: (_, __) => const PlaceholderScreen(title: 'Perpanjang KTA', note: 'Masa keanggotaan berakhir. Alur perpanjangan dibangun pada irisan Iuran.')),
      GoRoute(path: '/restricted', builder: (_, __) => const PlaceholderScreen(title: 'Akun dibatasi', note: 'Hubungi pengurus melalui bantuan@kapdh.or.id.')),
      GoRoute(path: '/deletion', builder: (_, __) => const PlaceholderScreen(title: 'Penghapusan akun', note: 'Permintaan penghapusan sedang diproses.')),
      GoRoute(path: '/settings', builder: (_, __) => const PlaceholderScreen(title: 'Pengaturan', note: 'Profil, sesi, preferensi dan hapus akun.')),
    ],
  );
});
