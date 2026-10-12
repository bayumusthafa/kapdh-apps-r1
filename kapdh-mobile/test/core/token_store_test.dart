import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/config/server_clock.dart';
import 'package:kapdh_mobile/core/storage/secure_store.dart';
import 'package:kapdh_mobile/core/storage/token_store.dart';

import '../support/fakes.dart';

void main() {
  test('gagal baca secure storage tidak disimpan: pemanggilan berikutnya membaca ulang, token tidak dihapus', () async {
    final inner = MemorySecureStore();
    await TokenStore(inner).save(StoredTokens.fromPair(TokenPair.fromJson(tokenPairJson())));
    final flaky = FlakySecureStore(inner);
    final store = TokenStore(flaky);

    await expectLater(store.read(), throwsException);
    expect(store.isLoaded, isFalse);
    expect((await store.read())?.accessToken, 'access-1');
    expect(flaky.reads, 2);
    expect(inner.values.containsKey(TokenStore.storageKey), isTrue);
  });

  test('batas berlaku menurut jam perangkat ikut tersimpan dan dibaca ulang', () async {
    final storage = MemorySecureStore();
    final clock = ServerClock(clock: () => testNow.add(const Duration(hours: 7)))..observe(testNow);
    await TokenStore(storage).save(StoredTokens.received(TokenPair.fromJson(tokenPairJson()), clock));
    final reloaded = await TokenStore(storage).read();
    // Token berlaku 15 menit menurut server = 15 menit dari jam perangkat yang maju 7 jam.
    final expected = testNow.add(const Duration(hours: 7, minutes: 15));
    expect(reloaded?.deviceExpiresAt?.difference(expected).inSeconds.abs(), lessThanOrEqualTo(1));
    expect(reloaded?.clockSkewSuspected, isFalse);
  });

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
