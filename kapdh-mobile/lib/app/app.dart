import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/app_gate/app_gate.dart';
import '../core/session/session_controller.dart';
import '../core/ui/app_keys.dart';
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
  }

  @override
  Widget build(BuildContext context) {
    if (widget.enableSessionServices) ref.watch(sessionServicesProvider);
    return MaterialApp.router(
      title: 'KAPDH',
      debugShowCheckedModeBanner: false,
      theme: _theme,
      routerConfig: ref.watch(routerProvider),
      scaffoldMessengerKey: ref.watch(scaffoldMessengerKeyProvider),
      locale: const Locale('id'),
      supportedLocales: const [Locale('id')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
    );
  }
}
