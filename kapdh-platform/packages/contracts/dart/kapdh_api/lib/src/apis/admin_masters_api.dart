// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pengelolaan master profesi dan keahlian ("Manajemen Skill & Profesi", guideline hal. 16); master terpakai
/// dinonaktifkan, tidak dihapus (F-10, F-15, AC F10-4).
///
///
/// Kelas API untuk tag kontrak "Admin Masters". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminMastersApi {
  const AdminMastersApi(this._dio);

  final Dio _dio;

  /// Daftar master (aktif dan nonaktif) dengan jumlah pemakaian, paging dan total (F-15, AC F10-4).
  ///
  /// Dibutuhkan dua area pengurus: halaman "Manajemen Skill & Profesi" (master.manage) dan filter profesi/
  /// keahlian pada daftar anggota (members.read). Karena itu cukup SALAH SATU izin tersebut
  /// (`permissions_any`); admin tanpa keduanya (mis. hanya payments.* atau events.*) ditolak 403 FORBIDDEN
  /// (AC F15-1, PRD 2.3). Perubahan tetap memerlukan master.manage. `usage_count` = jumlah alumni yang memakai
  /// master ini; master dengan usage_count > 0 tidak dapat dihapus.
  ///
  /// [kind]: Jenis master terkontrol (professions atau skills).
  /// [q]: Cari label (tidak peka huruf besar).
  /// [active]: true hanya aktif, false hanya nonaktif; kosong untuk semua.
  /// [sort]: Urutan (bawaan manual = sort_order lalu label).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/masters/{kind}` (operationId `adminListMasters`).
  Future<AdminMasterPage> adminListMasters(
    MasterKind kind, {
    String? q,
    bool? active,
    AdminMasterSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListMasters',
        method: 'GET',
        path: '/admin/masters/${Uri.encodeComponent(kind.toJson())}',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          'active': ?active,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminMasterPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tambah master profesi atau keahlian (izin master.manage, F-15).
  ///
  /// Server memangkas spasi tepi label lalu memeriksa panjang 1-100 karakter. Label yang sudah ada pada
  /// jenis yang sama (tanpa membedakan huruf besar/kecil, termasuk master nonaktif) ditolak 409
  /// VALIDATION_ERROR dengan field_errors.label; aktifkan kembali master lama sebagai gantinya. Audit
  /// `master.created`.
  ///
  /// [kind]: Jenis master terkontrol (professions atau skills).
  ///
  /// `POST /admin/masters/{kind}` (operationId `adminCreateMaster`).
  Future<AdminMasterItem> adminCreateMaster(
    MasterKind kind,
    AdminMasterCreate body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreateMaster',
        method: 'POST',
        path: '/admin/masters/${Uri.encodeComponent(kind.toJson())}',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => AdminMasterItem.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail master untuk formulir ubah, termasuk version dan jumlah pemakaian (F-15).
  ///
  /// [kind]: Jenis master terkontrol (professions atau skills).
  ///
  /// `GET /admin/masters/{kind}/{masterId}` (operationId `adminGetMaster`).
  Future<AdminMasterItem> adminGetMaster(
    MasterKind kind,
    String masterId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetMaster',
        method: 'GET',
        path: '/admin/masters/${Uri.encodeComponent(kind.toJson())}/${Uri.encodeComponent(masterId)}',
        authRequired: true,
        decode: (Object? v0) => AdminMasterItem.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus master yang belum pernah dipakai; master terpakai ditolak dan disarankan dinonaktifkan (AC F10-4).
  ///
  /// UI wajib meminta konfirmasi (PRD 4.5). Master yang masih dipakai alumni (FK RESTRICT; kode DB 23503 di
  /// PostgreSQL 17 atau 23001 di PostgreSQL 18) ditolak 409 VALIDATION_ERROR dengan pesan untuk
  /// menonaktifkan, dan `current` berisi AdminMasterItem terbaru (usage_count). Versi berbeda dari If-Match ->
  /// 409 VERSION_CONFLICT. Audit `master.deleted`.
  ///
  /// [kind]: Jenis master terkontrol (professions atau skills).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/masters/{kind}/{masterId}` (operationId `adminDeleteMaster`).
  Future<void> adminDeleteMaster(
    MasterKind kind,
    String masterId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeleteMaster',
        method: 'DELETE',
        path: '/admin/masters/${Uri.encodeComponent(kind.toJson())}/${Uri.encodeComponent(masterId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah label, status aktif atau urutan master (izin master.manage, AC F10-4, F15-4).
  ///
  /// Menonaktifkan master menghentikan pemilihan baru (GET /masters/{kind} hanya aktif) tetapi profil yang
  /// sudah memakainya tetap menampilkan label historis (AC F10-4). Mengganti label berlaku untuk semua profil
  /// yang memakai master tersebut. Label ganda -> 409 VALIDATION_ERROR (field_errors.label). Versi berbeda
  /// dari If-Match -> 409 VERSION_CONFLICT dengan `current` berbentuk AdminMasterItem (AC F15-4). Audit
  /// `master.updated` dengan before/after.
  ///
  /// [kind]: Jenis master terkontrol (professions atau skills).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/masters/{kind}/{masterId}` (operationId `adminUpdateMaster`).
  Future<AdminMasterItem> adminUpdateMaster(
    MasterKind kind,
    String masterId,
    AdminMasterUpdate body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateMaster',
        method: 'PATCH',
        path: '/admin/masters/${Uri.encodeComponent(kind.toJson())}/${Uri.encodeComponent(masterId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMasterItem.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
