import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/router.dart';
import 'app/theme/kapdh_theme.dart';

void main() {
  runApp(const ProviderScope(child: KapdhApp()));
}

class KapdhApp extends ConsumerWidget {
  const KapdhApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'KAPDH',
      debugShowCheckedModeBanner: false,
      theme: KapdhTheme.light(),
      routerConfig: ref.watch(routerProvider),
      locale: const Locale('id'),
      supportedLocales: const [Locale('id')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
    );
  }
}
