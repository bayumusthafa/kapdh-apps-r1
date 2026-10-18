import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/app_gate/app_gate.dart';
import '../core/session/session_controller.dart';
import '../core/session/session_state.dart';
import '../core/ui/app_keys.dart';
import '../features/notifications/notification_unread_count.dart';
import 'app_banners.dart';
import 'app_services.dart';
import 'router.dart';
import 'theme/kapdh_theme.dart';

/// Akar aplikasi anggota KAPDH: tema, router, locale Indonesia, ScaffoldMessenger global (ErrorPresenter) dan
/// pemeriksaan ulang gerbang/sesi saat aplikasi kembali ke latar depan (PRD 4.5, 4.6).
class KapdhApp extends ConsumerStatefulWidget {
  const KapdhApp({super.key, this.enableSessionServices = true});

  /// Push dan realtime; dimatikan pada uji widget.
  final bool enableSessionServices;

  @override
  ConsumerState<KapdhApp> createState() => _KapdhAppState();
}

class _KapdhAppState extends ConsumerState<KapdhApp> {
  late final AppLifecycleListener _lifecycle;
  late final ThemeData _theme = KapdhTheme.light();
  late final ThemeData _darkTheme = KapdhTheme.dark();

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: _onResume);
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  void _onResume() {
    unawaited(ref.read(appGateProvider.notifier).recheckIfStale());
    final session = ref.read(sessionProvider);
    // Kembali online: snapshot offline diganti status terbaru dari server (AC F05-4).
    if (session.isOffline) unawaited(ref.read(sessionProvider.notifier).refreshQuietly());
    // Notifikasi yang tiba saat aplikasi di latar belakang tidak diputar ulang realtime: lencana belum dibaca dimuat
    // ulang (kontrak C7 getNotificationUnreadCount, F-13). Hanya bila lencana sedang dipakai.
    if (session.phase == SessionPhase.authenticated && ref.exists(notificationUnreadCountProvider)) {
      unawaited(ref.read(notificationUnreadCountProvider.notifier).refresh());
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.enableSessionServices) ref.watch(sessionServicesProvider);
    return MaterialApp.router(
      title: 'KAPDH',
      debugShowCheckedModeBanner: false,
      theme: _theme,
      // [v2] Mode gelap mengikuti pengaturan sistem (palet KapdhPalette.dark).
      darkTheme: _darkTheme,
      themeMode: ThemeMode.system,
      // Tombol kembali sistem melewati redirect lagi sesudah halaman tertutup (PRD 2.2).
      routerConfig: ref.watch(routerConfigProvider),
      // Pita Offline/Pemeliharaan untuk semua layar AppScaffold, tepat di bawah app bar.
      builder: (context, child) {
        // [v2] Reduce motion: riak InkWell dimatikan (NoSplash); lapisan sorotan/hover/fokus tetap. Theme selalu
        // terpasang agar Router/Navigator di bawahnya tidak dibangun ulang saat pengaturan sistem berubah.
        final theme = Theme.of(context);
        final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
        return AppStatusBanners(
          child: Theme(
            data: reduceMotion ? theme.copyWith(splashFactory: NoSplash.splashFactory) : theme,
            child: child ?? const SizedBox.shrink(),
          ),
        );
      },
      scaffoldMessengerKey: ref.watch(scaffoldMessengerKeyProvider),
      locale: const Locale('id'),
      supportedLocales: const [Locale('id')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
    );
  }
}
