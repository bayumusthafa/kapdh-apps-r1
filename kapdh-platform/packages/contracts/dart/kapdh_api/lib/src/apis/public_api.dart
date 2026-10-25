// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Konfigurasi publik (versi minimum, maintenance, tautan toko, kontak bantuan, versi legal), verifikasi KTA dan
/// health check tanpa autentikasi (F-06, PRD 4.5, 5.2, 5.5).
///
///
/// Kelas API untuk tag kontrak "Public". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class PublicApi {
  const PublicApi(this._dio);

  final Dio _dio;

  /// Liveness untuk monitor eksternal dan orkestrator; tidak memeriksa dependensi (PRD 5.5, N-05).
  ///
  /// `GET /health` (operationId `getHealth`).
  Future<HealthStatus> getHealth({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getHealth',
        method: 'GET',
        path: '/health',
        authRequired: false,
        decode: (Object? v0) => HealthStatus.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Readiness; memeriksa PostgreSQL, Redis (bila dikonfigurasi) dan storage (PRD 5.5, N-05).
  ///
  /// Dipakai orkestrator (Coolify/Traefik) dan Uptime Kuma. 200 bila semua dependensi wajib siap, 503 bila
  /// ada yang gagal, termasuk deletion ledger yang belum diterapkan ulang setelah restore database (AC F14-6:
  /// layanan tidak dibuka sebelum `account:ledger-reapply`, runbook docs/runbooks/restore-backup.md). Hanya
  /// nama komponen dan status ok/fail/skipped, ditambah umur event outbox pending tertua sebagai sinyal worker
  /// macet (PRD 5.5); tidak memuat pesan galat, host, versi atau data lain (N-14). Tidak dicache.
  ///
  /// `GET /health/ready` (operationId `getHealthReadiness`).
  Future<HealthReadiness> getHealthReadiness({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getHealthReadiness',
        method: 'GET',
        path: '/health/ready',
        authRequired: false,
        decode: (Object? v0) => HealthReadiness.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Versi aplikasi minimum, status maintenance, tautan toko, kontak bantuan dan versi legal (PRD 4.5, 5.2).
  ///
  /// Dibaca layar splash Flutter sebelum login (gerbang aplikasi, ARCHITECTURE §8.3) dan oleh situs publik.
  /// Bila versi aplikasi di bawah `min_app_version` platformnya, klien menampilkan layar wajib update dengan
  /// `store_links`; bila `maintenance.active`, klien menampilkan layar maintenance dengan pesan dan perkiraan
  /// selesai (PRD 4.5). Sumber: app_settings min_app_version, maintenance, store_links, support dan legal
  /// (ARCHITECTURE §5.4). Tetap dilayani selama maintenance. Tidak memuat secret atau data pribadi.
  ///
  /// `GET /public/config` (operationId `getPublicConfig`).
  Future<PublicConfig> getPublicConfig({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getPublicConfig',
        method: 'GET',
        path: '/public/config',
        authRequired: false,
        decode: (Object? v0) => PublicConfig.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Verifikasi token QR KTA terhadap status server terkini; respons hanya identitas minimum (F-06, AC F06-1..F06-4).
  ///
  /// Shell situs /kta/{nomor} membaca token dari fragmen URL (#t=) lalu mengirimnya ke sini; nomor saja tidak
  /// memberi akses profil (F-06). Token QR (ARCHITECTURE §3.2): JWT HS256 dengan header `kid` (rotasi kunci),
  /// klaim `iss` kapdh-api, `aud` kapdh-kta, `sub` id alumni, `seq` nomor urut N, `iat`, dan
  /// `exp` = min(iat + 7 hari, expires_at saat terbit). Status selalu dibaca dari DB TERKINI (AC F05-4); cache
  /// atau kartu offline tidak pernah menjadi sumber hasil. Waktu pembanding adalah jam server (`checked_at`).
  ///
  /// Urutan penilaian (langkah pertama yang cocok menentukan hasil; tidak ada jalur lain):
  /// 1. Token rusak, `kid` tidak dikenal, tanda tangan, issuer atau audience salah -> `invalid_token`, tanpa
  ///    membaca data anggota sehingga keberadaan nomor tidak dapat ditebak dengan token sembarang (AC F06-3).
  /// 2. Akun `sub` tidak ada lagi atau sudah dihapus (F-14) -> `not_found` (AC F06-2 "termasuk setelah
  ///    penghapusan akun"), juga bila `exp` sudah lewat; tanpa identitas.
  /// 3. Keterikatan gagal: nomor pada request bukan nomor terkini akun `sub`, atau `seq` bukan N akun itu (token
  ///    terbit sebelum koreksi nomor, atau nomor diubah) -> `invalid_token` ("QR tidak valid atau perlu
  ///    diperbarui", AC F05-6).
  /// 4. `exp` sudah lewat: hasil TIDAK PERNAH `active` dan `expiring` selalu false (AC F06-3, F05-5 "token QR
  ///    lama tunduk expiry"). Hasilnya `expired` (Kedaluwarsa, AC F06-2) hanya bila KEDUA syarat terpenuhi:
  ///    a) token dipangkas oleh masa keanggotaan, yaitu `exp` < `iat` + 7 hari (exp = expires_at saat terbit);
  ///    b) effective_status TERKINI akun adalah expired.
  ///    Semua kasus lain -> `invalid_token`, misalnya token 7 hari biasa yang kedaluwarsa, anggota yang sudah
  ///    memperpanjang sehingga kini verified/expiring (pemeriksa diminta QR baru), atau anggota yang kini
  ///    suspended, disabled, deletion_pending atau unverified.
  /// 5. `exp` belum lewat: verified -> `active`; expiring -> `active` dengan `expiring` true dan tanggal habis
  ///    (AC F06-1); expired -> `expired`; unverified, suspended, disabled atau deletion_pending -> `inactive`
  ///    tanpa alasan (AC F06-2, F12-4).
  ///
  /// Identitas minimum (`member`, D3): diisi untuk `active` (dengan foto) dan `expired` (tanpa foto); null untuk
  /// hasil lain. Untuk `expired` dari langkah 4, `member` hanya diisi bila `exp` paling lama 30 hari sebelum
  /// `checked_at`; token yang lebih tua tetap berhasil `expired` tetapi `member` null, sehingga QR lama yang
  /// tersalin tidak membuka nama anggota tanpa batas waktu. Tidak pernah memuat email, telepon, NIK, alamat,
  /// bukti bayar atau alasan suspend (F-06, D3). Respons `Cache-Control: no-store`.
  /// Kegagalan jaringan/5xx tidak boleh ditampilkan klien sebagai Tidak ditemukan (AC F06-4).
  ///
  /// Pembatasan laju (nilai final D1) -> 429 RATE_LIMITED dengan `retry_after_seconds`:
  /// - per IP untuk semua request;
  /// - per hash token (SHA-256 dari token; token mentah tidak pernah disimpan atau dicatat) untuk semua request;
  /// - per nomor anggota HANYA untuk request yang lolos langkah 1 (tanda tangan, issuer dan audience sah),
  ///   dihitung pada anggota PEMILIK token (klaim `sub`, yaitu nomor yang terikat pada token), bukan pada
  ///   `member_number` di body; batas per token lebih kecil dari batas per nomor.
  /// Token sampah untuk nomor yang ditebak (N berurutan), maupun token sah milik anggota lain yang dikirim dengan
  /// nomor korban, hanya menghabiskan kuota IP pengirimnya dan kuota pemilik token itu, tidak pernah kuota nomor
  /// korban, sehingga pemeriksa sah di lapangan tidak ikut diblokir (F-06, AC F06-4). Klien
  /// menampilkan 429 sebagai "Tidak dapat memverifikasi" dengan retry, bukan Tidak ditemukan.
  ///
  /// Maintenance (PRD 4.5, ARCHITECTURE §4.3): walaupun memakai metode POST, operasi ini hanya membaca sehingga
  /// termasuk pengecualian "/public/** reads" dan dikecualikan EKSPLISIT per path pada hook maintenance
  /// (core-api `maintenanceAllowed`: path `/public/kta/verify`), sehingga tidak pernah menghasilkan
  /// 503 MAINTENANCE dan pemeriksa di lapangan tetap dapat memverifikasi KTA selama maintenance. 5xx lain
  /// (mis. proxy saat deploy) jatuh ke respons default dan ditampilkan sebagai "Tidak dapat memverifikasi".
  ///
  /// `POST /public/kta/verify` (operationId `verifyKta`).
  Future<KtaVerification> verifyKta(
    KtaVerifyRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'verifyKta',
        method: 'POST',
        path: '/public/kta/verify',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => KtaVerification.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
