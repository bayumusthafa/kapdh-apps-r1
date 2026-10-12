import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Penyimpanan kunci-nilai rahasia (token sesi, snapshot /me, cache KTA, kunci idempotensi; PRD 5.2).
///
/// Abstraksi ini memungkinkan uji tanpa plugin dan memastikan setiap pemilik kunci hanya menghapus kuncinya
/// sendiri (tidak ada `deleteAll` yang ikut menghapus data lain).
abstract interface class SecureStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Implementasi flutter_secure_storage dengan opsi platform eksplisit.
///
/// - Android: EncryptedSharedPreferences (kunci di Android Keystore). Folder data aplikasi dikecualikan dari
///   cadangan otomatis (`allowBackup=false`, `data_extraction_rules.xml`) sehingga token tidak ikut dipulihkan ke
///   perangkat lain.
/// - iOS: Keychain `first_unlock_this_device`: dapat dibaca setelah buka kunci pertama (proses latar push) dan
///   tidak ikut cadangan/iCloud Keychain ke perangkat lain.
class FlutterSecureStore implements SecureStore {
  FlutterSecureStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage(aOptions: android, iOptions: ios);

  static const AndroidOptions android = AndroidOptions(encryptedSharedPreferences: true);
  static const IOSOptions ios = IOSOptions(
    accessibility: KeychainAccessibility.first_unlock_this_device,
    synchronizable: false,
  );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Penyimpanan di memori untuk uji dan pratinjau; isi hilang saat proses berakhir.
class MemorySecureStore implements SecureStore {
  MemorySecureStore([Map<String, String>? initial]) : values = <String, String>{...?initial};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// Antrean serial sederhana: operasi baca-ubah-tulis pada satu kunci tidak saling menimpa.
class SerialQueue {
  Future<void> _tail = Future<void>.value();

  Future<T> run<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }
}
