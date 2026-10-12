import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';

import '../support/fakes.dart';

void main() {
  test('access dan refresh token disimpan sebagai SATU nilai JSON (penulisan atomik, PRD 5.2)', () async {
    final storage = MemorySecureStore();
    await TokenStore(storage).save(StoredTokens.fromPair(TokenPair.fromJson(tokenPairJson())));

    expect(storage.values.keys, [TokenStore.storageKey]);
    final json = jsonDecode(storage.values[TokenStore.storageKey]!) as Map<String, Object?>;
    expect(json['access_token'], 'access-1');
    expect(json['refresh_token'], 'refresh-1');
  });

  test('dibaca ulang oleh instance baru (aplikasi dibuka ulang)', () async {
    final storage = MemorySecureStore();
    await TokenStore(storage).save(StoredTokens.fromPair(TokenPair.fromJson(tokenPairJson())));
    final reloaded = await TokenStore(storage).read();
    expect(reloaded?.accessToken, 'access-1');
    expect(reloaded?.accessExpiresAt, testNow.add(const Duration(minutes: 15)));
  });

  test('clear hanya menghapus kunci token', () async {
    final storage = MemorySecureStore({'kapdh.lain': 'x'});
    final store = TokenStore(storage);
    await store.save(StoredTokens.fromPair(TokenPair.fromJson(tokenPairJson())));
    await store.clear();
    expect(storage.values, {'kapdh.lain': 'x'});
    expect(await store.read(), isNull);
  });

  test('nilai rusak dibuang alih-alih dipakai setengah jalan', () async {
    final storage = MemorySecureStore({TokenStore.storageKey: '{"access_token": 5}'});
    expect(await TokenStore(storage).read(), isNull);
    expect(storage.values, isEmpty);
  });

  test('toString tidak membocorkan token (N-14)', () {
    final tokens = StoredTokens.fromPair(TokenPair.fromJson(tokenPairJson()));
    expect(tokens.toString(), isNot(contains('access-1')));
  });

  test('opsi platform eksplisit: Keychain first_unlock_this_device tanpa sinkronisasi iCloud', () {
    expect(FlutterSecureStore.ios.toMap()['accessibility'], 'first_unlock_this_device');
    expect(FlutterSecureStore.ios.toMap()['synchronizable'], 'false');
    expect(FlutterSecureStore.android.toMap()['encryptedSharedPreferences'], 'true');
  });
}
