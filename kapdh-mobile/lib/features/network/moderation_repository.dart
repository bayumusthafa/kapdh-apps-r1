import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/idempotency_store.dart';

final moderationRepositoryProvider = Provider<ModerationRepository>(
  (ref) => ModerationRepository(ref.watch(kapdhApiProvider), ref.watch(idempotencyStoreProvider)),
);

/// Akses domain moderation (moderation.yaml, F-12): blokir dua arah dan laporan milik anggota. Keputusan moderasi
/// hanya di web admin (v3.2); aplikasi tidak pernah menerima bukti atau identitas pengurus.
class ModerationRepository {
  ModerationRepository(this._api, this._idempotency);

  final KapdhApi _api;
  final IdempotencyStore _idempotency;

  ModerationApi get _moderation => _api.moderation;

  Future<BlockedMemberPage> listBlocks({String? cursor, int limit = 30}) =>
      _moderation.listBlocks(cursor: cursor, limit: limit);

  /// Blokir idempoten: pesan direct, reaksi di room direct dan undangan grup antara keduanya ditolak dari pihak mana
  /// pun (AC F12-1); riwayat lama tetap dapat dibaca.
  Future<BlockedMember> block(String userId) => _moderation.blockMember(userId);

  /// Buka blokir milik sendiri (idempoten); blokir dari pihak lain tetap berlaku.
  Future<void> unblock(String userId) => _moderation.unblockMember(userId);

  Future<ModerationReportPage> listMyReports({String? cursor, int limit = 30}) =>
      _moderation.listMyReports(cursor: cursor, limit: limit);

  Future<ModerationReport> getMyReport(String reportId) => _moderation.getMyReport(reportId);

  /// Laporan pengguna/pesan/grup (AC F12-2). Idempotency-Key disimpan sampai hasilnya pasti sehingga ketukan ulang
  /// setelah jaringan putus tidak membuat laporan ganda (PRD 4.3).
  Future<ModerationReport> createReport(CreateModerationReportRequest request) => _idempotency.run(
    'moderation.report.${request.targetType.value}',
    request.toJson(),
    (key) => _moderation.createReport(request, idempotencyKey: key),
  );
}
