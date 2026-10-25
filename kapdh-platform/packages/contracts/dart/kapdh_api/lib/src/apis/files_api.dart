// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Unggah dan akses berkas dengan purpose dan izin berbeda (PRD 2.5, 5.4, N-10). Berkas privat tidak pernah
/// dilayani dari folder publik: isi dibuka lewat URL bertanda tangan <= 10 menit yang terikat berkas, purpose,
/// dan penerima, setelah pemeriksaan izin. Berkas publik (cover berita/event, banner, avatar publik) memakai URL
/// tetap.
///
///
/// Kelas API untuk tag kontrak "Files". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class FilesApi {
  const FilesApi(this._dio);

  final Dio _dio;

  /// Unggah berkas dengan purpose tertentu (N-10).
  ///
  /// Multipart dengan field `purpose` lalu satu berkas pada field `file`. Field `purpose` WAJIB dikirim sebelum
  /// `file` (urutan bagian multipart) agar hak unggah dan kuota diperiksa sebelum isi dibaca; urutan terbalik
  /// → 400 VALIDATION_ERROR. Batas baca stream per purpose: 5 MB untuk purpose gambar, 10 MB untuk
  /// `payment_proof`; lebih besar → 413 FILE_INVALID.
  ///
  /// Tipe ditentukan dari magic bytes (bukan ekstensi atau Content-Type klien); ekstensi/Content-Type yang
  /// menyamarkan tipe ditolak 415. Gambar JPG/PNG/WebP <= 5 MB didekode aman (dimensi/piksel berlebihan ditolak
  /// 422), diputar sesuai orientasi lalu di-encode ulang sehingga EXIF/GPS terbuang. PDF <= 10 MB hanya untuk
  /// `payment_proof`; PDF berskrip/berlampiran ditolak 422.
  ///
  /// Kuota: maksimal 10 unggahan berhasil per purpose per pengguna per 24 jam bergulir, ditambah batas 30
  /// percobaan per jam → 429 RATE_LIMITED dengan `retry_after_seconds`.
  ///
  /// Hak unggah per purpose:
  /// - anggota (sesi aplikasi): `avatar` dan `payment_proof` (effective_status selain suspended), `chat_image`
  ///   (verified/expiring); sesi admin → 403 kecuali butir berikut;
  /// - pengurus (sesi admin): `adjustment_evidence` (`payments.decide`, bukti penyelesaian penyesuaian/refund D6)
  ///   dan `payment_proof` (`payments.decide`, bukti verifikasi untuk pembayaran yang dicatat pengurus,
  ///   adminRecordPayment D13; berkas milik akun login admin dan tidak pernah dibuka kepada anggota); sesi
  ///   anggota → 403 untuk `adjustment_evidence`.
  ///
  /// Gambar publik konten TIDAK diunggah lewat endpoint ini (purpose lain → 400 pada `purpose`): `post_cover` dan
  /// `banner_image` lewat POST /admin/content/media (`content.manage`), `event_cover` lewat
  /// POST /admin/event-covers (`events.manage`), dan gambar QRIS `payment_qr` lewat POST /admin/payment-qr-images
  /// (`settings.manage`, ADR-026), sehingga izin area itu yang diperiksa; pemeriksaan isi, kuota dan pembersihan
  /// berkas sama.
  ///
  /// Berkas baru belum terkait objek; endpoint domain melampirkannya lewat `file_id`. Berkas yang tidak dilampirkan
  /// dalam 24 jam dihapus job `files.cleanup-temp` (PRD 2.5).
  ///
  /// `POST /files` (operationId `uploadFile`).
  Future<FileRef> uploadFile(
    FileUploadRequest body, {
    CancelToken? cancelToken,
    Options? options,
    ProgressCallback? onSendProgress,
  }) =>
      sendRequest(
        _dio,
        operationId: 'uploadFile',
        method: 'POST',
        path: '/files',
        authRequired: true,
        data: body.toFormData(),
        decode: (Object? v0) => FileRef.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
        onSendProgress: onSendProgress,
      );

  /// URL baca berkas setelah pemeriksaan izin (PRD 5.4).
  ///
  /// Berkas privat: kebijakan akses purpose diperiksa lebih dulu (pemilik; pengurus `payments.read` untuk bukti
  /// bayar, termasuk versi bukti lama yang dirujuk riwayat pembayaran, dan bukti penyesuaian; `members.read` untuk
  /// avatar; ekspor audit hanya untuk `audit.read` + `audit.export` yang juga pemohon ekspor atau Super Admin,
  /// dengan jalur unduh utama adminGetAuditExportAccess; aturan modul seperti anggota room untuk gambar chat;
  /// `moderation.read` untuk gambar chat dan avatar yang dirujuk bukti laporan, HANYA bila minimal satu laporan
  /// perujuk terlihat bagi pemanggil menurut aturan konflik kepentingan admin-moderation butir a, dan setiap akses
  /// itu dicatat audit `moderation.evidence_viewed` sebelum URL diterbitkan), lalu
  /// URL bertanda tangan berumur <= 10 menit terikat berkas + purpose + keluarga sesi pemanggil (Session.id). URL
  /// tetap berlaku melewati rotasi refresh, tetapi berhenti berlaku bila sesi dicabut (logout, logout semua
  /// perangkat, suspend). Berkas publik: URL tetap dan `expires_at` null. `mime` memberi tahu klien cara
  /// menampilkan isi (gambar atau PDF) tanpa menebak dari URL. Berkas yang tidak ada, belum siap, atau tidak boleh
  /// dibuka → 404 tanpa membedakan alasannya (N-09).
  ///
  /// `GET /files/{fileId}/access` (operationId `getFileAccess`).
  Future<FileAccess> getFileAccess(
    String fileId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getFileAccess',
        method: 'GET',
        path: '/files/${Uri.encodeComponent(fileId)}/access',
        authRequired: true,
        decode: (Object? v0) => FileAccess.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Isi berkas privat lewat token URL bertanda tangan (dipakai langsung sebagai URL gambar/unduhan).
  ///
  /// Tanpa header Authorization: token di path adalah kredensial berumur <= 10 menit hasil `getFileAccess` atau
  /// URL yang disematkan API; klien memakai `url` apa adanya. Token rusak/diubah/kedaluwarsa, sesi penerima
  /// dicabut, atau berkas sudah dihapus → 404. Respons `Cache-Control: private, no-store` (cache publik tidak
  /// boleh menyimpan bukti, chat, atau ekspor, PRD 5.4); gambar ditampilkan inline, PDF dan CSV diunduh sebagai
  /// lampiran.
  ///
  /// [token]: Token URL bertanda tangan (JWT HS256 kompak; bukan access token sesi).
  ///
  /// `GET /files/content/{token}` (operationId `getFileContent`).
  Future<List<int>> getFileContent(
    String token, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getFileContent',
        method: 'GET',
        path: '/files/content/${Uri.encodeComponent(token)}',
        authRequired: false,
        responseType: ResponseType.bytes,
        decode: decodeBytes,
        cancelToken: cancelToken,
        options: options,
      );

  /// Isi berkas publik (cover berita/event, banner, avatar publik) dengan cache publik.
  ///
  /// Hanya berkas bervisibilitas publik yang siap; selain itu 404 (berkas privat tidak pernah dilayani di sini).
  /// Isi berkas tidak pernah berubah untuk id yang sama, sehingga respons `Cache-Control: public, max-age=86400`
  /// dan `ETag` (sha256 isi); `If-None-Match` yang cocok → 304 tanpa isi.
  ///
  /// `GET /files/public/{fileId}` (operationId `getPublicFile`).
  Future<List<int>> getPublicFile(
    String fileId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getPublicFile',
        method: 'GET',
        path: '/files/public/${Uri.encodeComponent(fileId)}',
        authRequired: false,
        responseType: ResponseType.bytes,
        decode: decodeBytes,
        cancelToken: cancelToken,
        options: options,
      );
}
