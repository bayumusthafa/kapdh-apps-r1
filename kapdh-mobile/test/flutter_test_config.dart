import 'dart:async';

import 'package:kapdh_mobile/core/format/formatters.dart';

/// Konfigurasi global uji: data tanggal Indonesia dan zona waktu dimuat sekali. Font aset Poppins tidak dimuat
/// harness uji, jadi teks memakai font uji.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await initFormatting();
  await testMain();
}
