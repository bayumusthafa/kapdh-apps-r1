import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../config/app_info.dart';
import '../deep_link/deep_links.dart';
import 'push_platform.dart';

/// Mendaftarkan token perangkat (PUT /devices).
typedef DeviceRegistrar = Future<void> Function(RegisterDeviceRequest request);

/// Membuka lokasi internal lewat router; redirect memeriksa autentikasi/otorisasi lebih dulu (AC F13-3).
typedef LocationOpener = void Function(Uri location);

/// Layanan push (F-13): izin, pendaftaran token, tampilan latar depan dan ketukan notifikasi.
///
/// - Opsional: bila platform tidak tersedia (tanpa PUSH_ENABLED atau konfigurasi Firebase) semua operasi no-op dan
///   aplikasi tetap berfungsi; inbox tetap sumber riwayat resmi (AC F13-2).
/// - Izin diminta setelah login, bukan saat aplikasi pertama dibuka; penolakan izin tidak menghalangi apa pun.
/// - Token didaftarkan ulang saat diperbarui FCM. Saat keluar atau berganti akun, token perangkat dihapus sehingga
///   akun sebelumnya tidak lagi menerima notifikasi (AC F13-5); server juga menonaktifkannya pada POST /auth/logout.
/// - Ketukan notifikasi menormalkan `route` lewat [DeepLinks] lalu membuka router; redirect memeriksa sesi dan
///   status sebelum objek dibuka (AC F13-3).
class PushService {
  PushService({
    required PushPlatform platform,
    required DeviceRegistrar registerDevice,
    required AppInfo info,
    required LocationOpener openLocation,
  }) : _platform = platform,
       _registerDevice = registerDevice,
       _info = info,
       _openLocation = openLocation;

  final PushPlatform _platform;
  final DeviceRegistrar _registerDevice;
  final AppInfo _info;
  final LocationOpener _openLocation;
  final List<StreamSubscription<Object?>> _subscriptions = [];
  StreamSubscription<String>? _tokenRefresh;
  Future<bool>? _starting;
  bool _available = false;
  bool _signedIn = false;
  String? _registeredToken;

  /// Push aktif di perangkat ini.
  bool get available => _available;

  /// Izin terakhir yang diketahui; null bila belum diminta.
  PushPermission? permission;

  /// Inisialisasi sekali (aman dipanggil berulang).
  Future<bool> start() => _starting ??= _start();

  Future<bool> _start() async {
    _available = await _platform.initialize();
    if (!_available) return false;
    _subscriptions
      ..add(_platform.onForegroundMessage.listen((message) => unawaited(_platform.showForeground(message))))
      ..add(_platform.onMessageOpenedApp.listen(_open))
      ..add(_platform.onLocalNotificationTap.listen((route) => _openRoute(route)));
    final initial = await _platform.getInitialMessage();
    if (initial != null) _open(initial);
    return true;
  }

  /// Dipanggil saat sesi aktif (login atau aplikasi dibuka dengan sesi).
  Future<void> onSignedIn() async {
    _signedIn = true;
    if (!await start()) return;
    try {
      permission = await _platform.requestPermission();
      if (permission == PushPermission.denied) return;
      final token = await _platform.getToken();
      if (token != null) await _register(token);
      await _tokenRefresh?.cancel();
      _tokenRefresh = _platform.onTokenRefresh.listen((token) => unawaited(_register(token)));
    } on Object catch (error) {
      // Push gagal tidak boleh mengganggu sesi (AC F13-2); pendaftaran dicoba lagi pada login/peluncuran berikutnya.
      debugPrint('push: pendaftaran perangkat gagal (${error.runtimeType})');
    }
  }

  /// Dipanggil setelah logout/sesi dicabut/berganti akun.
  Future<void> onSignedOut() async {
    final wasSignedIn = _signedIn;
    _signedIn = false;
    await _tokenRefresh?.cancel();
    _tokenRefresh = null;
    _registeredToken = null;
    if (!_available || !wasSignedIn) return;
    try {
      await _platform.deleteToken();
    } on Object catch (error) {
      debugPrint('push: gagal menghapus token perangkat (${error.runtimeType})');
    }
  }

  Future<void> _register(String token) async {
    if (!_signedIn || token == _registeredToken) return;
    await _registerDevice(RegisterDeviceRequest(platform: _info.platform, token: token, appVersion: _info.version));
    _registeredToken = token;
  }

  void _open(PushMessage message) => _openRoute(message.route);

  void _openRoute(String? route) {
    final location = DeepLinks.parse(route);
    if (location != null) _openLocation(location);
  }

  Future<void> dispose() async {
    await _tokenRefresh?.cancel();
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _subscriptions.clear();
  }
}
