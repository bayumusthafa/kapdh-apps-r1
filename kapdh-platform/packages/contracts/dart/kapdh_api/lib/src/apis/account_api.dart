// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Penghapusan akun dari aplikasi dan web beserta pengungkapan retensi dan pemeriksaan status (F-14, PRD 2.2, D2,
/// N-15). Kebijakan D2: tanpa periode retensi data pribadi; catatan keuangan, tiket, laporan moderasi dan audit
/// hanya disimpan anonim; backup harian berotasi 30 hari dengan deletion ledger (AC F14-6).
///
///
/// Kelas API untuk tag kontrak "Account". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AccountApi {
  const AccountApi(this._dio);

  final Dio _dio;

  /// Pengungkapan sebelum hapus akun; data yang dihapus/dianonimkan dan peringatan refund tiket (F-14, N-15).
  ///
  /// Ditampilkan di layar /account/delete sebelum reautentikasi dan konfirmasi (N-15: retensi dan penggunaan data
  /// dijelaskan sebelum pengguna menyetujui). Memuat kategori data yang dihapus dan yang tersisa anonim (D2),
  /// perkiraan penyelesaian maksimal 7 hari kalender, rotasi backup 30 hari, serta peringatan pribadi: tiket aktif
  /// beserta kebijakan refund D6 yang berlaku (akun dihapus -> tiket hangus; pengguna diberi tahu untuk mengajukan
  /// refund lebih dahulu, PRD 3.9), refund yang sedang diproses bendahara tetapi belum ditransfer (PRD 4.4),
  /// pembayaran yang masih menunggu verifikasi, grup chat yang admin tunggalnya pengguna (AC F14-5), dan identitas
  /// pengurus tertaut. `version` wajib dikirim kembali saat konfirmasi.
  /// Tersedia untuk semua effective_status termasuk suspended (penghapusan deletion-only, F-14). Token sesi admin
  /// ditolak 403 FORBIDDEN (audience mobile).
  ///
  /// `GET /me/deletion/disclosure` (operationId `getAccountDeletionDisclosure`).
  Future<AccountDeletionDisclosure> getAccountDeletionDisclosure({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getAccountDeletionDisclosure',
        method: 'GET',
        path: '/me/deletion/disclosure',
        authRequired: true,
        decode: (Object? v0) => AccountDeletionDisclosure.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Minta penghapusan akun dari aplikasi; perlu reautentikasi maksimal 10 menit dan konfirmasi (AC F14-1).
  ///
  /// Wajib header X-Reauth-Token (POST /auth/reauth, maksimal 10 menit, terikat sesi) dan `confirm: true` dengan
  /// `acknowledged_disclosure_version` sama dengan `version` pengungkapan terkini. Dalam satu transaksi dengan
  /// baris users terkunci: satu permintaan `account_deletions` dibuat (nomor DEL-YYYY-XXXX, sumber `app`, batas
  /// 7 hari), akun menjadi `deletion_pending`, semua sesi dicabut dan `session_version` naik, audit
  /// `account.deletion_requested` ditulis, dan outbox `account.deletion.requested` (job) serta email konfirmasi
  /// berisi nomor permintaan dijadwalkan. Setelah commit seluruh socket diputus (AC F14-1). Klien menampilkan
  /// nomor permintaan lalu menghapus token, cache KTA dan data privat lokal. Bila respons hilang, sesi sudah
  /// dicabut: klien masuk kembali dan POST /auth/login mengembalikan `next: deletion_pending` beserta status.
  ///
  /// Satu permintaan terbuka per akun (`account_deletions_user_id_open_key`); request bersamaan atau ulangan
  /// dengan Idempotency-Key yang sama mengembalikan permintaan yang sama. Anggota suspended dapat menghapus akun
  /// tanpa akses komunitas (F-14). Akun alumni pengurus tetap dapat dihapus; identitas admin tertaut tidak ikut
  /// terhapus dan diputus tautannya oleh job (PRD 3.14). Job dapat dilanjutkan setelah gagal (AC F14-2, N-15).
  ///
  /// Refund dan pembayaran terbuka (PRD 4.4, D6, D2): penghapusan tidak menunggu refund dan tidak pernah
  /// menganggap dana sudah dikembalikan. Job tidak menyelesaikan atau membatalkan payment_adjustments refund
  /// `pending` secara otomatis; catatan itu tetap ada (anonim) untuk diselesaikan atau dibatalkan bendahara
  /// dengan catatan penyelesaian tersendiri. Data rekening tujuan refund (`refund_destination`) disimpan paling
  /// lama sampai refund selesai/batal atau sampai langkah akhir job (batas `estimated_completion_at`), mana yang
  /// lebih dahulu, lalu dihapus bersama data pribadi lain; setelah itu bendahara tidak lagi dapat menghubungi
  /// pemilik. Karena itu UI menampilkan `pending_refunds` dan `active_tickets` sebelum konfirmasi dan menyarankan
  /// menunggu refund selesai atau mengajukan refund lebih dahulu. Pembayaran `pending` TANPA bukti dibatalkan job
  /// (aktor system); pembayaran `pending` yang sudah berbukti tidak dibatalkan karena dana mungkin sudah
  /// ditransfer, melainkan tetap diputus pengurus dalam bentuk anonim (berkas bukti dan catatan transfer dihapus;
  /// admin-payments adminDecidePayment). Dana yang sudah ditransfer diselesaikan lewat bendahara.
  ///
  /// Galat: 400 VALIDATION_ERROR (`confirm` bukan true); 403 REAUTH_REQUIRED, atau FORBIDDEN bila dipanggil
  /// dengan token sesi admin; 409 VERSION_CONFLICT bila pengungkapan berubah (mis. tiket atau refund baru)
  /// dengan `current` berisi AccountDeletionDisclosure terkini, atau IDEMPOTENCY_CONFLICT.
  ///
  /// [reauthToken]: Token dari POST /auth/reauth (audience kapdh-reauth, terikat sesi, berlaku maksimal 10 menit) untuk tindakan
  /// kredensial (ARCHITECTURE §4.3, ADR-025). Tidak ada atau kedaluwarsa menghasilkan 403 REAUTH_REQUIRED.
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /me/deletion` (operationId `requestAccountDeletion`).
  Future<AccountDeletion> requestAccountDeletion(
    AccountDeletionRequest body, {
    required String reauthToken,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'requestAccountDeletion',
        method: 'POST',
        path: '/me/deletion',
        authRequired: true,
        headers: <String, Object?>{
          'X-Reauth-Token': reauthToken,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AccountDeletion.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Mulai penghapusan atau cek status dari situs /delete-account; OTP dikirim ke email (F-14, PRD 2.2).
  ///
  /// Dipakai situs publik /delete-account (tanpa aplikasi) dan layar status penghapusan aplikasi. Bila email
  /// milik akun alumni `active` (semua effective_status termasuk suspended: challenge deletion-only tanpa akses
  /// komunitas), `pending_otp` (pembatalan pendaftaran yang belum diverifikasi, kepala berkas),
  /// `deletion_pending` (cek status) atau `disabled` (cek status), challenge `deletion` dibuat (baris users
  /// dikunci, challenge `deletion` lama dibatalkan; challenge aktivasi signup/email_change tidak disentuh) dan
  /// kode dikirim ke email akun. Untuk email lain (tidak terdaftar, akun admin, akun yang sudah selesai dihapus)
  /// server mengembalikan challenge pengganti berbentuk sama tanpa email; respons, waktu dan batas 429 identik
  /// (non-enumerasi, PRD 2.5).
  /// Kirim ulang memakai POST /auth/otp/resend. Galat: 400 VALIDATION_ERROR email tidak valid; 429 RATE_LIMITED
  /// (5 pengiriman per jam per email plus batas IP).
  ///
  /// `POST /public/deletion/challenge` (operationId `startWebDeletion`).
  Future<OtpChallenge> startWebDeletion(
    WebDeletionStartRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'startWebDeletion',
        method: 'POST',
        path: '/public/deletion/challenge',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => OtpChallenge.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Verifikasi OTP penghapusan; tampilkan status dan pengungkapan, terbitkan deletion_token terbatas (F-14).
  ///
  /// Kode `deletion` benar dikonsumsi sekali secara atomik. Respons adalah challenge terbatas (PRD 2.2): tidak ada
  /// sesi, hanya status permintaan penghapusan terbuka (`deletion`) dan, bila akun dapat dihapus, pengungkapan
  /// retensi/peringatan (`disclosure`) serta `deletion_token` hanya untuk POST /public/deletion/confirm: JWT
  /// audience `kapdh-web-deletion` berumur maksimal 10 menit (sama dengan batas reautentikasi F-14), subject
  /// akun, klaim `cid` challenge yang dikonsumsi, `sv` (users.session_version) dan `st` (users.status saat
  /// verifikasi: `active` atau `pending_otp`). Token tidak disimpan di server; sifat sekali pakainya dijamin
  /// konfirmasi yang mengubah akun menjadi `deletion_pending` (kepala auth.yaml).
  /// Bila respons hilang, kode sudah dikonsumsi: pengguna meminta challenge baru.
  /// Akun `active` (termasuk suspended) -> `deletable` true, `registration_pending` false.
  /// Akun `pending_otp` -> `deletable` true, `registration_pending` true: konfirmasi membatalkan pendaftaran yang
  /// belum diverifikasi dan menghapus datanya; pengungkapan berisi kategori data yang sama dengan daftar
  /// peringatan pribadi kosong (akun pending_otp tidak dapat membayar, memesan tiket atau masuk grup).
  /// Akun `deletion_pending` -> `deletable` false, `blocked_reason: deletion_in_progress`, `deletion` terisi.
  /// Akun `disabled` -> `deletable` false, `blocked_reason: account_disabled` (pemulihan atau penghapusan melalui
  /// kanal bantuan, PRD 2.2): setelah identitas pemilik diverifikasi, operator memulai permintaan penghapusan
  /// (sumber `web`, job dan deletion ledger yang sama) lewat CLI teraudit `account:status --action delete`
  /// (runbook docs/runbooks/alumni-account-disabled.md), sehingga penghapusan tetap selalu tersedia (F-14).
  /// Challenge pengganti dari email tak terdaftar selalu diperlakukan sebagai kode salah sampai percobaan habis.
  /// Galat: 400 VALIDATION_ERROR kode salah dengan sisa percobaan di `field_errors.code`; 410 OTP_EXPIRED
  /// (kedaluwarsa, dipakai, diganti, percobaan habis, tujuan lain); 429 RATE_LIMITED.
  ///
  /// `POST /public/deletion/verify` (operationId `verifyWebDeletion`).
  Future<WebDeletionVerification> verifyWebDeletion(
    WebDeletionVerifyRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'verifyWebDeletion',
        method: 'POST',
        path: '/public/deletion/verify',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => WebDeletionVerification.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Konfirmasi penghapusan dari web dengan deletion_token; nomor permintaan ditampilkan (AC F14-1).
  ///
  /// Halaman web benar-benar menerima permintaan, bukan hanya menyarankan menghubungi pengurus (F-14).
  /// `confirm: true` dan `acknowledged_disclosure_version` wajib sama dengan pengungkapan terkini. Dalam satu
  /// transaksi dengan baris users terkunci (FOR UPDATE): deletion_token diverifikasi (tanda tangan, audience,
  /// kedaluwarsa, challenge `cid` milik akun bertujuan `deletion` dan sudah dikonsumsi, `sv` sama dengan
  /// session_version saat ini) dan akun harus masih berstatus `st` yang tercatat di token (`active` dengan
  /// effective_status apa pun termasuk suspended, atau `pending_otp`); lalu transisi bersyarat users
  /// `st` -> `deletion_pending` (`UPDATE ... WHERE status = <st> RETURNING`) serta insert account_deletions
  /// (`account_deletions_user_id_open_key`). Karena akun tidak lagi `st` dan session_version naik, token yang
  /// sama tidak pernah berhasil dua kali (sekali pakai tanpa penyimpanan token). Efek sama dengan
  /// POST /me/deletion (sumber `web`, termasuk perlakuan refund): sesi/socket dicabut, audit, job dan email
  /// konfirmasi lewat outbox. Pengulangan dengan Idempotency-Key sama mengembalikan respons pertama; tanpa key,
  /// pengulangan setelah berhasil menghasilkan 410 dan pengguna memeriksa status lewat challenge -> verify
  /// (`deletion` terisi).
  ///
  /// Pendaftaran `pending_otp`: dalam transaksi yang sama challenge signup/email_change yang masih aktif
  /// dibatalkan, sehingga kode aktivasi yang sudah terkirim tidak dapat lagi mengaktifkan akun; aktivasi dan
  /// konfirmasi saling eksklusif karena keduanya memakai UPDATE bersyarat pada status dengan baris users
  /// terkunci (aktivasi lebih dahulu -> konfirmasi 410; konfirmasi lebih dahulu -> verifikasi OTP 410). Nomor
  /// anggota tidak pernah dialokasikan. Job menghapus data pendaftaran seperti akun lain; email akun dapat
  /// dipakai mendaftar lagi setelah permintaan selesai (`users_kind_email_key` hanya berlaku untuk akun yang
  /// belum `deleted`).
  /// Galat: 400 VALIDATION_ERROR; 409 VERSION_CONFLICT bila pengungkapan berubah (`current` berisi
  /// AccountDeletionDisclosure terkini; token tetap berlaku sampai kedaluwarsa) atau IDEMPOTENCY_CONFLICT;
  /// 410 OTP_EXPIRED bila deletion_token kedaluwarsa, tidak sah, sudah dipakai, atau keadaan akun berubah
  /// (tidak dibedakan); 429 RATE_LIMITED.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /public/deletion/confirm` (operationId `confirmWebDeletion`).
  Future<AccountDeletion> confirmWebDeletion(
    WebDeletionConfirmRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'confirmWebDeletion',
        method: 'POST',
        path: '/public/deletion/confirm',
        authRequired: false,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AccountDeletion.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
