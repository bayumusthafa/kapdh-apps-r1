import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/cache/kta_cache_store.dart';
import '../../core/config/clock.dart';
import '../../core/session/session_controller.dart';

/// Keadaan layar KTA (F-05).
@immutable
sealed class KtaView {
  const KtaView();
}

final class KtaLoading extends KtaView {
  const KtaLoading();
}

/// Kartu terbaru dari server (GET /me/card). Respons ini juga disimpan ke cache offline.
final class KtaOnline extends KtaView {
  const KtaOnline(this.card);

  final MemberCard card;
}

/// Server tidak terjangkau dan cache masih sah (AC F05-2): kartu tampil berlabel Offline beserta waktu sinkronisasi;
/// bukan bukti status saat ini.
final class KtaOffline extends KtaView {
  const KtaOffline({required this.card, required this.syncedAt, required this.qrUsable, required this.error});

  final MemberCard card;
  final DateTime syncedAt;

  /// QR hanya tampil bila token QR belum kedaluwarsa (verifikasi publik tetap memakai status server, AC F05-4).
  final bool qrUsable;
  final ApiException error;
}

/// Kartu tidak dapat ditampilkan. [reason] diisi bila server tidak terjangkau dan cache tidak boleh tampil
/// (AC F05-3); null bila server menjawab galat lain.
final class KtaUnavailable extends KtaView {
  const KtaUnavailable({required this.error, this.reason});

  final ApiException error;
  final KtaCacheMissReason? reason;
}

/// Server tidak terjangkau (tanpa respons, respons rusak, atau 5xx): hanya kondisi ini yang boleh memakai cache
/// offline. Galat lain (mis. 401, 404) berasal dari server yang menjawab sehingga cache tidak dipakai.
bool canUseOfflineCache(ApiException error) {
  if (error.kind == ApiFailureKind.network || error.kind == ApiFailureKind.invalidResponse) return true;
  if (error.kind != ApiFailureKind.api) return false;
  return (error.statusCode ?? 0) >= 500;
}

/// Aturan tampilan cache tambahan dari kontrak C2: kartu aktif hanya boleh tampil offline sampai
/// `offline_valid_until` = min(synced_at + 7 hari, expires_at, qr.token_expires_at); null berarti tidak boleh tampil
/// aktif secara offline (AC F05-2, F05-3). Kartu Tidak Aktif tetap boleh tampil (tidak pernah tampil aktif).
bool offlineDisplayAllowed(MemberCard card, DateTime now) {
  final active = card.statusLabel == MemberCardStatus.active || card.statusLabel == MemberCardStatus.expiring;
  if (!active) return card.statusLabel == MemberCardStatus.inactive;
  final until = card.offlineValidUntil;
  return until != null && now.toUtc().isBefore(until.toUtc());
}

/// Sinkronisasi KTA: ambil kartu dari server, simpan ke cache, atau jatuh ke cache offline sesuai aturan
/// AC F05-2..F05-4 bila server tidak terjangkau.
class KtaSync {
  KtaSync({required MeApi me, required KtaCacheStore cache, required Clock clock})
    : _me = me,
      _cache = cache,
      _clock = clock;

  final MeApi _me;
  final KtaCacheStore _cache;
  final Clock _clock;

  Future<KtaView> sync({required String userId}) async {
    try {
      final card = await _me.getMyCard();
      try {
        // Kartu berstatus dibatasi juga disimpan agar menggantikan kartu aktif lama (AC F05-4).
        await _cache.save(userId: userId, card: card);
      } on Object catch (error) {
        debugPrint('kta: cache offline gagal disimpan (${error.runtimeType})');
      }
      return KtaOnline(card);
    } on ApiException catch (error) {
      if (!canUseOfflineCache(error)) return KtaUnavailable(error: error);
      return readOffline(userId: userId, error: error);
    }
  }

  /// Membaca cache offline untuk [userId] setelah [error] jaringan.
  Future<KtaView> readOffline({required String userId, required ApiException error}) async {
    final KtaCacheResult result;
    try {
      result = await _cache.read(userId: userId);
    } on Object catch (storageError) {
      debugPrint('kta: cache offline gagal dibaca (${storageError.runtimeType})');
      return KtaUnavailable(error: error, reason: KtaCacheMissReason.empty);
    }
    switch (result) {
      case KtaCacheMiss(:final reason):
        return KtaUnavailable(error: error, reason: reason);
      case KtaCacheHit(:final card, :final syncedAt, :final qrUsable):
        if (!offlineDisplayAllowed(card, _clock())) {
          // Kartu yang tidak boleh tampil offline tidak disimpan lebih lama (AC F05-3). Kartu kedaluwarsa diberi
          // alasan sendiri agar pengguna diarahkan memeriksa status/perpanjangan, bukan sekadar sinkron ulang.
          await _cache.clear();
          final reason = card.statusLabel == MemberCardStatus.expired
              ? KtaCacheMissReason.membershipExpired
              : KtaCacheMissReason.stale;
          return KtaUnavailable(error: error, reason: reason);
        }
        return KtaOffline(card: card, syncedAt: syncedAt, qrUsable: qrUsable, error: error);
    }
  }
}

final ktaSyncProvider = Provider<KtaSync>(
  (ref) => KtaSync(
    me: ref.watch(kapdhApiProvider).me,
    cache: ref.watch(ktaCacheStoreProvider),
    clock: ref.watch(clockProvider),
  ),
);
