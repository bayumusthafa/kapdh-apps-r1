import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../config/push_config.dart';

/// Pesan push yang sudah diringkas: judul, isi dan rute tujuan (`data.route`/`data.deep_link`). Payload layar kunci
/// tidak memuat isi chat, bukti bayar atau kontak (F-13); rute selalu diperiksa redirect sebelum objek dibuka.
@immutable
class PushMessage {
  const PushMessage({this.title, this.body, this.route, this.notificationId});

  factory PushMessage.fromData({String? title, String? body, Map<String, Object?> data = const {}}) {
    final route = data['route'] ?? data['deep_link'];
    final id = data['notification_id'];
    return PushMessage(
      title: title,
      body: body,
      route: route is String ? route : null,
      notificationId: id is String && _notificationIdPattern.hasMatch(id) ? id : null,
    );
  }

  /// Id notifikasi kotak masuk berbentuk UUID (payload data FCM `notification_id`, kontrak C7).
  static final RegExp _notificationIdPattern = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  final String? title;
  final String? body;
  final String? route;

  /// `notification_id` dari payload data FCM; null untuk pesan lama atau payload tanpa id.
  final String? notificationId;

  /// Lokasi yang dibuka saat pesan diketuk (AC F13-3): bila ada [notificationId], gerbang `/notifications/<id>`
  /// (rute aplikasi ARCHITECTURE §8.4) yang memeriksa ulang notifikasi ke server sebelum membuka tujuan dari
  /// `deep_link` resmi; selain itu [route] apa adanya (tetap diperiksa redirect).
  String? get openRoute {
    final id = notificationId;
    return id != null ? '/notifications/$id' : route;
  }
}

enum PushPermission { granted, provisional, denied, notDetermined }

/// Kemampuan platform push yang dipakai [PushService]; diganti tiruan pada uji.
abstract interface class PushPlatform {
  /// Inisialisasi Firebase dan notifikasi lokal. false bila push tidak tersedia (konfigurasi tidak ada) — aplikasi
  /// tetap berjalan tanpa push (AC F13-2).
  Future<bool> initialize();

  Future<PushPermission> requestPermission();

  /// Membaca izin notifikasi saat ini tanpa memunculkan dialog OS, untuk mendeteksi izin yang dicabut atau diberikan
  /// lagi di pengaturan sistem setelah login (K8 lanjutan).
  Future<PushPermission> getPermission();

  Future<String?> getToken();

  Stream<String> get onTokenRefresh;

  /// Menghapus token FCM perangkat ini sehingga akun sebelumnya tidak lagi menerima notifikasi (AC F13-5).
  Future<void> deleteToken();

  /// Menyalakan atau mematikan auto-init FCM, yaitu pembuatan dan pembaruan token FCM (beserta Firebase Installation
  /// ID) oleh SDK tanpa diminta. Bawaannya mati (`firebase_messaging_auto_init_enabled` di AndroidManifest.xml,
  /// `FirebaseMessagingAutoInitEnabled` di Info.plist), sehingga tidak ada token sebelum login. Nilai yang diset
  /// tersimpan lintas peluncuran.
  Future<void> setAutoInitEnabled(bool enabled);

  /// Pesan saat aplikasi di latar depan.
  Stream<PushMessage> get onForegroundMessage;

  /// Notifikasi sistem diketuk saat aplikasi di latar belakang.
  Stream<PushMessage> get onMessageOpenedApp;

  /// Notifikasi yang membuka aplikasi dari keadaan mati: notifikasi FCM, atau notifikasi lokal (pesan latar depan
  /// Android yang masih ada di baki saat aplikasi ditutup) yang diketuk (AC F13-3).
  Future<PushMessage?> getInitialMessage();

  /// Menampilkan [message] sebagai notifikasi lokal (latar depan Android).
  Future<void> showForeground(PushMessage message);

  /// Rute dari notifikasi lokal yang diketuk.
  Stream<String?> get onLocalNotificationTap;
}

/// Implementasi FCM/APNs + flutter_local_notifications (ARCHITECTURE §2 butir 4: Firebase hanya untuk push).
class FirebasePushPlatform implements PushPlatform {
  FirebasePushPlatform(this._config);

  static const channelId = 'kapdh_umum';
  static const channelName = 'Notifikasi KAPDH';
  static const channelDescription = 'Pembayaran, keanggotaan, event, berita dan keamanan akun';

  final PushConfig _config;
  final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();
  final StreamController<String?> _localTaps = StreamController<String?>.broadcast();
  int _nextLocalId = 0;

  FirebaseMessaging get _messaging => FirebaseMessaging.instance;

  @override
  Future<bool> initialize() async {
    if (!_config.enabled || kIsWeb) return false;
    final platform = defaultTargetPlatform;
    if (platform != TargetPlatform.android && platform != TargetPlatform.iOS) return false;
    try {
      if (Firebase.apps.isEmpty) {
        final project = _config.firebase;
        final appId = project?.appIdFor(platform);
        if (project != null && appId != null) {
          await Firebase.initializeApp(
            options: FirebaseOptions(
              apiKey: project.apiKey,
              appId: appId,
              messagingSenderId: project.messagingSenderId,
              projectId: project.projectId,
            ),
          );
        } else {
          // Konfigurasi bawaan platform (google-services.json / GoogleService-Info.plist) bila tersedia.
          await Firebase.initializeApp();
        }
      }
      await _local.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          // Izin diminta lewat FirebaseMessaging.requestPermission setelah login, bukan saat aplikasi dibuka.
          iOS: DarwinInitializationSettings(
            requestAlertPermission: false,
            requestBadgePermission: false,
            requestSoundPermission: false,
          ),
        ),
        onDidReceiveNotificationResponse: (response) => _localTaps.add(response.payload),
      );
      await _local
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(
            const AndroidNotificationChannel(
              channelId,
              channelName,
              description: channelDescription,
              importance: Importance.high,
            ),
          );
      // iOS menampilkan notifikasi latar depan secara native; Android lewat notifikasi lokal.
      await _messaging.setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);
      return true;
    } on Object catch (error) {
      debugPrint('push: dinonaktifkan karena konfigurasi Firebase tidak tersedia (${error.runtimeType})');
      return false;
    }
  }

  @override
  Future<PushPermission> requestPermission() async => _permissionOf(await _messaging.requestPermission());

  /// getNotificationSettings tidak memunculkan dialog: Android membaca izin POST_NOTIFICATIONS (13+) atau status
  /// notifikasi aplikasi (12 ke bawah), iOS membaca pengaturan notifikasi aplikasi.
  @override
  Future<PushPermission> getPermission() async => _permissionOf(await _messaging.getNotificationSettings());

  static PushPermission _permissionOf(NotificationSettings settings) => switch (settings.authorizationStatus) {
    AuthorizationStatus.authorized => PushPermission.granted,
    AuthorizationStatus.provisional => PushPermission.provisional,
    AuthorizationStatus.denied || AuthorizationStatus.deniedPermanently => PushPermission.denied,
    AuthorizationStatus.notDetermined => PushPermission.notDetermined,
  };

  @override
  Future<String?> getToken() => _messaging.getToken();

  @override
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  @override
  Future<void> deleteToken() async {
    // iOS: selama auto-init mati, plugin tidak mendaftarkan APNs dan tidak meneruskan token APNs ke FCM, sehingga
    // deleteToken selalu gagal `apns-token-not-set`. Token FCM hanya diminta setelah auto-init dinyalakan, dan
    // PushService baru mematikannya setelah token terhapus; jadi auto-init mati tanpa token APNs berarti tidak ada
    // token untuk dihapus (mis. izin ditolak sejak login).
    if (defaultTargetPlatform == TargetPlatform.iOS &&
        !_messaging.isAutoInitEnabled &&
        await _messaging.getAPNSToken() == null) {
      return;
    }
    await _messaging.deleteToken();
  }

  @override
  Future<void> setAutoInitEnabled(bool enabled) => _messaging.setAutoInitEnabled(enabled);

  static PushMessage _fromRemote(RemoteMessage message) => PushMessage.fromData(
    title: message.notification?.title,
    body: message.notification?.body,
    data: Map<String, Object?>.from(message.data),
  );

  @override
  Stream<PushMessage> get onForegroundMessage => FirebaseMessaging.onMessage.map(_fromRemote);

  @override
  Stream<PushMessage> get onMessageOpenedApp => FirebaseMessaging.onMessageOpenedApp.map(_fromRemote);

  @override
  Future<PushMessage?> getInitialMessage() async {
    final message = await _messaging.getInitialMessage();
    if (message != null) return _fromRemote(message);
    // Ketukan notifikasi lokal yang menghidupkan aplikasi tidak melewati onDidReceiveNotificationResponse.
    final launch = await _local.getNotificationAppLaunchDetails();
    final route = launch?.notificationResponse?.payload;
    if (launch == null || !launch.didNotificationLaunchApp || route == null) return null;
    return PushMessage(route: route);
  }

  @override
  Future<void> showForeground(PushMessage message) async {
    if (defaultTargetPlatform != TargetPlatform.android) return;
    if (message.title == null && message.body == null) return;
    await _local.show(
      id: _nextLocalId++,
      title: message.title,
      body: message.body,
      payload: message.openRoute,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          channelId,
          channelName,
          channelDescription: channelDescription,
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
    );
  }

  @override
  Stream<String?> get onLocalNotificationTap => _localTaps.stream;
}
