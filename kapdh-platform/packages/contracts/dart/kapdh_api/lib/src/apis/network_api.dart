// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Direktori anggota aktif dan profil anggota lain; field tersembunyi tidak ikut payload (F-10, AC F10-2).
///
/// Kelas API untuk tag kontrak "Network". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class NetworkApi {
  const NetworkApi(this._dio);

  final Dio _dio;

  /// Cari dan filter direktori anggota aktif dengan paging keyset (F-10, AC F10-1, F10-3).
  ///
  /// Hanya untuk anggota aktif (verified/expiring, tidak suspended). Hasil hanya memuat anggota yang memenuhi
  /// aturan tampil direktori pada saat request (status terkini, bukan cache): users.status=active,
  /// effective_status verified/expiring, tidak suspended, dan show_in_directory=true. Pemanggil sendiri dan
  /// anggota yang memblokir pemanggil tidak ikut hasil.
  ///
  /// Pencarian `q` mencocokkan nama (tanpa membedakan huruf besar/kecil, sebagian kata). Filter angkatan, kelas,
  /// kota, profesi dan keahlian digabung dengan AND; profesi/keahlian memakai ID master terkontrol dari
  /// GET /masters/{kind}. Filter profesi cocok bila SALAH SATU profesi anggota tertaut master itu (profesi boleh
  /// lebih dari satu; ketikan sendiri tidak tertaut master). Master yang sudah nonaktif tetap dapat dipakai
  /// sebagai filter agar anggota dengan label historis tetap dapat ditemukan (AC F10-4).
  ///
  /// Paging keyset stabil tanpa duplikasi antarhalaman (AC F10-1): urutan `name_asc` = (nama, user_id),
  /// `cohort_desc` = (angkatan menurun, nama, user_id). `total` dihitung dengan filter yang sama. Bawaan 30,
  /// maksimum 100 per halaman. Request dibatasi laju untuk mencegah scraping (429 RATE_LIMITED).
  ///
  /// Kartu hasil hanya memuat field kartu guideline p7 (avatar, nama, profesi, kota, pendidikan teratas, keahlian,
  /// kode angkatan); kontak (email, telepon, sosial) tidak pernah ada di hasil pencarian (AC F10-2).
  ///
  /// [q]: Kata kunci nama anggota (minimal 2 karakter setelah dipangkas).
  /// [cohort]: Angkatan (AA pada nomor anggota, PRD 3.5).
  /// [classLevel]: Kelas yang pernah ditempuh (1-3 = 1-3 MTs, 4-6 = 1-3 Aliyah); cocok bila
  /// class_in <= class_level <= class_out.
  /// [city]: Kota domisili; cocok persis tanpa membedakan huruf besar/kecil.
  /// [professionId]: ID master profesi (master_professions).
  /// [skillId]: ID master keahlian (master_skills).
  /// [sort]: Urutan hasil; bawaan name_asc.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /directory` (operationId `searchDirectory`).
  Future<DirectoryPage> searchDirectory({
    String? q,
    int? cohort,
    ClassLevel? classLevel,
    String? city,
    String? professionId,
    String? skillId,
    DirectorySort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'searchDirectory',
        method: 'GET',
        path: '/directory',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          'cohort': ?cohort,
          'class_level': ?classLevel,
          'city': ?city,
          'profession_id': ?professionId,
          'skill_id': ?skillId,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => DirectoryPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Profil anggota lain yang menghormati flag privasi (F-10, AC F10-2, F10-4).
  ///
  /// Hanya untuk anggota aktif. Profil hanya tersedia bila anggota tersebut memenuhi aturan tampil direktori
  /// (lihat GET /directory) dan tidak memblokir pemanggil; selain itu 404 NOT_FOUND tanpa membedakan alasan
  /// (N-09). Pemanggil boleh membuka profilnya sendiri (is_me=true) untuk pratinjau tampilan publik, termasuk
  /// saat show_in_directory=false.
  ///
  /// Privasi (AC F10-2, N-15): `email` hanya dikirim bila show_email=true, `phone` hanya bila show_phone=true,
  /// `social` dan `social_links` hanya bila show_social=true. Bila flag mati, kuncinya tidak ada di payload. Data
  /// administratif (nomor anggota, masa aktif, alasan suspend, kelas masuk/keluar) tidak pernah dikirim; pengurus
  /// berizin membacanya lewat API admin yang diaudit.
  ///
  /// Master profesi/keahlian yang sudah dinonaktifkan tetap ditampilkan sebagai label historis dengan
  /// active=false (AC F10-4). `can_message` false bila salah satu pihak memblokir, atau profil milik sendiri;
  /// alasan tidak dibedakan. `direct_room_id` berisi room direct yang sudah ada antara keduanya (bila ada) agar
  /// tombol "Kirim Pesan" langsung membuka percakapan; bila null, klien memanggil POST /chat/direct.
  ///
  /// [userId]: user_id akun alumni yang dibuka profilnya.
  ///
  /// `GET /directory/{userId}` (operationId `getMemberProfile`).
  Future<NetworkMemberProfile> getMemberProfile(
    String userId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMemberProfile',
        method: 'GET',
        path: '/directory/${Uri.encodeComponent(userId)}',
        authRequired: true,
        decode: (Object? v0) => NetworkMemberProfile.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
