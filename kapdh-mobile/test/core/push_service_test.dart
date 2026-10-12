import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/push/push_platform.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_mobile/app/app_services.dart';
import 'package:kapdh_mobile/core/push/push_service.dart';
import 'package:kapdh_mobile/core/session/me_snapshot_store.dart';
import 'package:kapdh_mobile/core/session/session_controller.dart';
import 'package:kapdh_mobile/core/session/session_state.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';

import '../support/fakes.dart';

class FakePushPlatform implements PushPlatform {
  bool available = true;
  PushPermission permission = PushPermission.granted;
  String? token = 'fcm-1';
  PushMessage? initial;
  int deletes = 0;

  /// Simulasi FCM tanpa koneksi: deleteToken gagal.
  bool offline = false;
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
    if (offline) throw Exception('SERVICE_NOT_AVAILABLE (uji)');
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
  late MemorySecureStore store;

  PushService build() => PushService(
    platform: platform,
    registerDevice: (request) async => registered.add(request),
    info: testAppInfo,
    openLocation: (location) => opened.add(location.toString()),
    store: store,
  );

  setUp(() {
    platform = FakePushPlatform();
    registered = [];
    opened = [];
    store = MemorySecureStore();
    service = build();
  });

  tearDown(() => service.dispose());

  test('push tidak tersedia (tanpa PUSH_ENABLED/Firebase): semua no-op, aplikasi tetap berjalan (AC F13-2)', () async {
    platform.available = false;
    expect(await service.start(), isFalse);
    await service.onSignedIn('user-1');
    await service.onSignedOut();
    expect(registered, isEmpty);
    expect(platform.permissionRequests, 0);
    expect(platform.deletes, 0);
  });

  test('setelah login: izin diminta lalu token didaftarkan PUT /devices dengan platform dan versi', () async {
    await service.onSignedIn('user-1');
    expect(platform.permissionRequests, 1);
    expect(registered.single.token, 'fcm-1');
    expect(registered.single.platform, DevicePlatform.android);
    expect(registered.single.appVersion, '1.2.0');
  });

  test('izin ditolak: token tidak didaftarkan dan tidak ada galat', () async {
    platform.permission = PushPermission.denied;
    await service.onSignedIn('user-1');
    expect(registered, isEmpty);
    expect(service.permission, PushPermission.denied);
  });

  test('token diperbarui FCM didaftarkan ulang; token sama tidak dikirim dua kali', () async {
    await service.onSignedIn('user-1');
    platform.tokenRefresh
      ..add('fcm-1')
      ..add('fcm-baru');
    await pumpEventQueue();
    expect(registered.map((r) => r.token), ['fcm-1', 'fcm-baru']);
  });

  test('keluar/berganti akun: token perangkat dihapus dan akun berikut mendapat token baru (AC F13-5)', () async {
    await service.onSignedIn('user-1');
    await service.onSignedOut();
    expect(platform.deletes, 1);
    platform.tokenRefresh.add('fcm-setelah-keluar');
    await pumpEventQueue();
    expect(registered.map((r) => r.token), ['fcm-1'], reason: 'tidak mendaftar saat tidak ada sesi');

    await service.onSignedIn('user-1');
    expect(registered.last.token, 'fcm-2');
  });

  test('gagal mendaftarkan perangkat tidak mengganggu sesi', () async {
    final failing = PushService(
      platform: platform,
      registerDevice: (_) async => throw networkError(),
      info: testAppInfo,
      openLocation: (_) {},
      store: store,
    );
    await expectLater(failing.onSignedIn('user-1'), completes);
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

  group('catatan pendaftaran tersimpan lintas peluncuran (AC F13-5)', () {
    test('logout di peluncuran berikutnya tanpa pernah login di proses ini tetap menghapus token', () async {
      await service.onSignedIn('user-1');
      await service.dispose();
      // Peluncuran baru: proses tidak tahu pendaftaran sebelumnya kecuali dari secure storage.
      final next = build();
      await next.onSignedOut();
      expect(platform.deletes, 1);
      expect(store.values.containsKey(PushRegistrationStore.storageKey), isFalse);
      await next.dispose();
    });

    test('tanpa pendaftaran tercatat, akhir sesi tidak menghapus apa pun', () async {
      await service.onSignedOut();
      expect(platform.deletes, 0);
    });

    test('logout saat offline: penghapusan tertunda lalu diulang saat koneksi kembali', () async {
      await service.onSignedIn('user-1');
      platform.offline = true;
      await service.onSignedOut();
      expect(platform.deletes, 0);
      expect(
        (await PushRegistrationStore(store).read())?.pendingUnregister,
        isTrue,
        reason: 'token masih terhubung ke akun lama, penghapusan dicatat tertunda',
      );

      await service.retryPendingUnregister();
      expect(platform.deletes, 0, reason: 'masih offline');

      platform.offline = false;
      await service.retryPendingUnregister();
      expect(platform.deletes, 1);
      expect(await PushRegistrationStore(store).read(), isNull);
    });

    test(
      'akun lain masuk selama penghapusan tertunda: setelah online token lama dihapus lalu akun baru terdaftar',
      () async {
        await service.onSignedIn('user-1');
        platform.offline = true;
        await service.onSignedOut();
        await service.onSignedIn('user-2');
        expect(registered.map((r) => r.token), ['fcm-1'], reason: 'token akun lama belum terhapus');

        platform.offline = false;
        await service.retryPendingUnregister();
        expect(platform.deletes, 1);
        expect(registered.map((r) => r.token), ['fcm-1', 'fcm-2']);
        expect(
          await PushRegistrationStore(store).read(),
          isA<PushRegistration>().having((r) => r.userId, 'user', 'user-2'),
        );
      },
    );

    test('penghapusan tertunda diulang otomatis saat aplikasi dibuka berikutnya', () async {
      await service.onSignedIn('user-1');
      platform.offline = true;
      await service.onSignedOut();
      await service.dispose();

      platform.offline = false;
      final next = build();
      await next.start();
      await pumpEventQueue();
      expect(platform.deletes, 1);
      await next.dispose();
    });

    test('akun lain masuk di peluncuran berikutnya: token akun lama dihapus sebelum token baru didaftarkan', () async {
      await service.onSignedIn('user-1');
      await service.dispose();

      final next = build();
      await next.onSignedIn('user-2');
      expect(platform.deletes, 1);
      expect(registered.map((r) => r.token), ['fcm-1', 'fcm-2']);
      expect((await PushRegistrationStore(store).read())?.userId, 'user-2');
      await next.dispose();
    });

    test(
      'pendaftaran dicatat sebelum PUT /devices: respons yang hilang tetap diikuti penghapusan saat keluar',
      () async {
        final lost = PushService(
          platform: platform,
          registerDevice: (_) async => throw networkError(),
          info: testAppInfo,
          openLocation: (_) {},
          store: store,
        );
        await lost.onSignedIn('user-1');
        expect((await PushRegistrationStore(store).read())?.userId, 'user-1');
        await lost.onSignedOut();
        expect(platform.deletes, 1);
        await lost.dispose();
      },
    );
  });

  group('sessionServicesProvider: setiap akhir sesi menghapus token push (AC F13-5)', () {
    ProviderContainer container0(MemorySecureStore store, FakeHandler handler) => makeContainer(
      store: store,
      adapter: FakeHttpAdapter(handler),
      overrides: [
        pushPlatformProvider.overrideWithValue(platform),
        connectivityOnlineProvider.overrideWith((ref) => const Stream<bool>.empty()),
      ],
    );

    Future<void> previousLaunchRegistered(MemorySecureStore store) async {
      await PushRegistrationStore(store).write(const PushRegistration(userId: 'user-1'));
      await TokenStore(store).save(
        StoredTokens(
          accessToken: 'access-1',
          accessExpiresAt: testNow.add(const Duration(minutes: 10)),
          refreshToken: 'refresh-1',
        ),
      );
    }

    test('dibuka tanpa koneksi (offlineLastKnown) lalu logout: token FCM tetap dihapus', () async {
      final store = MemorySecureStore();
      await previousLaunchRegistered(store);
      await MeSnapshotStore(store).save(meOf(), testNow.subtract(const Duration(days: 1)));
      final container = container0(store, (_) => FakeResponse.network());
      container.read(sessionServicesProvider);
      await container.read(pushServiceProvider).start();
      await container.read(sessionProvider.notifier).bootstrap();
      expect(container.read(sessionProvider).phase, SessionPhase.offlineLastKnown);

      await container.read(sessionProvider.notifier).logout();
      await pumpEventQueue();
      expect(container.read(sessionProvider).phase, SessionPhase.anonymous);
      expect(platform.deletes, 1);
      expect(await PushRegistrationStore(store).read(), isNull);
    });

    test('sesi gagal dipulihkan saat dibuka (refresh UNAUTHENTICATED): token FCM dihapus', () async {
      final store = MemorySecureStore();
      await previousLaunchRegistered(store);
      final container = container0(
        store,
        (_) => FakeResponse.json(401, errorJson('UNAUTHENTICATED', 'Sesi berakhir.')),
      );
      container.read(sessionServicesProvider);
      await container.read(sessionProvider.notifier).bootstrap();
      await pumpEventQueue();
      expect(container.read(sessionProvider).phase, SessionPhase.anonymous);
      expect(platform.deletes, 1);
    });
  });

  test('start aman dipanggil berulang', () async {
    expect(await service.start(), isTrue);
    expect(await service.start(), isTrue);
  });
}
