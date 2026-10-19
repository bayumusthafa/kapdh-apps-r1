import 'package:flutter/material.dart';

import '../../app/theme/kapdh_tokens.dart';
import '../../design/design_constants.dart';
import '../../design/kapdh_icons.dart';

/// Layar galat konfigurasi build (PRD 5.3, N-07): ditampilkan bila build rilis dibuat tanpa `KAPDH_ENV`
/// staging/production atau dengan API non-https. Aplikasi sengaja berhenti di sini daripada mengirim data anggota ke
/// API yang salah. Hanya dapat terjadi pada build yang salah dirakit; pengguna diarahkan memperbarui aplikasi.
class ConfigErrorApp extends StatelessWidget {
  const ConfigErrorApp({super.key, required this.detail});

  /// Penjelasan teknis untuk tim rilis (tanpa data pribadi).
  final String detail;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KAPDH',
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: KapdhColors.surfaceDark,
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(KapdhSpace.s6),
              child: Semantics(
                liveRegion: true,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(KapdhIcons.settingsSuggestOutlined, size: 48, color: KapdhColors.accent),
                    const SizedBox(height: KapdhSpace.s4),
                    const Text(
                      'Aplikasi belum dapat dijalankan',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: KapdhFontSize.h3,
                        fontWeight: FontWeight.w600,
                        color: KapdhColors.textOnDark,
                      ),
                    ),
                    const SizedBox(height: KapdhSpace.s2),
                    const Text(
                      'Versi aplikasi ini dirakit dengan konfigurasi yang tidak sah. Perbarui aplikasi KAPDH dari toko '
                      'aplikasi atau hubungi pengurus.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: KapdhFontSize.body, height: 1.5, color: KapdhExtraColors.mutedOnDark),
                    ),
                    const SizedBox(height: KapdhSpace.s4),
                    Text(
                      detail,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: KapdhFontSize.caption, color: KapdhExtraColors.mutedOnDark),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
