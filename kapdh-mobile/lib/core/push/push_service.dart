import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../config/app_info.dart';
import '../deep_link/deep_links.dart';
import '../storage/secure_store.dart';
import 'push_platform.dart';

/// Mendaftarkan token perangkat (PUT /devices).
typedef DeviceRegistrar = Future<void> Function(RegisterDeviceRequest request);

/// Membuka lokasi internal lewat router; redirect memeriksa autentikasi/otorisasi lebih dulu (AC F13-3).
typedef LocationOpener = void Function(Uri location);

/// Catatan pendaftaran token push perangkat ini, disimpan lintas peluncuran aplikasi.
///
/// [userId] adalah akun yang (mungkin) terhubung dengan token FCM perangkat di server. [pendingUnregister] berarti
/// sesi akun itu sudah berakhir tetapi token belum berhasil dihapus (mis. logout tanpa koneksi); penghapusan
/// diulang saat aplikasi dibuka atau koneksi kembali (AC F13-5).
@immutable
class PushRegistration {
  const PushRegistration({required this.userId, this.pendingUnregister = false});

  final String? userId;
  final bool pendingUnregister;

  Map<String, Object?> toJson() => {'user_id': userId, 'pending_unregister': pendingUnregister};

  static PushRegistration? fromJson(Object? json) {
    if (json is! Map) return null;
    final userId = json['user_id'];
    return PushRegistration(
      userId: userId is String ? userId : null,
      pendingUnregister: json['pending_unregister'] == true,
    );
  }
}

/// Penyimpanan [PushRegistration] di secure storage (kunci sendiri; tidak menyentuh kunci lain).
class PushRegistrationStore {
  PushRegistrationStore(this._store);

  static const storageKey = 'kapdh.push_registration.v1';

  final SecureStore _store;

  Future<PushRegistration?> read() async {
    final raw = await _store.read(storageKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      return PushRegistration.fromJson(jsonDecode(raw));
    } on FormatException {
      // Nilai rusak: anggap masih ada token terdaftar agar penghapusan tetap dicoba.
      return const PushRegistration(userId: null, pendingUnregister: true);
    }
  }

  Future<void> write(PushRegistration registration) => _store.write(storageKey, jsonEncode(registration.toJson()));

  Future<void> clear() => _store.delete(storageKey);
}

/// Layanan push (F-13): izin, pendaftaran token, tampilan latar depan dan ketukan notifikasi.
///
/// - Opsional: bila platform tidak tersedia (tanpa PUSH_ENABLED atau konfigurasi Firebase) semua operasi no-op dan
///   aplikasi tetap berfungsi; inbox tetap sumber riwayat resmi (AC F13-2).
/// - Izin diminta setelah login, bukan saat aplikasi pertama dibuka; penolakan izin tidak menghalangi apa pun.
/// - Token didaftarkan ulang saat diperbarui FCM. Akun pemilik pendaftaran dicatat di secure storage SEBELUM
///   PUT /devices, sehingga setiap akhir sesi (logout, sesi dicabut, logout saat offline, sesi gagal dipulihkan saat
///   aplikasi dibuka) menghapus token FCM perangkat walau pendaftarannya terjadi di peluncuran sebelumnya. Penghapusan
///   yang gagal (offline) ditandai tertunda dan diulang saat aplikasi dibuka/koneksi kembali; setelah token FCM
///   dihapus, pengiriman server ke token lama ditolak FCM sehingga akun sebelumnya tidak lagi menerima notifikasi
///   di perangkat ini (AC F13-5). Server juga menonaktifkannya pada POST /auth/logout.
/// - Semua operasi pendaftaran berjalan berurutan, sehingga penghapusan token akun lama selesai sebelum token akun
///   baru didaftarkan.
/// - Ketukan notifikasi menormalkan `route` lewat [DeepLinks] lalu membuka router; redirect memeriksa sesi dan
///   status sebelum objek dibuka (AC F13-3).
class PushService {
  PushService({
    required PushPlatform platform,
    required DeviceRegistrar registerDevice,
    required AppInfo info,
    required LocationOpener openLocation,
    required SecureStore store,
  }) : _platform = platform,
       _registerDevice = registerDevice,
       _info = info,
       _openLocation = openLocation,
       _registrations = PushRegistrationStore(store);

  final PushPlatform _platform;
  final DeviceRegistrar _registerDevice;
  final AppInfo _info;
  final LocationOpener _openLocation;
  final PushRegistrationStore _registrations;
  final SerialQueue _queue = SerialQueue();
  final List<StreamSubscription<Object?>> _subscriptions = [];
  StreamSubscription<String>? _tokenRefresh;
  Future<bool>? _starting;
  bool _available = false;
  String? _userId;
  String? _registeredToken;

  /// Push aktif di perangkat ini.
  bool get available => _available;

  /// Izin terakhir yang diketahui; null bila belum diminta.
  PushPermission? permission;

  /// Inisialisasi sekali (aman dipanggil berulang). Penghapusan token yang tertunda dari sesi sebelumnya diulang.
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
    unawaited(retryPendingUnregister());
    return true;
  }

  /// Dipanggil saat sesi aktif untuk [userId] (login atau aplikasi dibuka dengan sesi).
  Future<void> onSignedIn(String userId) => _queue.run(() => _signIn(userId));

  Future<void> _signIn(String userId) async {
    _userId = userId;
    if (!await start()) return;
    try {
      // Token yang masih terhubung dengan akun lain (berganti akun, atau logout sebelumnya belum tuntas) dihapus
      // dulu agar FCM menerbitkan token baru untuk akun ini.
      final previous = await _registrations.read();
      if (previous != null && (previous.pendingUnregister || previous.userId != userId)) {
        if (!await _deleteDeviceToken()) return;
      }
      if (_userId != userId) return;
      permission = await _platform.requestPermission();
      if (permission == PushPermission.denied) return;
      final token = await _platform.getToken();
      if (token != null) await _register(userId, token);
      await _tokenRefresh?.cancel();
      _tokenRefresh = _platform.onTokenRefresh.listen(
        (token) => unawaited(
          _queue.run(() async {
            final current = _userId;
            if (current == null) return;
            try {
              await _register(current, token);
            } on Object catch (error) {
              debugPrint('push: pendaftaran ulang token gagal (${error.runtimeType})');
            }
          }),
        ),
      );
    } on Object catch (error) {
      // Push gagal tidak boleh mengganggu sesi (AC F13-2); pendaftaran dicoba lagi pada login/peluncuran berikutnya.
      debugPrint('push: pendaftaran perangkat gagal (${error.runtimeType})');
    }
  }

  /// Dipanggil setiap kali sesi berakhir: logout (termasuk saat offline), sesi dicabut, akun dibatasi, berganti akun,
  /// atau sesi gagal dipulihkan saat aplikasi dibuka. Aman dipanggil berulang; tanpa pendaftaran tercatat tidak
  /// melakukan apa pun.
  Future<void> onSignedOut() => _queue.run(_signOut);

  Future<void> _signOut() async {
    final wasSignedIn = _userId != null;
    _userId = null;
    _registeredToken = null;
    await _tokenRefresh?.cancel();
    _tokenRefresh = null;
    // Build tanpa push tidak pernah mendaftarkan token; catatan dari build/peluncuran lain (bila ada) dipertahankan
    // dan dicoba lagi saat push tersedia.
    if (!await start()) return;
    PushRegistration? record;
    try {
      record = await _registrations.read();
    } on Object catch (error) {
      debugPrint('push: catatan pendaftaran gagal dibaca (${error.runtimeType})');
    }
    if (record == null && !wasSignedIn) return;
    try {
      if (record?.pendingUnregister != true) {
        await _registrations.write(PushRegistration(userId: record?.userId, pendingUnregister: true));
      }
    } on Object catch (error) {
      debugPrint('push: catatan pendaftaran gagal diperbarui (${error.runtimeType})');
    }
    await _deleteDeviceToken();
  }

  /// Mengulang penghapusan token yang tertunda (dipanggil saat aplikasi dibuka dan saat koneksi kembali). Bila akun
  /// lain sudah masuk selama penghapusan tertunda, alur masuk diulang: token lama dihapus lalu token baru didaftarkan
  /// untuk akun yang aktif.
  Future<void> retryPendingUnregister() => _queue.run(() async {
    if (!await start()) return;
    final PushRegistration? record;
    try {
      record = await _registrations.read();
    } on Object {
      return;
    }
    if (record == null || !record.pendingUnregister) return;
    final current = _userId;
    if (current != null) {
      await _signIn(current);
      return;
    }
    await _deleteDeviceToken();
  });

  /// Menghapus token FCM perangkat lalu catatan pendaftarannya; hanya dipanggil saat push tersedia. false bila gagal
  /// (catatan tertunda dipertahankan untuk dicoba lagi).
  Future<bool> _deleteDeviceToken() async {
    try {
      await _platform.deleteToken();
      await _registrations.clear();
      return true;
    } on Object catch (error) {
      debugPrint('push: gagal menghapus token perangkat, dicoba lagi nanti (${error.runtimeType})');
      return false;
    }
  }

  Future<void> _register(String userId, String token) async {
    if (_userId != userId || token == _registeredToken) return;
    // Dicatat sebelum request: bila respons hilang di jaringan, token tetap dihapus saat sesi berakhir.
    await _registrations.write(PushRegistration(userId: userId));
    await _registerDevice(RegisterDeviceRequest(platform: _info.platform, token: token, appVersion: _info.version));
    _registeredToken = token;
  }

  void _open(PushMessage message) => _openRoute(message.openRoute);

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
