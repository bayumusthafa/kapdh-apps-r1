import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../config/clock.dart';
import '../storage/secure_store.dart';

/// Alasan cache KTA tidak boleh ditampilkan (AC F05-3, F05-4).
enum KtaCacheMissReason {
  /// Belum pernah tersinkron.
  empty,

  /// Cache milik akun lain (berganti akun); cache langsung dihapus.
  otherAccount,

  /// Lebih tua dari 7 hari sejak sinkronisasi terakhir.
  stale,

  /// Masa keanggotaan pada kartu sudah lewat (now >= expires_at).
  membershipExpired,

  /// Kartu tersinkron dengan status dibatasi; tidak pernah tampil sebagai aktif.
  restricted,

  /// Jam perangkat lebih awal daripada waktu sinkronisasi server (indikasi jam dimundurkan).
  clockSkew,
}

/// Hasil pembacaan cache KTA offline.
@immutable
sealed class KtaCacheResult {
  const KtaCacheResult();
}

@immutable
final class KtaCacheHit extends KtaCacheResult {
  const KtaCacheHit({required this.card, required this.syncedAt, required this.qrUsable});

  final MemberCard card;

  /// Waktu sinkronisasi dari server (`synced_at`), ditampilkan "Offline. Tersinkron …".
  final DateTime syncedAt;

  /// QR hanya ditampilkan bila token QR belum kedaluwarsa; verifikasi tetap memakai status server (AC F05-4).
  final bool qrUsable;
}

@immutable
final class KtaCacheMiss extends KtaCacheResult {
  const KtaCacheMiss(this.reason);

  final KtaCacheMissReason reason;
}

/// Cache KTA offline (AC F05-2..F05-4, ARCHITECTURE §8.3): kartu terakhir + `synced_at` + user id.
///
/// Aturan baca: hanya untuk akun yang sama, paling lama 7 hari sejak sinkronisasi, sebelum `expires_at`, dan bukan
/// status dibatasi. Tampilan offline selalu berlabel "Offline" dan bukan bukti status saat ini. Cache dihapus saat
/// logout atau berganti akun. Disimpan di secure storage karena memuat data pribadi dan URL token QR.
class KtaCacheStore {
  KtaCacheStore(this._store, {Clock clock = systemClock}) : _clock = clock;

  static const storageKey = 'kapdh.kta_card.v1';

  /// Batas umur cache (PRD 3.5, disahkan v3.2).
  static const maxAge = Duration(days: 7);

  /// Toleransi selisih jam perangkat terhadap server.
  static const clockTolerance = Duration(minutes: 5);

  final SecureStore _store;
  final Clock _clock;

  /// Menyimpan kartu hasil GET /me/card untuk [userId]. Kartu berstatus dibatasi menggantikan cache lama sehingga
  /// kartu aktif lama tidak tampil lagi (AC F05-4).
  Future<void> save({required String userId, required MemberCard card}) =>
      _store.write(storageKey, jsonEncode(<String, Object?>{'user_id': userId, 'card': card.toJson()}));

  Future<KtaCacheResult> read({required String userId}) async {
    final raw = await _store.read(storageKey);
    if (raw == null) return const KtaCacheMiss(KtaCacheMissReason.empty);
    final String cachedUser;
    final MemberCard card;
    try {
      final json = jsonDecode(raw) as Map<String, Object?>;
      cachedUser = json['user_id']! as String;
      card = MemberCard.fromJson(json['card']! as Map<String, Object?>);
    } on Object {
      await clear();
      return const KtaCacheMiss(KtaCacheMissReason.empty);
    }
    if (cachedUser != userId) {
      await clear();
      return const KtaCacheMiss(KtaCacheMissReason.otherAccount);
    }
    final result = evaluate(card, now: _clock());
    if (result case KtaCacheMiss(:final reason) when reason != KtaCacheMissReason.clockSkew) {
      // Data pribadi yang tidak boleh tampil lagi tidak disimpan lebih lama (AC F05-3, F05-4). Selisih jam tidak
      // menghapus: cache kembali sah setelah jam perangkat benar.
      await clear();
    }
    return result;
  }

  /// Aturan baca murni (diuji terpisah).
  static KtaCacheResult evaluate(MemberCard card, {required DateTime now}) {
    final nowUtc = now.toUtc();
    final syncedAt = card.syncedAt.toUtc();
    if (card.statusLabel == MemberCardStatus.suspended) {
      return const KtaCacheMiss(KtaCacheMissReason.restricted);
    }
    if (nowUtc.isBefore(syncedAt.subtract(clockTolerance))) {
      return const KtaCacheMiss(KtaCacheMissReason.clockSkew);
    }
    if (nowUtc.difference(syncedAt) > maxAge) return const KtaCacheMiss(KtaCacheMissReason.stale);
    final expiresAt = card.expiresAt?.toUtc();
    if (expiresAt != null && !nowUtc.isBefore(expiresAt)) {
      return const KtaCacheMiss(KtaCacheMissReason.membershipExpired);
    }
    final qr = card.qr;
    final active = card.statusLabel == MemberCardStatus.active || card.statusLabel == MemberCardStatus.expiring;
    final qrUsable = active && qr != null && nowUtc.isBefore(qr.tokenExpiresAt.toUtc());
    return KtaCacheHit(card: card, syncedAt: syncedAt, qrUsable: qrUsable);
  }

  Future<void> clear() => _store.delete(storageKey);
}
