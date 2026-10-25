import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/core/config/push_config.dart';
import 'package:kapdh_mobile/core/push/push_platform.dart';

/// Kanal `MethodChannelFirebaseMessaging` (firebase_messaging_platform_interface).
const _messagingChannel = MethodChannel('plugins.flutter.io/firebase_messaging');

/// Kanal pigeon `FirebaseCoreHostApi.initializeCore` (firebase_core_platform_interface 8.x).
const _initializeCoreChannel = 'dev.flutter.pigeon.firebase_core_platform_interface.FirebaseCoreHostApi.initializeCore';

/// Nilai berkode khusus pigeon firebase_core: tipe 129 = `CoreFirebaseOptions`, 130 = `CoreInitializeResponse`, keduanya
/// dikirim sebagai daftar field.
class _PigeonValue {
  const _PigeonValue(this.type, this.fields);

  final int type;
  final List<Object?> fields;
}

/// Tiruan codec pigeon firebase_core, supaya uji tidak mengimpor paket platform interface yang hanya dependensi
/// transitif.
class _FirebaseCoreCodec extends StandardMessageCodec {
  const _FirebaseCoreCodec();

  @override
  void writeValue(WriteBuffer buffer, Object? value) {
    if (value is _PigeonValue) {
      buffer.putUint8(value.type);
      writeValue(buffer, value.fields);
    } else {
      super.writeValue(buffer, value);
    }
  }

  @override
  Object? readValueOfType(int type, ReadBuffer buffer) => type == 129 || type == 130
      ? _PigeonValue(type, readValue(buffer)! as List<Object?>)
      : super.readValueOfType(type, buffer);
}

/// Aplikasi Firebase bawaan seperti yang dilaporkan plugin native saat `initializeCore`, dengan auto-init FCM mati
/// (AndroidManifest.xml, Info.plist).
ByteData? _initializeCoreReply() {
  // apiKey, appId, messagingSenderId, projectId, lalu 10 field opsional.
  final options = _PigeonValue(129, ['kunci-uji', '1:1:ios:1', '1', 'kapdh-uji', ...List<Object?>.filled(10, null)]);
  // name, options, isAutomaticDataCollectionEnabled, pluginConstants.
  final app = _PigeonValue(130, [
    '[DEFAULT]',
    options,
    false,
    {
      'plugins.flutter.io/firebase_messaging': {'AUTO_INIT_ENABLED': false},
    },
  ]);
  return const _FirebaseCoreCodec().encodeMessage([
    [app],
  ]);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  /// Metode kanal firebase_messaging yang dipanggil, berurutan.
  final calls = <String>[];

  /// Token APNs yang dilaporkan plugin iOS; null = belum diterima perangkat.
  String? apnsToken;
  late FirebasePushPlatform platform;

  setUpAll(() async {
    messenger.setMockMessageHandler(_initializeCoreChannel, (_) async => _initializeCoreReply());
    await Firebase.initializeApp();
  });

  tearDownAll(() => messenger.setMockMessageHandler(_initializeCoreChannel, null));

  setUp(() {
    calls.clear();
    apnsToken = null;
    messenger.setMockMethodCallHandler(_messagingChannel, (call) async {
      calls.add(call.method);
      return switch (call.method) {
        'Messaging#setAutoInitEnabled' => {'isAutoInitEnabled': (call.arguments as Map<Object?, Object?>)['enabled']},
        'Messaging#getAPNSToken' => {'token': apnsToken},
        _ => null,
      };
    });
    platform = FirebasePushPlatform(const PushConfig.disabled());
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(_messagingChannel, null);
    debugDefaultTargetPlatformOverride = null;
  });

  /// Menyetel auto-init lewat plugin (nilai yang dibaca `isAutoInitEnabled`), lalu mengosongkan catatan panggilan.
  Future<void> autoInit(bool enabled) async {
    await platform.setAutoInitEnabled(enabled);
    expect(calls, ['Messaging#setAutoInitEnabled']);
    calls.clear();
  }

  group('iOS: deleteToken', () {
    setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.iOS);

    test('auto-init mati dan token APNs belum ada: no-op, Messaging#deleteToken tidak dipanggil', () async {
      await autoInit(false);
      await platform.deleteToken();
      expect(calls, isNot(contains('Messaging#deleteToken')));
    });

    test('auto-init menyala: Messaging#deleteToken dipanggil', () async {
      await autoInit(true);
      apnsToken = 'apns-1';
      await platform.deleteToken();
      expect(calls, contains('Messaging#deleteToken'));
    });

    test(
      'auto-init menyala tanpa token APNs: galat apns-token-not-set diteruskan agar PushService mengulang',
      () async {
        await autoInit(true);
        await expectLater(
          platform.deleteToken(),
          throwsA(isA<FirebaseException>().having((error) => error.code, 'code', 'apns-token-not-set')),
        );
        expect(calls, isNot(contains('Messaging#deleteToken')));
      },
    );

    test('auto-init mati tetapi token APNs ada: Messaging#deleteToken tetap dipanggil', () async {
      await autoInit(false);
      apnsToken = 'apns-1';
      await platform.deleteToken();
      expect(calls, contains('Messaging#deleteToken'));
    });
  });

  test('Android: deleteToken langsung memanggil Messaging#deleteToken walau auto-init mati', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await autoInit(false);
    await platform.deleteToken();
    expect(calls, ['Messaging#deleteToken']);
  });
}
