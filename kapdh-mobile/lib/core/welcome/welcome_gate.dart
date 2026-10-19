import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_providers.dart';
import '../session/session_controller.dart';

/// Apakah layar Welcome (pilihan "Daftar KAPDH Apps" / "Sudah Punya Akun? Masuk") perlu tampil setelah splash.
enum WelcomeStatus {
  /// Penanda belum dibaca dari perangkat (splash).
  unknown,

  /// Aplikasi baru dipasang atau baru diperbarui (build berbeda dari build terakhir yang menampilkan Welcome).
  pending,

  /// Welcome sudah dilihat untuk build ini, atau pengguna sudah pernah masuk di build ini.
  done,
}

/// Penyimpanan build terakhir yang sudah melewati Welcome. Preferensi non-rahasia, jadi shared_preferences
/// (pubspec: rahasia di Keychain/Keystore, preferensi di shared_preferences).
abstract interface class WelcomeStore {
  Future<String?> readSeenBuild();
  Future<void> writeSeenBuild(String build);
}

class PrefsWelcomeStore implements WelcomeStore {
  PrefsWelcomeStore([SharedPreferencesAsync? prefs]) : _prefs = prefs ?? SharedPreferencesAsync();

  static const key = 'welcome_seen_build';

  final SharedPreferencesAsync _prefs;

  @override
  Future<String?> readSeenBuild() => _prefs.getString(key);

  @override
  Future<void> writeSeenBuild(String build) => _prefs.setString(key, build);
}

/// Penyimpanan di memori untuk uji dan pratinjau. [failing] meniru penyimpanan perangkat yang tidak dapat dibuka.
class MemoryWelcomeStore implements WelcomeStore {
  MemoryWelcomeStore({this.seenBuild, this.failing = false});

  String? seenBuild;
  final bool failing;

  @override
  Future<String?> readSeenBuild() async {
    if (failing) throw StateError('penyimpanan tidak tersedia');
    return seenBuild;
  }

  @override
  Future<void> writeSeenBuild(String build) async {
    if (failing) throw StateError('penyimpanan tidak tersedia');
    seenBuild = build;
  }
}

final welcomeStoreProvider = Provider<WelcomeStore>((ref) => PrefsWelcomeStore());

final welcomeProvider = NotifierProvider<WelcomeController, WelcomeStatus>(WelcomeController.new);

/// Penanda Welcome per build (`versi+build`): pemasangan baru tidak punya penanda, pembaruan aplikasi mengganti
/// build, jadi keduanya memunculkan Welcome sekali. Pengguna yang sudah masuk tidak melihatnya; sesi yang aktif di
/// build ini juga menandai Welcome selesai agar keluar akun nanti langsung ke layar Masuk. Galat penyimpanan tidak
/// pernah menahan aplikasi di splash (dianggap selesai).
class WelcomeController extends Notifier<WelcomeStatus> {
  Future<void>? _loading;

  @override
  WelcomeStatus build() {
    ref.listen(sessionProvider.select((session) => session.hasSession), (_, hasSession) {
      if (hasSession) unawaited(markSeen());
    });
    return WelcomeStatus.unknown;
  }

  String get _build {
    final info = ref.read(appInfoProvider);
    return '${info.version}+${info.buildNumber}';
  }

  /// Membaca penanda sekali (dipanggil splash bersama gerbang aplikasi dan pemulihan sesi).
  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    if (state != WelcomeStatus.unknown) return;
    WelcomeStatus next;
    try {
      final seen = await ref.read(welcomeStoreProvider).readSeenBuild();
      next = seen == _build ? WelcomeStatus.done : WelcomeStatus.pending;
    } on Object {
      next = WelcomeStatus.done;
    }
    if (ref.mounted && state == WelcomeStatus.unknown) state = next;
  }

  /// Welcome selesai untuk build ini (tombol Daftar/Masuk ditekan atau sesi aktif).
  Future<void> markSeen() async {
    if (state == WelcomeStatus.done) return;
    state = WelcomeStatus.done;
    try {
      await ref.read(welcomeStoreProvider).writeSeenBuild(_build);
    } on Object {
      // Gagal menyimpan hanya berarti Welcome tampil lagi pada peluncuran berikutnya.
    }
  }
}
