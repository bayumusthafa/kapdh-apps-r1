import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
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
/// - Auto-init FCM mati sejak aplikasi dipasang (AndroidManifest.xml, Info.plist), sehingga token FCM dan Installation
///   ID tidak dibuat sebelum login (kebijakan privasi 4.10, keputusan K8). Auto-init dinyalakan tepat sebelum getToken
///   setelah login bila izin tidak ditolak, dan dimatikan lagi setelah token perangkat terhapus (akhir sesi atau
///   berganti akun).
/// - Token didaftarkan ulang saat diperbarui FCM. Akun pemilik pendaftaran dicatat di secure storage SEBELUM auto-init
///   dinyalakan (jadi juga sebelum PUT /devices), sehingga setiap akhir sesi (logout, sesi dicabut, logout saat
///   offline, sesi gagal dipulihkan saat aplikasi dibuka) menghapus token FCM perangkat dan mematikan auto-init walau
///   token dibuat di peluncuran sebelumnya atau getToken gagal. Penghapusan yang gagal (offline) ditandai tertunda
///   dan diulang saat aplikasi dibuka/koneksi kembali; setelah token FCM dihapus, pengiriman server ke token lama
///   ditolak FCM sehingga akun sebelumnya tidak lagi menerima notifikasi di perangkat ini (AC F13-5). Server juga
///   menonaktifkannya pada POST /auth/logout.
/// - Semua operasi pendaftaran berjalan berurutan, sehingga penghapusan token akun lama selesai sebelum token akun
///   baru didaftarkan.
/// - iOS: token FCM baru tersedia setelah token APNs diterima, dan getToken/deleteToken gagal `apns-token-not-set`
///   sebelum itu. Langganan onTokenRefresh dipasang di awal login (sebelum penghapusan token lama), lalu langkah
///   login diulang di antrean yang sama dengan jeda bertambah ([apnsRetryDelays], total sekitar 30 detik) selama
///   login yang sama masih berlaku; onTokenRefresh tidak terbit bila token FCM sudah tersimpan dari peluncuran
///   sebelumnya.
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

  /// Kode [FirebaseException] iOS saat token APNs belum diterima perangkat (getToken dan deleteToken).
  static const apnsTokenNotSet = 'apns-token-not-set';

  /// Jeda sebelum setiap percobaan ulang langkah login saat token APNs belum tersedia (total 30 detik). Setelah itu
  /// token didaftarkan begitu tiba lewat onTokenRefresh, atau pada login/peluncuran berikutnya.
  static const apnsRetryDelays = [
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
    Duration(seconds: 16),
  ];

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

  /// Nomor alur login/keluar; percobaan ulang APNs dari alur lama yang sudah masuk antrean diabaikan.
  int _flow = 0;
  Timer? _apnsRetry;
  bool _permissionRequested = false;

  /// Jumlah penghapusan token FCM yang berhasil; token dari onTokenRefresh yang terbit sebelum penghapusan berikutnya
  /// sudah tidak berlaku dan tidak didaftarkan.
  int _tokenDeletions = 0;

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
    _newFlow();
    if (!await start()) return;
    // Berlangganan sebelum langkah lain: di iOS token FCM baru terbit setelah token APNs diterima dan tiba lewat
    // onTokenRefresh, termasuk saat penghapusan token lama di bawah gagal karena token APNs belum ada. Satu langganan
    // dipakai semua login (tanpa pendengar ganda) dan dilepas saat keluar.
    _tokenRefresh ??= _platform.onTokenRefresh.listen(_onTokenRefresh);
    await _connect(userId, 0);
  }

  /// Langkah login yang dapat diulang untuk [userId]: hapus token yang masih terhubung dengan akun lain, minta izin
  /// (sekali per login), lalu daftarkan token perangkat. [attempt] menghitung percobaan ulang karena token APNs belum
  /// tersedia.
  Future<void> _connect(String userId, int attempt) async {
    if (_userId != userId) return;
    try {
      // Token yang masih terhubung dengan akun lain (berganti akun, atau logout sebelumnya belum tuntas) dihapus
      // dulu agar FCM menerbitkan token baru untuk akun ini. Selama gagal, catatan tertunda dipertahankan dan token
      // tidak didaftarkan.
      if (_needsRelease(await _registrations.read(), userId)) {
        try {
          await _deleteDeviceToken();
        } on Object catch (error) {
          if (_isApnsTokenNotSet(error)) rethrow;
          debugPrint('push: gagal menghapus token perangkat, dicoba lagi nanti (${_describe(error)})');
          return;
        }
      }
      if (!_permissionRequested) {
        permission = await _platform.requestPermission();
        _permissionRequested = true;
      }
      if (permission == PushPermission.denied) return;
      // Sejak auto-init menyala SDK dapat membuat token untuk akun ini, termasuk sendiri saat getToken gagal atau
      // aplikasi ditutup sebelum token terdaftar. Catatan ditulis lebih dulu agar akhir sesi selalu menghapus token itu
      // lalu mematikan auto-init lagi.
      await _registrations.write(PushRegistration(userId: userId));
      await _platform.setAutoInitEnabled(true);
      final token = await _platform.getToken();
      if (token != null) await _register(userId, token);
    } on Object catch (error) {
      if (_isApnsTokenNotSet(error)) {
        // iOS: token APNs belum diterima sesaat setelah aplikasi dibuka atau izin diberikan.
        _retryWhenApnsReady(userId, attempt);
        return;
      }
      // Push gagal tidak boleh mengganggu sesi (AC F13-2); pendaftaran dicoba lagi pada login/peluncuran berikutnya.
      debugPrint('push: pendaftaran perangkat gagal (${_describe(error)})');
    }
  }

  /// Menjadwalkan ulang [_connect] di antrean yang sama setelah jeda [apnsRetryDelays] ke-[attempt], hanya selama
  /// alur login ini masih berlaku (keluar atau login berikutnya membatalkannya).
  void _retryWhenApnsReady(String userId, int attempt) {
    _cancelApnsRetry();
    if (attempt >= apnsRetryDelays.length) {
      debugPrint('push: token APNs belum tersedia setelah ${attempt + 1} percobaan, menunggu pembaruan token');
      return;
    }
    final delay = apnsRetryDelays[attempt];
    debugPrint('push: token APNs belum tersedia, dicoba lagi dalam ${delay.inSeconds} detik');
    final flow = _flow;
    _apnsRetry = Timer(delay, () {
      _apnsRetry = null;
      unawaited(
        _queue.run(() async {
          if (flow == _flow) await _connect(userId, attempt + 1);
        }),
      );
    });
  }

  /// Token dari FCM: rotasi token, atau di iOS token yang terbit setelah token APNs diterima.
  void _onTokenRefresh(String token) {
    final deletions = _tokenDeletions;
    unawaited(
      _queue.run(() async {
        final userId = _userId;
        if (userId == null) return;
        try {
          if (!_permissionRequested || _needsRelease(await _registrations.read(), userId)) {
            // Langkah login belum tuntas (mis. penghapusan token akun lain gagal karena token APNs belum ada): token
            // APNs kini tersedia, jadi langkah login diulang (hapus token lama lalu daftarkan token baru).
            await _connect(userId, 0);
            return;
          }
          // Token yang terbit sebelum penghapusan token perangkat sudah tidak berlaku.
          if (permission == PushPermission.denied || deletions != _tokenDeletions) return;
          await _register(userId, token);
        } on Object catch (error) {
          debugPrint('push: pendaftaran ulang token gagal (${_describe(error)})');
        }
      }),
    );
  }

  /// Catatan pendaftaran milik akun lain, atau penghapusan token yang belum tuntas.
  static bool _needsRelease(PushRegistration? record, String userId) =>
      record != null && (record.pendingUnregister || record.userId != userId);

  /// Hanya [FirebaseException] berkode [apnsTokenNotSet] yang berarti menunggu token APNs; galat lain tidak diulang.
  static bool _isApnsTokenNotSet(Object error) => error is FirebaseException && error.code == apnsTokenNotSet;

  /// Jenis dan kode galat untuk log (tanpa pesan platform).
  static String _describe(Object error) =>
      error is FirebaseException ? '${error.runtimeType} ${error.code}' : '${error.runtimeType}';

  /// Memulai alur login/keluar baru: percobaan ulang APNs alur sebelumnya dibatalkan dan izin diminta lagi.
  void _newFlow() {
    _flow++;
    _cancelApnsRetry();
    _permissionRequested = false;
  }

  void _cancelApnsRetry() {
    _apnsRetry?.cancel();
    _apnsRetry = null;
  }

  /// Dipanggil setiap kali sesi berakhir: logout (termasuk saat offline), sesi dicabut, akun dibatasi, berganti akun,
  /// atau sesi gagal dipulihkan saat aplikasi dibuka. Aman dipanggil berulang; tanpa pendaftaran tercatat tidak
  /// melakukan apa pun.
  Future<void> onSignedOut() => _queue.run(_signOut);

  Future<void> _signOut() async {
    final wasSignedIn = _userId != null;
    _userId = null;
    _registeredToken = null;
    _newFlow();
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
    await _deleteDeviceTokenOrDefer();
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
    await _deleteDeviceTokenOrDefer();
  });

  /// Menghapus token FCM perangkat, mematikan auto-init, lalu menghapus catatan pendaftarannya; hanya dipanggil saat
  /// push tersedia. Galat diteruskan dan catatan tertunda dipertahankan, sehingga ketiga langkah dicoba lagi.
  Future<void> _deleteDeviceToken() async {
    await _platform.deleteToken();
    _tokenDeletions++;
    // Tanpa sesi (atau sebelum izin akun berikutnya diketahui) SDK tidak boleh membuat token baru sendiri. Dimatikan
    // sesudah deleteToken, bukan sebelumnya: di iOS token APNs yang dibutuhkan deleteToken hanya diteruskan plugin ke
    // FCM selama auto-init menyala, sehingga penghapusan yang tertunda tetap dapat diulang di peluncuran berikutnya.
    await _platform.setAutoInitEnabled(false);
    await _registrations.clear();
  }

  /// [_deleteDeviceToken] tanpa sesi aktif: kegagalan (offline, token APNs belum ada) hanya dicatat; penghapusan
  /// diulang saat aplikasi dibuka atau koneksi kembali.
  Future<void> _deleteDeviceTokenOrDefer() async {
    try {
      await _deleteDeviceToken();
    } on Object catch (error) {
      debugPrint('push: gagal menghapus token perangkat, dicoba lagi nanti (${_describe(error)})');
    }
  }

  Future<void> _register(String userId, String token) async {
    if (_userId != userId || token == _registeredToken) return;
    // Dicatat sebelum request: bila respons hilang di jaringan, token tetap dihapus saat sesi berakhir.
    await _registrations.write(PushRegistration(userId: userId));
    await _registerDevice(RegisterDeviceRequest(platform: _info.platform, token: token, appVersion: _info.version));
    _registeredToken = token;
    // Token sudah terdaftar (termasuk lewat onTokenRefresh): percobaan ulang APNs tidak diperlukan lagi.
    _cancelApnsRetry();
  }

  void _open(PushMessage message) => _openRoute(message.openRoute);

  void _openRoute(String? route) {
    final location = DeepLinks.parse(route);
    if (location != null) _openLocation(location);
  }

  /// Melepas langganan dan percobaan ulang APNs; aman dipanggil berulang.
  Future<void> dispose() async {
    _flow++;
    _cancelApnsRetry();
    final refresh = _tokenRefresh;
    _tokenRefresh = null;
    final subscriptions = [..._subscriptions];
    _subscriptions.clear();
    await refresh?.cancel();
    for (final subscription in subscriptions) {
      await subscription.cancel();
    }
  }
}
