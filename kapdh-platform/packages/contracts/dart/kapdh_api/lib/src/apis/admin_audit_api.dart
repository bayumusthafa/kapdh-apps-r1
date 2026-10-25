// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pencarian audit dan ekspor CSV asinkron dengan filter yang sama (F-17, AC F17-2..F17-4).
///
/// Kelas API untuk tag kontrak "Admin Audit". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminAuditApi {
  const AdminAuditApi(this._dio);

  final Dio _dio;

  /// Telusuri audit berdasarkan aktor, peran, tindakan, entitas dan waktu (izin audit.read, AC F17-4).
  ///
  /// Semua filter digabung dengan AND dan memakai nama serta arti yang sama dengan body AuditFilter pada POST
  /// /admin/audit/exports, sehingga hasil pencarian dan ekspor identik (AC F17-4). `from` inklusif dan `to`
  /// eksklusif terhadap created_at (UTC); `to` harus setelah `from`. `action`, `entity_type`, `entity_id`
  /// dan `request_id` dicocokkan persis. `actor_q` mencari aktor berdasarkan nama tampilan admin atau nama
  /// lengkap alumni pelaku (mengandung, tanpa membedakan huruf besar/kecil), sehingga pengaudit tanpa izin
  /// admins.manage tetap dapat memfilter aktor; aktor yang sudah dianonimkan (D2) tidak cocok dengan nama.
  /// Urutan bawaan created_at menurun dengan keyset (created_at, id); `total` mengikuti filter. Item daftar
  /// tidak memuat before/after; buka detail untuk melihatnya. Tanpa audit.read ditolak 403 walaupun menu
  /// tersembunyi (AC F17-2).
  ///
  /// [actorQ]: Bagian nama tampilan admin atau nama lengkap alumni pelaku.
  /// [actorAdminId]: Identitas admin pelaku (admins.id).
  /// [actorUserId]: Akun pelaku (users.id), alumni maupun akun login admin.
  /// [action]: Nama tindakan persis, misalnya payment.approved.
  /// [entityType]: Jenis entitas persis, misalnya payment, alumni, admin, event.
  /// [entityId]: Id entitas persis (biasanya UUID).
  /// [requestId]: Penghubung log API/worker (N-14).
  /// [from]: Batas bawah created_at (inklusif, UTC).
  /// [to]: Batas atas created_at (eksklusif, UTC).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/audit/entries` (operationId `adminSearchAudit`).
  Future<AuditEntryPage> adminSearchAudit({
    String? actorQ,
    String? actorAdminId,
    String? actorUserId,
    AuditEffectiveRole? effectiveRole,
    String? action,
    String? entityType,
    String? entityId,
    String? requestId,
    DateTime? from,
    DateTime? to,
    AuditEntrySort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminSearchAudit',
        method: 'GET',
        path: '/admin/audit/entries',
        authRequired: true,
        queryParameters: <String, Object?>{
          'actor_q': ?actorQ,
          'actor_admin_id': ?actorAdminId,
          'actor_user_id': ?actorUserId,
          if (effectiveRole case final v?) 'effective_role': v.toJson(),
          'action': ?action,
          'entity_type': ?entityType,
          'entity_id': ?entityId,
          'request_id': ?requestId,
          if (from case final v?) 'from': encodeDateTime(v),
          if (to case final v?) 'to': encodeDateTime(v),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AuditEntryPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail satu entri audit termasuk before/after yang telah disaring (izin audit.read, F-17).
  ///
  /// before/after ditampilkan sebagaimana disimpan (secret sudah disaring saat tulis); penyamaran kolom privat
  /// khusus berkas ekspor (lihat adminCreateAuditExport). `entryId` yang bukan UUID menghasilkan 400
  /// VALIDATION_ERROR; entri yang tidak ada 404 NOT_FOUND.
  ///
  /// `GET /admin/audit/entries/{entryId}` (operationId `adminGetAuditEntry`).
  Future<AuditEntryDetail> adminGetAuditEntry(
    String entryId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetAuditEntry',
        method: 'GET',
        path: '/admin/audit/entries/${Uri.encodeComponent(entryId)}',
        authRequired: true,
        decode: (Object? v0) => AuditEntryDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar job ekspor audit dan statusnya (audit.read + audit.export, F-17).
  ///
  /// Admin melihat ekspor yang ia minta sendiri; Super Admin melihat semua ekspor beserta peminta. Sumber daftar
  /// adalah entri audit `audit.export.requested` (entity_type `audit_export`; milik sendiri = actor_admin_id
  /// pemanggil) dengan keyset (created_at, id) menurun, sehingga urutan requested_at menurun; status diturunkan
  /// sesuai skema AuditExport dan `total` mengikuti filter. Status `expired` berarti berkas sudah dihapus
  /// otomatis.
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/audit/exports` (operationId `adminListAuditExports`).
  Future<AuditExportPage> adminListAuditExports({
    AuditExportStatus? status,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListAuditExports',
        method: 'GET',
        path: '/admin/audit/exports',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AuditExportPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Minta ekspor CSV audit dengan filter yang sama seperti pencarian (audit.read + audit.export, AC F17-2..F17-4).
  ///
  /// Membuat job ekspor berstatus `processing` dalam SATU transaksi (AC F17-1): id ekspor (UUID v7) dibuat
  /// server, audit `audit.export.requested` (entity_type `audit_export`, entity_id = id ekspor, actor = admin
  /// peminta, after = {filters}) dan outbox `audit.export.requested` (dedup_key
  /// `audit.export.requested:<id ekspor>`, payload {export_id}). Job `audit.export` di worker membaca filter dari
  /// entri audit tersebut, menghasilkan CSV, dan menulis berkas privat purpose `audit_export` (ARCHITECTURE
  /// §4.8); pemetaan penyimpanan dan aturan transisi ada di skema AuditExport. Filter memakai arti yang sama
  /// persis dengan GET /admin/audit/entries (AC F17-4) dan disimpan apa adanya di `filters`.
  ///
  /// Isi CSV (UTF-8, pemisah koma, baris pertama header): created_at (UTC RFC 3339), action, entity_type,
  /// entity_id, effective_role, actor_admin_id, actor_user_id, actor_name, request_id, reason, before (JSON),
  /// after (JSON). Setiap sel yang diawali `=`, `+`, `-`, `@`, tab atau carriage return dinetralkan dengan
  /// awalan apostrof agar tidak dieksekusi sebagai formula (AC F17-3). Jumlah baris dibatasi konfigurasi
  /// server; bila hasil filter melebihi batas, job gagal dengan `failure_reason=row_limit_exceeded` (tidak
  /// pernah dipotong diam-diam) dan admin mempersempit filter.
  ///
  /// Kolom privat dan secret tidak ikut ekspor (AC F17-3, N-09). Sebelum before/after diserialisasi, worker
  /// menjalankan penyamaran wajib (fungsi murni yang diuji unit, berlaku untuk SEMUA tindakan termasuk tindakan
  /// baru) yang menelusuri objek dan array pada kedalaman berapa pun dan mencocokkan nama kunci tanpa membedakan
  /// huruf besar/kecil:
  ///
  /// | kelompok                  | kunci                                                                        |
  /// | ------------------------- | ---------------------------------------------------------------------------- |
  /// | kontak                    | `email`, `*_email`, `phone`, `*_phone`, `whatsapp`, `*_whatsapp`, `social_*` |
  /// | data pribadi              | `address`, `*_address`, `birth_date`, `birth_place`, `date_of_birth`, `city` |
  /// | foto dan berkas pribadi   | `avatar_file_id`, `avatar_url`, `photo_*`, `proof_*`                         |
  /// | perangkat dan jaringan    | `ip`, `ip_address`, `user_agent`, `device_name`                              |
  /// | secret (pertahanan ganda) | `password*`, `*_hash`, `otp*`, `*token*`, `*secret*`, `backup_code*`, `totp*`, `nik`, `ktp`, `*account_number*` |
  ///
  /// Nilai bukan null pada kunci tersebut diganti string `[disembunyikan]`; nama kunci dan null tetap ada
  /// sehingga auditor tetap tahu field apa yang berubah tanpa melihat isinya. Pencocokan berbasis nama kunci
  /// sengaja konservatif: kontak organisasi pada pengaturan (misalnya email/WhatsApp bantuan) ikut disamarkan
  /// di CSV. Kolom `actor_name` (identitas
  /// pelaku wajib PRD 3.17) dan `reason` (teks pengurus) diekspor apa adanya setelah netralisasi formula;
  /// formulir alasan di semua domain tidak boleh meminta kontak atau secret. Nilai privat tetap dapat dilihat
  /// pengurus berizin audit.read di dalam sistem lewat GET /admin/audit/entries/{entryId}.
  ///
  /// Pembuatan ekspor dibatasi per admin (RATE_LIMITED dengan retry_after_seconds). Idempotency-Key mencegah
  /// job ganda saat klik ulang atau jaringan putus (PRD 4.3).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/audit/exports` (operationId `adminCreateAuditExport`).
  Future<AuditExport> adminCreateAuditExport(
    AuditFilter body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreateAuditExport',
        method: 'POST',
        path: '/admin/audit/exports',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AuditExport.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Status satu job ekspor untuk polling (audit.read + audit.export, AC F17-4).
  ///
  /// Hanya peminta atau Super Admin; selain itu 404 NOT_FOUND (tidak membedakan tidak ada atau bukan milik, N-09).
  /// `exportId` yang bukan UUID menghasilkan 400 VALIDATION_ERROR.
  ///
  /// `GET /admin/audit/exports/{exportId}` (operationId `adminGetAuditExport`).
  Future<AuditExport> adminGetAuditExport(
    String exportId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetAuditExport',
        method: 'GET',
        path: '/admin/audit/exports/${Uri.encodeComponent(exportId)}',
        authRequired: true,
        decode: (Object? v0) => AuditExport.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// URL unduh bertanda tangan untuk berkas ekspor siap (audit.read + audit.export, AC F17-2).
  ///
  /// Izin audit.read dan audit.export serta kepemilikan (peminta atau Super Admin) diperiksa ulang SETIAP
  /// permintaan; mengetahui id ekspor/berkas atau URL lama tidak memberi akses (AC F17-2). URL dibuat
  /// FilesService untuk `file_id` pada entri audit `audit.export.completed` ekspor ini, terikat berkas dan
  /// purpose `audit_export`, berlaku maksimal 10 menit, dan tidak boleh
  /// disimpan cache publik (PRD 5.4). Berkas `audit_export` tidak dilayani lewat jalur berkas lain tanpa
  /// pemeriksaan yang sama. Status selain `ready` menghasilkan 409 VERSION_CONFLICT dengan `current` =
  /// AuditExport terbaru; ekspor `expired` atau berkas yang sudah dihapus menghasilkan 404. Setiap akses
  /// diaudit `audit.export.downloaded` (PRD 3.17). `exportId` yang bukan UUID menghasilkan 400
  /// VALIDATION_ERROR.
  ///
  /// `GET /admin/audit/exports/{exportId}/access` (operationId `adminGetAuditExportAccess`).
  Future<AuditExportAccess> adminGetAuditExportAccess(
    String exportId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetAuditExportAccess',
        method: 'GET',
        path: '/admin/audit/exports/${Uri.encodeComponent(exportId)}/access',
        authRequired: true,
        decode: (Object? v0) => AuditExportAccess.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
