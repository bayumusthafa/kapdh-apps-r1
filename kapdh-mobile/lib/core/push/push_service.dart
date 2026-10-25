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

/// Mencabut token perangkat di server (POST /devices/unregister), dipakai saat izin notifikasi dicabut.
typedef DeviceUnregistrar = Future<void> Function(UnregisterDeviceRequest request);

/// Membuka lokasi internal lewat router; redirect memeriksa autentikasi/otorisasi lebih dulu (AC F13-3).
typedef LocationOpener = void Function(Uri location);

/// Catatan pendaftaran token push perangkat ini, disimpan lintas peluncuran aplikasi.
///
/// [userId] adalah akun yang (mungkin) terhubung dengan token FCM perangkat di server. [pendingUnregister] berarti
/// sesi akun itu sudah berakhir tetapi token belum berhasil dihapus (mis. logout tanpa koneksi); penghapusan
/// diulang saat aplikasi dibuka atau koneksi kembali (AC F13-5). Catatan akun yang sedang masuk tanpa
/// [pendingUnregister] sementara izin notifikasi terbaca ditolak berarti token belum berhasil dicabut (K8 lanjutan);
/// pencabutan diulang selama catatan itu ada.
///
/// [token] adalah token FCM terakhir yang dikirim ke PUT /devices untuk [userId], dicatat sebelum request. Saat izin
/// notifikasi dicabut, nilai inilah yang dicabut di server, tanpa getToken, sehingga tetap benar walau token berotasi
/// saat aplikasi tertutup atau aplikasi iOS dipasang ulang tanpa keluar (catatan di Keychain bertahan). null bila belum
/// ada token yang dikirim, atau catatan ditulis versi aplikasi sebelumnya. Catatan tertunda tidak menyimpan token:
/// penghapusan di perangkat tidak memerlukan nilainya, dan server mencabut token sesi itu saat logout atau
/// menonaktifkannya begitu FCM menolaknya.
///
/// [previousToken] adalah token yang sudah dikirim sebelum [token] dan dipertahankan selama PUT /devices untuk [token]
/// belum berhasil: server baru mencabut token lama keluarga sesi yang sama saat token baru terdaftar, jadi bila
/// pendaftaran token baru gagal, token lama tetap aktif di server dan ikut dicabut saat izin dicabut. null setelah
/// PUT /devices berhasil, atau catatan ditulis versi aplikasi sebelumnya.
@immutable
class PushRegistration {
  const PushRegistration({required this.userId, this.token, this.previousToken, this.pendingUnregister = false});

  final String? userId;
  final String? token;
  final String? previousToken;
  final bool pendingUnregister;

  Map<String, Object?> toJson() => {
    'user_id': userId,
    if (token != null) 'token': token,
    if (previousToken != null) 'previous_token': previousToken,
    'pending_unregister': pendingUnregister,
  };

  /// Toleran terhadap catatan versi sebelumnya: kunci yang tidak ada atau bertipe salah dibaca null.
  static PushRegistration? fromJson(Object? json) {
    if (json is! Map) return null;
    final userId = json['user_id'];
    return PushRegistration(
      userId: userId is String ? userId : null,
      token: _tokenOf(json['token']),
      previousToken: _tokenOf(json['previous_token']),
      pendingUnregister: json['pending_unregister'] == true,
    );
  }

  static String? _tokenOf(Object? value) => value is String && value.isNotEmpty ? value : null;
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
///   setelah login bila izin tidak ditolak, dan dimatikan lagi setelah token perangkat terhapus (akhir sesi, berganti
///   akun, atau izin dicabut).
/// - Izin yang dicabut kemudian di pengaturan sistem (K8 lanjutan): setiap kali izin terbaca ditolak sementara
///   pendaftaran akun yang masuk masih tercatat (langkah login, aplikasi kembali ke latar depan, koneksi kembali),
///   token yang tercatat dicabut di server (POST /devices/unregister), lalu token dihapus di perangkat dan auto-init
///   dimatikan. Saat aplikasi kembali ke latar depan izin dibaca ulang tanpa dialog (atau langkah login diulang bila
///   gagal sebelum izin diminta); saat aplikasi dibuka dengan sesi izin diminta seperti saat login. Bila izin diberikan
///   lagi, token didaftarkan.
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
    required DeviceUnregistrar unregisterDevice,
    required AppInfo info,
    required LocationOpener openLocation,
    required SecureStore store,
  }) : _platform = platform,
       _registerDevice = registerDevice,
       _unregisterDevice = unregisterDevice,
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
  final DeviceUnregistrar _unregisterDevice;
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
  /// (sekali per login), lalu daftarkan token perangkat, atau cabut pendaftarannya bila izin ditolak. [attempt]
  /// menghitung percobaan ulang karena token APNs belum tersedia.
  Future<void> _connect(String userId, int attempt) async {
    if (_userId != userId) return;
    try {
      // Token yang masih terhubung dengan akun lain (berganti akun, atau logout sebelumnya belum tuntas) dihapus
      // dulu agar FCM menerbitkan token baru untuk akun ini. Selama gagal, catatan tertunda dipertahankan dan token
      // tidak didaftarkan.
      final record = await _registrations.read();
      final release = _needsRelease(record, userId);
      if (release) {
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
      if (permission == PushPermission.denied) {
        // Izin ditolak saat login, atau dicabut di pengaturan sistem setelah token terdaftar (K8 lanjutan).
        await _releaseDenied(userId);
        return;
      }
      // Sejak auto-init menyala SDK dapat membuat token untuk akun ini, termasuk sendiri saat getToken gagal atau
      // aplikasi ditutup sebelum token terdaftar. Catatan ditulis lebih dulu agar akhir sesi selalu menghapus token itu
      // lalu mematikan auto-init lagi. Token yang sudah tercatat untuk akun ini dipertahankan, agar tetap dapat dicabut
      // bila izin dicabut kemudian.
      await _registrations.write(
        release
            ? PushRegistration(userId: userId)
            : PushRegistration(userId: userId, token: record?.token, previousToken: record?.previousToken),
      );
      await _platform.setAutoInitEnabled(true);
      final token = await _platform.getToken();
      if (token != null) await _register(userId, token);
    } on Object catch (error) {
      if (_isApnsTokenNotSet(error)) {
        // iOS: token APNs belum diterima sesaat setelah aplikasi dibuka atau izin diberikan.
        _retryWhenApnsReady(userId, attempt);
        return;
      }
      // Push gagal tidak boleh mengganggu sesi (AC F13-2); pendaftaran dicoba lagi saat aplikasi kembali ke latar depan
      // atau pada login/peluncuran berikutnya.
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

  /// Mencabut pendaftaran [userId] karena izin notifikasi ditolak (K8 lanjutan, kebijakan privasi 4.10): token dicabut
  /// di server, lalu dihapus di perangkat dan auto-init dimatikan ([_deleteDeviceToken]). Tanpa catatan pendaftaran
  /// (izin ditolak sejak login) tidak ada token, sehingga tidak ada token yang diminta maupun request yang dikirim.
  ///
  /// - Yang dicabut adalah token di catatan, yaitu token terakhir yang dikirim ke PUT /devices, tanpa getToken, beserta
  ///   token sebelumnya bila PUT /devices untuk token itu belum berhasil ([PushRegistration.previousToken]); server
  ///   menjawab 204 juga untuk token yang tidak dikenalnya. Token saat ini yang berbeda (berotasi saat aplikasi
  ///   tertutup) belum pernah dikirim ke server, jadi cukup dihapus di perangkat. Catatan tanpa token (belum ada token
  ///   yang dikirim, aplikasi berhenti sebelum token pertama dikirim, atau catatan versi sebelumnya): token saat ini
  ///   hanya diambil bila auto-init menyala. Auto-init mati berarti tidak ada token untuk dicabut, karena auto-init
  ///   baru dimatikan setelah token terhapus dan aplikasi iOS yang dipasang ulang tidak membawa token lama. Lagi pula
  ///   getToken dengan auto-init mati membuat token baru di Android dan selalu gagal `apns-token-not-set` di iOS.
  /// - Server lebih dulu: catatan beserta nilai token dihapus bersama token di perangkat, dan setelah itu token tidak
  ///   dapat dicabut lagi lewat API.
  /// - Token terdaftar di memori dikosongkan sebelum request: begitu request dikirim status token di server tidak
  ///   diketahui (respons dapat hilang setelah server mencabutnya), jadi izin yang diberikan lagi sebelum pencabutan
  ///   tuntas mendaftarkan token lagi (PUT /devices idempoten).
  /// - Kegagalan (offline, server sibuk, penghapusan di perangkat gagal) hanya dicatat. Catatan pendaftaran dan
  ///   auto-init dipertahankan, begitu pula token selama belum terhapus, lalu seluruh langkah diulang setiap kali izin
  ///   terbaca ditolak lagi: saat aplikasi kembali ke latar depan, koneksi kembali, atau peluncuran berikutnya.
  ///   Request berulang aman karena server tetap menjawab 204. Galat `apns-token-not-set` di iOS (saat deleteToken
  ///   setelah token dicabut di server, atau saat getToken untuk catatan tanpa token sebelum request) diteruskan ke
  ///   [_connect] dan diulang berjeda seperti pendaftaran.
  /// - Berjalan di antrean, jadi akhir sesi atau berganti akun menunggu sampai langkah ini selesai lalu menghapus token
  ///   yang masih ada. Bila sesi sudah berganti saat request berjalan, server mengabaikan token milik akun lain (N-09).
  Future<void> _releaseDenied(String userId) async {
    final record = await _registrations.read();
    if (record == null || record.userId != userId) return;
    _registeredToken = null;
    try {
      final token = record.token ?? (_platform.isAutoInitEnabled ? await _platform.getToken() : null);
      // Token sebelumnya lebih dulu: selama token baru belum berhasil didaftarkan, token itulah yang aktif di server.
      for (final revoked in {record.previousToken, token}.nonNulls) {
        await _unregisterDevice(UnregisterDeviceRequest(token: revoked));
      }
      await _deleteDeviceToken();
    } on Object catch (error) {
      if (_isApnsTokenNotSet(error)) rethrow;
      // Push gagal tidak boleh mengganggu sesi (AC F13-2).
      debugPrint('push: gagal mencabut token karena izin ditolak, dicoba lagi nanti (${_describe(error)})');
      return;
    }
    _cancelApnsRetry();
  }

  /// Token dari FCM: rotasi token, atau di iOS token yang terbit setelah token APNs diterima.
  void _onTokenRefresh(String token) {
    final deletions = _tokenDeletions;
    unawaited(
      _queue.run(() async {
        final userId = _userId;
        if (userId == null) return;
        try {
          if (!_permissionRequested ||
              permission == PushPermission.denied ||
              _needsRelease(await _registrations.read(), userId)) {
            // Langkah login belum tuntas (mis. penghapusan token akun lain, atau pencabutan karena izin ditolak, gagal
            // karena token APNs belum ada): token APNs kini tersedia, jadi langkah login diulang (hapus token lama
            // lalu daftarkan token baru, atau cabut pendaftaran bila izin ditolak).
            await _connect(userId, 0);
            return;
          }
          // Token yang terbit sebelum penghapusan token perangkat sudah tidak berlaku.
          if (deletions != _tokenDeletions) return;
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
  /// untuk akun yang aktif. Pencabutan karena izin ditolak yang gagal (mis. offline) untuk akun yang sedang masuk ikut
  /// diulang setelah izin dibaca ulang (K8 lanjutan).
  Future<void> retryPendingUnregister() => _queue.run(() async {
    if (!await start()) return;
    final PushRegistration? record;
    try {
      record = await _registrations.read();
    } on Object {
      return;
    }
    if (record == null) return;
    final current = _userId;
    if (!record.pendingUnregister) {
      if (current != null && record.userId == current && permission == PushPermission.denied) {
        await _recheckPermission();
      }
      return;
    }
    if (current != null) {
      await _signIn(current);
      return;
    }
    await _deleteDeviceTokenOrDefer();
  });

  /// Dipanggil saat aplikasi kembali ke latar depan: pengguna dapat mencabut atau memberikan lagi izin notifikasi di
  /// pengaturan sistem selama aplikasi di latar belakang (K8 lanjutan).
  Future<void> onResumed() => _queue.run(_recheckPermission);

  /// Membaca ulang izin tanpa dialog untuk akun yang sedang masuk, lalu menerapkannya lewat [_connect]: izin ditolak
  /// sementara pendaftaran masih tercatat berarti token dicabut; izin diberikan tetapi token belum terdaftar berarti
  /// token didaftarkan. Selain itu tidak ada yang dilakukan, jadi pemanggilan berulang aman.
  ///
  /// Bila langkah login gagal sebelum izin diminta (mis. penghapusan token akun lain atau requestPermission gagal),
  /// langkah login diulang seperti saat login, sehingga izin diminta lalu diterapkan; kecuali percobaan ulang APNs
  /// masih dijadwalkan, yang mengulang langkah itu sendiri.
  Future<void> _recheckPermission() async {
    final userId = _userId;
    if (userId == null || !await start()) return;
    if (!_permissionRequested) {
      if (_apnsRetry == null) await _connect(userId, 0);
      return;
    }
    try {
      final current = await _platform.getPermission();
      // Selain granted/provisional notifikasi tidak dapat tampil, jadi dianggap ditolak. Di Android 13+ izin yang
      // dicabut di pengaturan dapat terbaca notDetermined bila dialog izin tidak pernah muncul lewat plugin (mis. izin
      // diberikan dari pengaturan sebelum login).
      final allowed = current == PushPermission.granted || current == PushPermission.provisional;
      permission = allowed ? current : PushPermission.denied;
      final needed = allowed ? _registeredToken == null : await _registrations.read() != null;
      if (needed) await _connect(userId, 0);
    } on Object catch (error) {
      debugPrint('push: izin notifikasi gagal dibaca (${_describe(error)})');
    }
  }

  /// Menghapus token FCM perangkat, mematikan auto-init, lalu menghapus catatan pendaftarannya; hanya dipanggil saat
  /// push tersedia. Galat diteruskan dan catatan tertunda dipertahankan, sehingga ketiga langkah dicoba lagi.
  Future<void> _deleteDeviceToken() async {
    await _platform.deleteToken();
    _tokenDeletions++;
    // Tanpa sesi, dengan izin ditolak, atau sebelum izin akun berikutnya diketahui, SDK tidak boleh membuat token baru
    // sendiri. Dimatikan sesudah deleteToken, bukan sebelumnya: di iOS token APNs yang dibutuhkan deleteToken hanya
    // diteruskan plugin ke FCM selama auto-init menyala, sehingga penghapusan yang tertunda tetap dapat diulang di
    // peluncuran berikutnya.
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
    // Dicatat sebelum request: bila respons hilang di jaringan, token tetap dihapus saat sesi berakhir, dan tetap dapat
    // dicabut di server bila izin dicabut kemudian. Token yang dikirim sebelumnya ikut dicatat sampai request ini
    // berhasil, karena server baru mencabutnya saat token baru terdaftar.
    final previous = _previousTokenFor(await _registrations.read(), userId, token);
    await _registrations.write(PushRegistration(userId: userId, token: token, previousToken: previous));
    await _registerDevice(RegisterDeviceRequest(platform: _info.platform, token: token, appVersion: _info.version));
    _registeredToken = token;
    // Token sudah terdaftar (termasuk lewat onTokenRefresh): percobaan ulang APNs tidak diperlukan lagi.
    _cancelApnsRetry();
    if (previous != null) await _registrations.write(PushRegistration(userId: userId, token: token));
  }

  /// Token yang dikirim sebelum [token] dan mungkin masih aktif di server selama [token] belum terdaftar: token
  /// sebelumnya yang belum dilepas dari catatan, atau token di catatan bila berbeda dari [token].
  static String? _previousTokenFor(PushRegistration? record, String userId, String token) {
    if (record == null || _needsRelease(record, userId)) return null;
    final previous = record.token == token ? record.previousToken : record.previousToken ?? record.token;
    return previous == token ? null : previous;
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
