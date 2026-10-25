import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show debugPrint;
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

  /// Izin di pengaturan sistem: dikembalikan requestPermission (tanpa dialog bila sudah diputuskan) dan getPermission.
  PushPermission permission = PushPermission.granted;
  String? token = 'fcm-1';
  PushMessage? initial;
  int deletes = 0;

  /// Simulasi FCM tanpa koneksi: deleteToken gagal.
  bool offline = false;

  /// Simulasi iOS sebelum token APNs diterima: getToken melempar galat ini.
  Object? tokenError;

  /// Simulasi iOS sebelum token APNs diterima: deleteToken melempar galat ini.
  Object? deleteError;

  /// Auto-init FCM; bawaannya mati seperti di AndroidManifest.xml dan Info.plist.
  bool autoInitEnabled = false;

  /// Simulasi kegagalan setAutoInitEnabled.
  Object? autoInitError;

  /// Urutan panggilan yang membuat atau menghapus token: `getToken`, `deleteToken`, `autoInit:true|false`, ditambah
  /// `unregister:<token>` dari POST /devices/unregister tiruan yang berhasil.
  final calls = <String>[];
  int tokenRequests = 0;
  int permissionRequests = 0;

  /// Pembacaan izin tanpa dialog (getNotificationSettings).
  int permissionReads = 0;
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
  Future<PushPermission> getPermission() async {
    permissionReads++;
    return permission;
  }

  @override
  Future<String?> getToken() async {
    tokenRequests++;
    calls.add('getToken');
    final error = tokenError;
    if (error != null) throw error;
    return token;
  }

  @override
  Stream<String> get onTokenRefresh => tokenRefresh.stream;

  @override
  Future<void> deleteToken() async {
    if (offline) throw Exception('SERVICE_NOT_AVAILABLE (uji)');
    final error = deleteError;
    if (error != null) throw error;
    calls.add('deleteToken');
    deletes++;
    token = 'fcm-${deletes + 1}';
  }

  @override
  Future<void> setAutoInitEnabled(bool enabled) async {
    final error = autoInitError;
    if (error != null) throw error;
    calls.add('autoInit:$enabled');
    autoInitEnabled = enabled;
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

  /// Token di body POST /devices/unregister yang berhasil (204).
  late List<String> unregistered;

  /// Dijalankan sebelum POST /devices/unregister tiruan selesai: melempar berarti request gagal (mis. offline), Future
  /// yang belum selesai berarti request masih berjalan.
  late Future<void> Function() beforeUnregister;
  late List<String> opened;
  late PushService service;
  late MemorySecureStore store;

  PushService build() => PushService(
    platform: platform,
    registerDevice: (request) async => registered.add(request),
    unregisterDevice: (request) async {
      await beforeUnregister();
      unregistered.add(request.token);
      platform.calls.add('unregister:${request.token}');
    },
    info: testAppInfo,
    openLocation: (location) => opened.add(location.toString()),
    store: store,
  );

  /// Tiruan dan layanan baru; di dalam fakeAsync dipanggil ulang agar antrean microtask dan timer percobaan ulang
  /// layanan ikut dikendalikan zona tersebut.
  void rebuild() {
    platform = FakePushPlatform();
    registered = [];
    unregistered = [];
    beforeUnregister = () async {};
    opened = [];
    store = MemorySecureStore();
    service = build();
  }

  setUp(rebuild);

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

  group('iOS: token APNs belum tersedia saat login (getToken gagal apns-token-not-set)', () {
    FirebaseException apnsTokenNotSet() => FirebaseException(plugin: 'firebase_messaging', code: 'apns-token-not-set');

    test('token yang tiba lewat onTokenRefresh tetap didaftarkan PUT /devices', () async {
      platform.tokenError = apnsTokenNotSet();
      await service.onSignedIn('user-1');
      expect(registered, isEmpty);
      expect(platform.tokenRefresh.hasListener, isTrue, reason: 'langganan dibuat sebelum getToken');

      platform.tokenRefresh.add('fcm-apns');
      await pumpEventQueue();
      expect(registered.single.token, 'fcm-apns');
      expect((await PushRegistrationStore(store).read())?.userId, 'user-1');
    });

    test('keluar sebelum token tiba: tidak ada yang didaftarkan dan langganan dilepas', () async {
      platform.tokenError = apnsTokenNotSet();
      await service.onSignedIn('user-1');
      await service.onSignedOut();
      expect(platform.tokenRefresh.hasListener, isFalse);

      platform.tokenRefresh.add('fcm-apns');
      await pumpEventQueue();
      expect(registered, isEmpty);
    });

    test('penghapusan token tertunda gagal apns-token-not-set: langganan tetap dipasang, token baru didaftarkan '
        'setelah token lama terhapus', () async {
      await PushRegistrationStore(store).write(const PushRegistration(userId: 'user-1', pendingUnregister: true));
      platform.deleteError = apnsTokenNotSet();
      await service.onSignedIn('user-2');
      await pumpEventQueue();
      expect(platform.tokenRefresh.hasListener, isTrue, reason: 'langganan dibuat sebelum penghapusan token lama');
      expect(platform.deletes, 0);
      expect(registered, isEmpty, reason: 'token akun lama belum terhapus');
      expect((await PushRegistrationStore(store).read())?.pendingUnregister, isTrue);

      // Token APNs diterima: FCM menerbitkan token lama perangkat lewat onTokenRefresh.
      platform.deleteError = null;
      platform.tokenRefresh.add('fcm-1');
      await pumpEventQueue();
      expect(platform.deletes, 1);
      expect(registered.map((r) => r.token), ['fcm-2'], reason: 'token lama tidak didaftarkan untuk akun baru');
      expect(
        await PushRegistrationStore(store).read(),
        isA<PushRegistration>()
            .having((r) => r.userId, 'user', 'user-2')
            .having((r) => r.pendingUnregister, 'pending', isFalse),
      );
    });

    test('tanpa onTokenRefresh: penghapusan token lama diulang berjeda lalu token baru didaftarkan', () {
      fakeAsync((async) {
        rebuild();
        unawaited(PushRegistrationStore(store).write(const PushRegistration(userId: 'user-1')));
        platform.deleteError = apnsTokenNotSet();
        unawaited(service.onSignedIn('user-2'));
        async.flushMicrotasks();
        expect(platform.deletes, 0);
        expect(platform.tokenRequests, 0, reason: 'token tidak diminta sebelum token akun lama terhapus');

        platform.deleteError = null;
        async.elapse(PushService.apnsRetryDelays.first);
        expect(platform.deletes, 1);
        expect(registered.map((r) => r.token), ['fcm-2']);
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('getToken gagal apns-token-not-set lalu berhasil pada percobaan ulang tanpa onTokenRefresh', () {
      fakeAsync((async) {
        rebuild();
        platform.tokenError = apnsTokenNotSet();
        unawaited(service.onSignedIn('user-1'));
        async.flushMicrotasks();
        expect(platform.tokenRequests, 1);
        expect(registered, isEmpty);
        expect(platform.autoInitEnabled, isTrue, reason: 'plugin iOS baru mendaftarkan APNs setelah auto-init menyala');

        async.elapse(PushService.apnsRetryDelays[0]);
        expect(platform.tokenRequests, 2, reason: 'token APNs masih belum ada');

        // Token FCM sudah tersimpan dari peluncuran sebelumnya, sehingga onTokenRefresh tidak terbit.
        platform.tokenError = null;
        async.elapse(PushService.apnsRetryDelays[1]);
        expect(platform.tokenRequests, 3);
        expect(registered.single.token, 'fcm-1');
        expect(platform.permissionRequests, 1, reason: 'izin tidak diminta ulang pada percobaan ulang');

        async.elapse(const Duration(minutes: 1));
        expect(platform.tokenRequests, 3, reason: 'percobaan ulang berhenti setelah terdaftar');
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('percobaan ulang dibatasi (sekitar 30 detik); token yang tiba sesudahnya tetap didaftarkan', () {
      fakeAsync((async) {
        rebuild();
        platform.tokenError = apnsTokenNotSet();
        unawaited(service.onSignedIn('user-1'));
        async.elapse(const Duration(seconds: 30));
        expect(platform.tokenRequests, 1 + PushService.apnsRetryDelays.length);
        expect(async.pendingTimers, isEmpty);

        async.elapse(const Duration(minutes: 5));
        expect(platform.tokenRequests, 1 + PushService.apnsRetryDelays.length);
        expect(registered, isEmpty);

        platform.tokenRefresh.add('fcm-apns');
        async.flushMicrotasks();
        expect(registered.single.token, 'fcm-apns');
      });
    });

    test('galat getToken lain bukan menunggu APNs: tidak diulang dan dicatat dengan kodenya', () {
      final logs = <String>[];
      final originalDebugPrint = debugPrint;
      debugPrint = (message, {wrapWidth}) => logs.add(message ?? '');
      try {
        fakeAsync((async) {
          rebuild();
          platform.tokenError = FirebaseException(plugin: 'firebase_messaging', code: 'unknown');
          unawaited(service.onSignedIn('user-1'));
          async.flushMicrotasks();
          async.elapse(const Duration(minutes: 1));
          expect(platform.tokenRequests, 1);
          expect(async.pendingTimers, isEmpty);
          expect(registered, isEmpty);
        });
      } finally {
        debugPrint = originalDebugPrint;
      }
      expect(logs, contains('push: pendaftaran perangkat gagal (FirebaseException unknown)'));
      expect(logs.where((line) => line.contains('APNs')), isEmpty);
    });

    test('keluar selama jeda percobaan ulang: tidak ada yang didaftarkan, timer dan langganan dilepas', () {
      fakeAsync((async) {
        rebuild();
        platform.tokenError = apnsTokenNotSet();
        unawaited(service.onSignedIn('user-1'));
        async.elapse(const Duration(seconds: 3));
        expect(platform.tokenRequests, 2);
        expect(async.pendingTimers, hasLength(1));

        unawaited(service.onSignedOut());
        async.flushMicrotasks();
        expect(async.pendingTimers, isEmpty, reason: 'keluar berjalan tanpa menunggu jeda dan membatalkan timer');
        expect(platform.tokenRefresh.hasListener, isFalse);

        platform.tokenError = null;
        platform.tokenRefresh.add('fcm-apns');
        async.elapse(const Duration(minutes: 1));
        expect(platform.tokenRequests, 2);
        expect(registered, isEmpty);
      });
    });
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

  group('auto-init FCM: token hanya dibuat setelah login bila izin tidak ditolak (K8, kebijakan privasi 4.10)', () {
    test('sebelum login: aplikasi dibuka dan sesi anonim tidak meminta token maupun menyalakan auto-init', () async {
      expect(await service.start(), isTrue);
      // Sesi anonim saat aplikasi dibuka, koneksi kembali, dan aplikasi kembali ke latar depan: tanpa pendaftaran
      // tercatat tidak ada panggilan token, dan izin tidak dibaca maupun diminta.
      await service.onSignedOut();
      await service.retryPendingUnregister();
      await service.onResumed();
      expect(platform.calls, isEmpty);
      expect(platform.autoInitEnabled, isFalse);
      expect(platform.permissionRequests, 0);
      expect(platform.permissionReads, 0);
    });

    test('setelah login dengan izin: auto-init dinyalakan tepat sebelum getToken, lalu token didaftarkan', () async {
      await service.onSignedIn('user-1');
      expect(platform.calls, ['autoInit:true', 'getToken']);
      expect(platform.autoInitEnabled, isTrue);
      expect(registered.single.token, 'fcm-1');
    });

    test('izin ditolak: auto-init tetap mati dan token tidak diminta', () async {
      platform.permission = PushPermission.denied;
      await service.onSignedIn('user-1');
      expect(platform.calls, isEmpty);
      expect(platform.autoInitEnabled, isFalse);
      expect(await PushRegistrationStore(store).read(), isNull);
    });

    test('keluar: token dihapus lebih dulu, lalu auto-init dimatikan dan catatan dibersihkan', () async {
      await service.onSignedIn('user-1');
      platform.calls.clear();
      await service.onSignedOut();
      expect(platform.calls, ['deleteToken', 'autoInit:false']);
      expect(platform.autoInitEnabled, isFalse);
      expect(await PushRegistrationStore(store).read(), isNull);
    });

    test('keluar saat offline: auto-init tetap menyala sampai token benar-benar terhapus', () async {
      await service.onSignedIn('user-1');
      platform.offline = true;
      await service.onSignedOut();
      expect(
        platform.autoInitEnabled,
        isTrue,
        reason: 'di iOS token APNs yang dibutuhkan deleteToken hanya diteruskan selama auto-init menyala',
      );

      platform.offline = false;
      await service.retryPendingUnregister();
      expect(platform.deletes, 1);
      expect(platform.autoInitEnabled, isFalse);
      expect(await PushRegistrationStore(store).read(), isNull);
    });

    test(
      'berganti akun: auto-init dimatikan setelah token akun lama terhapus, lalu dinyalakan untuk akun baru',
      () async {
        await service.onSignedIn('user-1');
        await service.dispose();

        final next = build();
        platform.calls.clear();
        await next.onSignedIn('user-2');
        expect(platform.calls, ['deleteToken', 'autoInit:false', 'autoInit:true', 'getToken']);
        expect(registered.map((r) => r.token), ['fcm-1', 'fcm-2']);
        await next.dispose();
      },
    );

    test('berganti akun lalu izin akun baru ditolak: token akun lama dihapus dan auto-init tetap mati', () async {
      await service.onSignedIn('user-1');
      await service.dispose();

      platform.permission = PushPermission.denied;
      final next = build();
      platform.calls.clear();
      await next.onSignedIn('user-2');
      expect(platform.calls, ['deleteToken', 'autoInit:false']);
      expect(platform.autoInitEnabled, isFalse);
      expect(registered.map((r) => r.token), ['fcm-1']);
      expect(await PushRegistrationStore(store).read(), isNull);
      await next.dispose();
    });

    test('getToken gagal setelah auto-init menyala: sesi yang berakhir di peluncuran berikutnya tetap menghapus token '
        'dan mematikan auto-init', () async {
      platform.tokenError = FirebaseException(plugin: 'firebase_messaging', code: 'unknown');
      await service.onSignedIn('user-1');
      expect(platform.autoInitEnabled, isTrue);
      expect(registered, isEmpty);
      await service.dispose();

      // Peluncuran berikutnya: sesi gagal dipulihkan sebelum login lagi (tanpa onSignedIn di proses ini).
      final next = build();
      platform.calls.clear();
      await next.onSignedOut();
      expect(platform.calls, ['deleteToken', 'autoInit:false']);
      expect(platform.autoInitEnabled, isFalse);
      await next.dispose();
    });

    test('mematikan auto-init gagal: catatan tertunda dipertahankan dan langkahnya diulang', () async {
      await service.onSignedIn('user-1');
      platform.autoInitError = Exception('uji');
      await service.onSignedOut();
      expect(platform.autoInitEnabled, isTrue);
      expect((await PushRegistrationStore(store).read())?.pendingUnregister, isTrue);

      platform.autoInitError = null;
      await service.retryPendingUnregister();
      expect(platform.autoInitEnabled, isFalse);
      expect(await PushRegistrationStore(store).read(), isNull);
    });
  });

  group('izin notifikasi dicabut kemudian di pengaturan sistem (K8 lanjutan, AC F13-5)', () {
    FirebaseException apnsTokenNotSet() => FirebaseException(plugin: 'firebase_messaging', code: 'apns-token-not-set');

    Future<PushRegistration?> record() => PushRegistrationStore(store).read();

    /// Urutan pencabutan: token yang sudah ada diambil, dicabut di server, lalu dihapus di perangkat dan auto-init
    /// dimatikan.
    const released = ['getToken', 'unregister:fcm-1', 'deleteToken', 'autoInit:false'];

    test(
      'aplikasi dibuka dengan sesi setelah izin dicabut: token dicabut di server lalu dihapus di perangkat',
      () async {
        await service.onSignedIn('user-1');
        await service.dispose();

        // Peluncuran berikutnya: izin dicabut di pengaturan sistem selama aplikasi tertutup.
        platform.permission = PushPermission.denied;
        platform.calls.clear();
        final next = build();
        addTearDown(next.dispose);
        await next.onSignedIn('user-1');
        await pumpEventQueue();
        expect(platform.calls, released);
        expect(unregistered, ['fcm-1'], reason: 'token yang terdaftar, bukan token baru');
        expect(platform.autoInitEnabled, isFalse);
        expect(await record(), isNull);
        expect(registered.map((r) => r.token), ['fcm-1'], reason: 'tidak ada pendaftaran baru');
      },
    );

    test('aplikasi kembali ke latar depan setelah izin dicabut: izin dibaca tanpa dialog lalu token dicabut', () async {
      await service.onSignedIn('user-1');
      platform.calls.clear();
      platform.permission = PushPermission.denied;
      final reads = platform.permissionReads;
      await service.onResumed();
      expect(platform.permissionRequests, 1, reason: 'izin hanya dibaca, dialog tidak dimunculkan');
      expect(platform.permissionReads, reads + 1);
      expect(service.permission, PushPermission.denied);
      expect(platform.calls, released);
      expect(platform.autoInitEnabled, isFalse);
      expect(await record(), isNull);

      // Kembali lagi atau koneksi kembali tanpa perubahan izin: tidak ada token untuk dicabut.
      await service.onResumed();
      await service.retryPendingUnregister();
      expect(platform.calls, released);
    });

    test('izin diberikan lagi lalu aplikasi kembali ke latar depan: token baru didaftarkan sekali', () async {
      await service.onSignedIn('user-1');
      platform.permission = PushPermission.denied;
      await service.onResumed();
      platform.calls.clear();

      platform.permission = PushPermission.granted;
      await service.onResumed();
      expect(platform.calls, ['autoInit:true', 'getToken']);
      expect(registered.map((r) => r.token), ['fcm-1', 'fcm-2']);
      expect(await record(), isA<PushRegistration>().having((r) => r.userId, 'user', 'user-1'));
      expect(service.permission, PushPermission.granted);

      await service.onResumed();
      expect(platform.calls, ['autoInit:true', 'getToken'], reason: 'token sudah terdaftar');
      expect(platform.permissionRequests, 1);
    });

    test('izin ditolak saat login lalu diberikan di pengaturan: token didaftarkan saat aplikasi kembali', () async {
      platform.permission = PushPermission.denied;
      await service.onSignedIn('user-1');
      expect(platform.calls, isEmpty);

      platform.permission = PushPermission.granted;
      await service.onResumed();
      expect(platform.calls, ['autoInit:true', 'getToken']);
      expect(registered.single.token, 'fcm-1');
    });

    test(
      'izin ditolak sejak login tanpa catatan pendaftaran: tanpa request dan tanpa getToken (tidak berubah)',
      () async {
        platform.permission = PushPermission.denied;
        await service.onSignedIn('user-1');
        await service.onResumed();
        await service.retryPendingUnregister();
        platform.tokenRefresh.add('fcm-lain');
        await pumpEventQueue();
        expect(platform.tokenRequests, 0);
        expect(platform.calls, isEmpty);
        expect(unregistered, isEmpty);
        expect(registered, isEmpty);
        expect(platform.autoInitEnabled, isFalse);
      },
    );

    test('izin terbaca notDetermined saat aplikasi kembali (Android 13+ setelah dicabut) dianggap ditolak', () async {
      await service.onSignedIn('user-1');
      platform.calls.clear();
      platform.permission = PushPermission.notDetermined;
      await service.onResumed();
      expect(service.permission, PushPermission.denied);
      expect(platform.calls, released);
    });

    test('POST /devices/unregister gagal (offline): catatan, token, dan auto-init dipertahankan, lalu pencabutan '
        'diulang saat koneksi kembali', () async {
      await service.onSignedIn('user-1');
      platform.permission = PushPermission.denied;
      beforeUnregister = () async => throw networkError();
      await expectLater(service.onResumed(), completes);
      expect(unregistered, isEmpty);
      expect(platform.deletes, 0, reason: 'nilai token masih dibutuhkan untuk mencabutnya di server');
      expect(platform.autoInitEnabled, isTrue);
      expect(
        await record(),
        isA<PushRegistration>()
            .having((r) => r.userId, 'user', 'user-1')
            .having((r) => r.pendingUnregister, 'pending', isFalse),
      );

      // Koneksi kembali: sessionServicesProvider memanggil retryPendingUnregister.
      beforeUnregister = () async {};
      await service.retryPendingUnregister();
      expect(unregistered, ['fcm-1']);
      expect(platform.deletes, 1);
      expect(platform.autoInitEnabled, isFalse);
      expect(await record(), isNull);
    });

    test('penghapusan di perangkat gagal setelah token dicabut di server: seluruh langkah diulang', () async {
      await service.onSignedIn('user-1');
      platform.permission = PushPermission.denied;
      platform.offline = true;
      await service.onResumed();
      expect(unregistered, ['fcm-1']);
      expect(platform.deletes, 0);
      expect(platform.autoInitEnabled, isTrue);
      expect(await record(), isNotNull);

      platform.offline = false;
      await service.onResumed();
      expect(unregistered, ['fcm-1', 'fcm-1'], reason: 'token yang sama; server tetap menjawab 204');
      expect(platform.deletes, 1);
      expect(platform.autoInitEnabled, isFalse);
      expect(await record(), isNull);
    });

    test('iOS: token APNs belum ada saat pencabutan: diulang berjeda di antrean yang sama', () {
      fakeAsync((async) {
        rebuild();
        unawaited(service.onSignedIn('user-1'));
        async.flushMicrotasks();
        expect(registered.single.token, 'fcm-1');

        platform.permission = PushPermission.denied;
        platform.tokenError = apnsTokenNotSet();
        unawaited(service.onResumed());
        async.flushMicrotasks();
        expect(unregistered, isEmpty);
        expect(platform.deletes, 0);

        platform.tokenError = null;
        async.elapse(PushService.apnsRetryDelays.first);
        expect(unregistered, ['fcm-1']);
        expect(platform.deletes, 1);
        expect(platform.autoInitEnabled, isFalse);
        expect(async.pendingTimers, isEmpty);
      });
    });

    test(
      'iOS: percobaan ulang habis: token yang tiba lewat onTokenRefresh menuntaskan pencabutan, tidak didaftarkan',
      () {
        fakeAsync((async) {
          rebuild();
          unawaited(service.onSignedIn('user-1'));
          async.flushMicrotasks();
          platform.permission = PushPermission.denied;
          platform.tokenError = apnsTokenNotSet();
          unawaited(service.onResumed());
          async.elapse(const Duration(seconds: 30));
          expect(async.pendingTimers, isEmpty);
          expect(unregistered, isEmpty);

          platform.tokenError = null;
          platform.tokenRefresh.add('fcm-1');
          async.flushMicrotasks();
          expect(unregistered, ['fcm-1']);
          expect(platform.deletes, 1);
          expect(registered.map((r) => r.token), ['fcm-1']);
          expect(store.values.containsKey(PushRegistrationStore.storageKey), isFalse);
        });
      },
    );

    test(
      'keluar saat pencabutan di server masih berjalan: keluar menunggu gilirannya lalu tetap menghapus token',
      () async {
        await service.onSignedIn('user-1');
        platform.permission = PushPermission.denied;
        final request = Completer<void>();
        beforeUnregister = () => request.future;
        final resumed = service.onResumed();
        await pumpEventQueue();
        expect(platform.calls.last, 'getToken');

        final signedOut = service.onSignedOut();
        await pumpEventQueue();
        expect(platform.deletes, 0, reason: 'akhir sesi berjalan setelah langkah sebelumnya di antrean');

        // Sesi sudah berakhir saat request berjalan, sehingga request gagal; akhir sesi tetap menghapus token.
        request.completeError(networkError());
        await resumed;
        await signedOut;
        expect(unregistered, isEmpty);
        expect(platform.deletes, 1);
        expect(platform.autoInitEnabled, isFalse);
        expect(await record(), isNull);
        expect(platform.tokenRefresh.hasListener, isFalse);
      },
    );

    test(
      'berganti akun saat pencabutan berjalan: token akun lama dicabut dan dihapus, akun baru mendapat token baru',
      () async {
        await service.onSignedIn('user-1');
        platform.permission = PushPermission.denied;
        final request = Completer<void>();
        beforeUnregister = () => request.future;
        final resumed = service.onResumed();
        await pumpEventQueue();

        // sessionServicesProvider: keluar dari akun lama lalu masuk akun baru, yang mengizinkan notifikasi lagi.
        final signedOut = service.onSignedOut();
        final signedIn = service.onSignedIn('user-2');
        platform.permission = PushPermission.granted;
        request.complete();
        await Future.wait([resumed, signedOut, signedIn]);
        expect(unregistered, ['fcm-1']);
        expect(registered.map((r) => r.token), [
          'fcm-1',
          'fcm-3',
        ], reason: 'token lama tidak didaftarkan untuk akun baru');
        expect(
          await record(),
          isA<PushRegistration>()
              .having((r) => r.userId, 'user', 'user-2')
              .having((r) => r.pendingUnregister, 'pending', isFalse),
        );
        expect(platform.autoInitEnabled, isTrue);
      },
    );
  });

  test('gagal mendaftarkan perangkat tidak mengganggu sesi', () async {
    final failing = PushService(
      platform: platform,
      registerDevice: (_) async => throw networkError(),
      unregisterDevice: (_) async {},
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
          unregisterDevice: (_) async {},
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
