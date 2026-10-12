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
  const PushMessage({this.title, this.body, this.route});

  factory PushMessage.fromData({String? title, String? body, Map<String, Object?> data = const {}}) {
    final route = data['route'] ?? data['deep_link'];
    return PushMessage(title: title, body: body, route: route is String ? route : null);
  }

  final String? title;
  final String? body;
  final String? route;
}

enum PushPermission { granted, provisional, denied, notDetermined }

/// Kemampuan platform push yang dipakai [PushService]; diganti tiruan pada uji.
abstract interface class PushPlatform {
  /// Inisialisasi Firebase dan notifikasi lokal. false bila push tidak tersedia (konfigurasi tidak ada) — aplikasi
  /// tetap berjalan tanpa push (AC F13-2).
  Future<bool> initialize();

  Future<PushPermission> requestPermission();

  Future<String?> getToken();

  Stream<String> get onTokenRefresh;

  /// Menghapus token FCM perangkat ini sehingga akun sebelumnya tidak lagi menerima notifikasi (AC F13-5).
  Future<void> deleteToken();

  /// Pesan saat aplikasi di latar depan.
  Stream<PushMessage> get onForegroundMessage;

  /// Notifikasi sistem diketuk saat aplikasi di latar belakang.
  Stream<PushMessage> get onMessageOpenedApp;

  /// Notifikasi yang membuka aplikasi dari keadaan mati.
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
  Future<PushPermission> requestPermission() async {
    final settings = await _messaging.requestPermission();
    return switch (settings.authorizationStatus) {
      AuthorizationStatus.authorized => PushPermission.granted,
      AuthorizationStatus.provisional => PushPermission.provisional,
      AuthorizationStatus.denied || AuthorizationStatus.deniedPermanently => PushPermission.denied,
      AuthorizationStatus.notDetermined => PushPermission.notDetermined,
    };
  }

  @override
  Future<String?> getToken() => _messaging.getToken();

  @override
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  @override
  Future<void> deleteToken() => _messaging.deleteToken();

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
    return message == null ? null : _fromRemote(message);
  }

  @override
  Future<void> showForeground(PushMessage message) async {
    if (defaultTargetPlatform != TargetPlatform.android) return;
    if (message.title == null && message.body == null) return;
    await _local.show(
      id: _nextLocalId++,
      title: message.title,
      body: message.body,
      payload: message.route,
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
