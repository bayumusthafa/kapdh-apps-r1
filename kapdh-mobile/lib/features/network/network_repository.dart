import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import 'directory_filter.dart';

/// Ukuran halaman direktori (PRD 3.10: bawaan 30, maksimum 100).
const int directoryPageSize = 30;

final networkRepositoryProvider = Provider<NetworkRepository>((ref) => NetworkRepository(ref.watch(kapdhApiProvider)));

/// Akses domain network (network.yaml, F-10) dan master terkontrol (me.yaml `listMasters`) lewat SDK terbangkit.
/// Field privat yang disembunyikan pemiliknya tidak pernah ada di payload (AC F10-2), jadi klien cukup menampilkan
/// yang dikirim server.
class NetworkRepository {
  NetworkRepository(this._api);

  final KapdhApi _api;

  /// Cari/saring direktori dengan paging keyset (AC F10-1). [cursor] null = halaman pertama.
  Future<DirectoryPage> search(DirectoryFilter filter, {String? cursor, int limit = directoryPageSize}) =>
      _api.network.searchDirectory(
        q: filter.query,
        cohort: filter.cohort,
        classLevel: filter.classLevel,
        city: filter.city,
        professionId: filter.profession?.id,
        skillId: filter.skill?.id,
        sort: filter.sort == DirectorySort.nameAsc ? null : filter.sort,
        cursor: cursor,
        limit: limit,
      );

  /// Profil anggota lain sesuai flag privasinya (AC F10-2, F10-4).
  Future<NetworkMemberProfile> profile(String userId) => _api.network.getMemberProfile(userId);

  /// Master profesi/keahlian AKTIF untuk filter (AC F10-4: master nonaktif tidak dapat dipilih baru).
  Future<List<MasterItem>> masters(MasterKind kind) async => (await _api.me.listMasters(kind)).items;
}

/// Master profesi/keahlian untuk lembar filter; dimuat sekali per layar.
final directoryMastersProvider = FutureProvider.autoDispose.family<List<MasterItem>, MasterKind>(
  (ref, kind) => ref.watch(networkRepositoryProvider).masters(kind),
  retry: (_, _) => null,
);
