import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../storage/secure_store.dart';

/// Snapshot GET /me terakhir untuk fase `offlineLastKnown` (ARCHITECTURE §8.3): saat aplikasi dibuka tanpa
/// koneksi, pengguna tetap masuk dengan status terakhir yang diketahui (mis. untuk KTA offline) dan tidak
/// dikeluarkan. Bukan bukti status saat ini; server tetap menegakkan akses di setiap request.
@immutable
class MeSnapshot {
  const MeSnapshot({required this.me, required this.fetchedAt});

  final Me me;
  final DateTime fetchedAt;
}

class MeSnapshotStore {
  MeSnapshotStore(this._store);

  static const storageKey = 'kapdh.me_snapshot.v1';

  final SecureStore _store;

  Future<void> save(Me me, DateTime fetchedAt) => _store.write(
        storageKey,
        jsonEncode(<String, Object?>{'me': me.toJson(), 'fetched_at': fetchedAt.toUtc().toIso8601String()}),
      );

  Future<MeSnapshot?> read() async {
    final raw = await _store.read(storageKey);
    if (raw == null) return null;
    try {
      final json = jsonDecode(raw) as Map<String, Object?>;
      return MeSnapshot(
        me: Me.fromJson(json['me']! as Map<String, Object?>),
        fetchedAt: DateTime.parse(json['fetched_at']! as String).toUtc(),
      );
    } on Object {
      await clear();
      return null;
    }
  }

  Future<void> clear() => _store.delete(storageKey);
}
