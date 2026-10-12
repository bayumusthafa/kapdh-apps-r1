import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/push/push_platform.dart';
import 'package:kapdh_mobile/core/push/push_service.dart';

import '../support/fakes.dart';

class FakePushPlatform implements PushPlatform {
  bool available = true;
  PushPermission permission = PushPermission.granted;
  String? token = 'fcm-1';
  PushMessage? initial;
  int deletes = 0;
  int permissionRequests = 0;
  final shown = <PushMessage>[];
  final tokenRefresh = StreamController<String>.broadcast();
  final foreground = StreamController<PushMessage>.broadcast();
  final opened = StreamController<PushMessage>.broadcast();
  final localTaps = StreamController<String?>.broadcast();

  @override
  Future<bool> initialize() async => available;

  @override
  Future<PushPermission> requestPermission() async {
    permissionRequests++;
    return permission;
  }

  @override
  Future<String?> getToken() async => token;

  @override
  Stream<String> get onTokenRefresh => tokenRefresh.stream;

  @override
  Future<void> deleteToken() async {
    deletes++;
    token = 'fcm-${deletes + 1}';
  }

  @override
  Stream<PushMessage> get onForegroundMessage => foreground.stream;

  @override
  Stream<PushMessage> get onMessageOpenedApp => opened.stream;

  @override
  Future<PushMessage?> getInitialMessage() async => initial;

  @override
  Future<void> showForeground(PushMessage message) async => shown.add(message);

  @override
  Stream<String?> get onLocalNotificationTap => localTaps.stream;
}

void main() {
  late FakePushPlatform platform;
  late List<RegisterDeviceRequest> registered;
  late List<String> opened;
  late PushService service;

  setUp(() {
    platform = FakePushPlatform();
    registered = [];
    opened = [];
    service = PushService(
      platform: platform,
      registerDevice: (request) async => registered.add(request),
      info: testAppInfo,
      openLocation: (location) => opened.add(location.toString()),
    );
  });

  tearDown(() => service.dispose());

  test('push tidak tersedia (tanpa PUSH_ENABLED/Firebase): semua no-op, aplikasi tetap berjalan (AC F13-2)', () async {
    platform.available = false;
    expect(await service.start(), isFalse);
    await service.onSignedIn();
    await service.onSignedOut();
    expect(registered, isEmpty);
    expect(platform.permissionRequests, 0);
    expect(platform.deletes, 0);
  });

  test('setelah login: izin diminta lalu token didaftarkan PUT /devices dengan platform dan versi', () async {
    await service.onSignedIn();
    expect(platform.permissionRequests, 1);
    expect(registered.single.token, 'fcm-1');
    expect(registered.single.platform, DevicePlatform.android);
    expect(registered.single.appVersion, '1.2.0');
  });

  test('izin ditolak: token tidak didaftarkan dan tidak ada galat', () async {
    platform.permission = PushPermission.denied;
    await service.onSignedIn();
    expect(registered, isEmpty);
    expect(service.permission, PushPermission.denied);
  });

  test('token diperbarui FCM didaftarkan ulang; token sama tidak dikirim dua kali', () async {
    await service.onSignedIn();
    platform.tokenRefresh
      ..add('fcm-1')
      ..add('fcm-baru');
    await pumpEventQueue();
    expect(registered.map((r) => r.token), ['fcm-1', 'fcm-baru']);
  });

  test('keluar/berganti akun: token perangkat dihapus dan akun berikut mendapat token baru (AC F13-5)', () async {
    await service.onSignedIn();
    await service.onSignedOut();
    expect(platform.deletes, 1);
    platform.tokenRefresh.add('fcm-setelah-keluar');
    await pumpEventQueue();
    expect(registered.map((r) => r.token), ['fcm-1'], reason: 'tidak mendaftar saat tidak ada sesi');

    await service.onSignedIn();
    expect(registered.last.token, 'fcm-2');
  });

  test('gagal mendaftarkan perangkat tidak mengganggu sesi', () async {
    final failing = PushService(
      platform: platform,
      registerDevice: (_) async => throw networkError(),
      info: testAppInfo,
      openLocation: (_) {},
    );
    await expectLater(failing.onSignedIn(), completes);
    await failing.dispose();
  });

  test('pesan latar depan ditampilkan sebagai notifikasi lokal', () async {
    await service.start();
    platform.foreground.add(const PushMessage(title: 'Pembayaran diterima', body: 'KTA Anda aktif.', route: '/kta'));
    await pumpEventQueue();
    expect(platform.shown.single.title, 'Pembayaran diterima');
  });

  test('ketukan notifikasi membuka rute ternormalisasi lewat router (redirect memeriksa sesi, AC F13-3)', () async {
    platform.initial = PushMessage.fromData(data: {'route': 'kapdh://app/payments/pay-1'});
    await service.start();
    platform.opened.add(PushMessage.fromData(data: {'deep_link': '/notifications'}));
    platform.localTaps
      ..add('/kta')
      ..add('https://evil.example/kta')
      ..add(null);
    await pumpEventQueue();
    expect(opened, ['/payments/pay-1', '/notifications', '/kta']);
  });

  test('start aman dipanggil berulang', () async {
    expect(await service.start(), isTrue);
    expect(await service.start(), isTrue);
  });
}
