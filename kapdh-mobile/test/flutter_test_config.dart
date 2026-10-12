import 'dart:async';

import 'package:google_fonts/google_fonts.dart';
import 'package:kapdh_mobile/app/theme/kapdh_theme.dart';
import 'package:kapdh_mobile/core/format/formatters.dart';

/// Konfigurasi global uji: tanpa unduhan font (teks memakai font uji), data tanggal Indonesia dan zona waktu
/// dimuat sekali.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  KapdhTheme.runtimeFonts = false;
  GoogleFonts.config.allowRuntimeFetching = false;
  await initFormatting();
  await testMain();
}
