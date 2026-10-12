import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token sesi di secure storage (PRD 5.2). Logout menghapus token dan cache KTA.
class TokenStore {
  TokenStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  String? _access;

  static const _kAccess = 'kapdh_access_token';
  static const _kRefresh = 'kapdh_refresh_token';

  Future<String?> accessToken() async => _access ??= await _storage.read(key: _kAccess);
  Future<String?> refreshToken() => _storage.read(key: _kRefresh);

  Future<void> save({required String access, String? refresh}) async {
    _access = access;
    await _storage.write(key: _kAccess, value: access);
    if (refresh != null) await _storage.write(key: _kRefresh, value: refresh);
  }

  Future<void> clear() async {
    _access = null;
    await _storage.deleteAll();
  }
}
