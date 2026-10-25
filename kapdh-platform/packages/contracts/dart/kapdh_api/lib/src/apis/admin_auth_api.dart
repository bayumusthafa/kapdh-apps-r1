// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Login admin dua tahap (sandi lalu TOTP atau backup code), identitas dan izin efektif, penerimaan undangan,
/// pendaftaran TOTP sebelum aktivasi, backup code dan ganti sandi admin (F-02, F-16, PRD 8.2, N-08). Akun admin
/// terpisah dari akun alumni (PRD 2.3). Sesi admin idle 30 menit di server; request polling latar belakang
/// mengirim header X-Background-Request agar tidak memperpanjang aktivitas (AC F02-5).
///
///
/// Kelas API untuk tag kontrak "Admin Auth". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminAuthApi {
  const AdminAuthApi(this._dio);

  final Dio _dio;

  /// Tahap sandi admin; hasilnya hanya mfa_token, belum bisa memanggil API admin (AC F02-2).
  ///
  /// Admin masuk dengan email (guidelines "Email atau Username": identitas admin R1.0 hanya email). Hanya admin
  /// `active` (akun users `active`) dengan TOTP terverifikasi yang dapat login: sandi benar menghasilkan
  /// `mfa_token` audience `kapdh-admin-mfa` berumur 5 menit dengan `totp_enrollment_required: false`.
  /// `mfa_token` ini hanya berlaku untuk POST /admin/auth/mfa; ditolak 401 di /admin/auth/totp/* dan 403
  /// MFA_REQUIRED di seluruh API admin (AC F02-2).
  ///
  /// Pendaftaran TOTP TIDAK pernah dibuka dari login (lihat kepala berkas): admin `invited` (sudah atau belum
  /// menerima undangan, termasuk setelah reset MFA) dan admin tanpa TOTP terverifikasi ditolak 401 yang sama
  /// dengan sandi salah, sehingga sandi yang bocor tidak cukup untuk mendaftarkan autentikator penyerang.
  /// Halaman login menampilkan petunjuk umum "Belum menyelesaikan aktivasi? Minta undangan ulang ke Super Admin."
  ///
  /// Galat: 401 UNAUTHENTICATED "Email atau sandi salah" untuk kredensial salah, akun tidak dikenal, admin
  /// `disabled`, admin `invited`, atau admin tanpa TOTP terverifikasi (tidak dibedakan); 429 RATE_LIMITED
  /// setelah 10 kegagalan dalam 15 menit per email atau ambang per IP (PRD 2.5); 400 VALIDATION_ERROR untuk
  /// masukan yang melanggar AdminLoginRequest (format email, sandi lebih dari 128 karakter) tanpa menyentuh batas
  /// kegagalan. Admin yang lupa sandi meminta undangan ulang ke Super Admin (F-16). Kegagalan untuk email milik
  /// identitas admin diaudit `admin.auth_failed` (`after.stage` password) paling banyak sekali per admin per
  /// 15 menit, tanpa sandi atau email yang dicoba (F-17); email yang tidak dikenal tidak diaudit.
  ///
  /// `POST /admin/auth/login` (operationId `adminLogin`).
  Future<AdminLoginResponse> adminLogin(
    AdminLoginRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminLogin',
        method: 'POST',
        path: '/admin/auth/login',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => AdminLoginResponse.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Verifikasi TOTP atau backup code; menerbitkan access token di body dan refresh cookie HttpOnly (F-02).
  ///
  /// Tepat satu dari `totp_code` atau `backup_code`, dengan `mfa_token` dari POST /admin/auth/login. TOTP
  /// diterima dalam jendela langkah yang sempit dan setiap langkah hanya sekali (`mfa_totp.last_used_step`,
  /// anti-replay, UPDATE bersyarat). Backup code sekali pakai dikonsumsi secara atomik (UPDATE bersyarat), sisanya
  /// terlihat di GET /admin/me `backup_codes_remaining`. Berhasil: sesi admin `mfa_level` 2 dibuat,
  /// `users.last_login_at` diperbarui, audit `admin.login` ditulis, access token di body dan refresh token di
  /// cookie `kapdh_admin_rt` (tidak pernah di localStorage, PRD 5.2).
  ///
  /// mfa_token SEKALI PAKAI: setelah kode benar menghasilkan sesi, `jti` token dikonsumsi dalam transaksi yang
  /// sama; token yang sama dengan kode apa pun (kode yang sama saat mengulang permintaan yang responsnya hilang,
  /// kode TOTP langkah berikutnya, backup code lain, atau kode salah) ditolak 401 SEBELUM kode dinilai, sehingga
  /// kode yang dikirim tidak dikonsumsi dan percobaan itu tidak dihitung ke batas 5 kode per admin (pemegang
  /// token bekas tidak dapat mengunci admin, PRD 2.5). Kode salah tidak mengonsumsi token.
  ///
  /// mfa_token TERIKAT KREDENSIAL (AC F02-4, F02-6, N-08): token membawa `session_version` dan pengikat HMAC
  /// password_hash yang dinilai di tahap sandi; keduanya dinilai ulang di bawah kunci baris users sebelum sesi
  /// dibuat. Sandi diganti atau direset (POST /admin/auth/password/change, pemulihan) atau "keluar semua
  /// perangkat" (session_version naik) setelah mfa_token terbit -> 401 UNAUTHENTICATED tanpa sesi, walau kode
  /// benar; UI kembali ke /login.
  ///
  /// Kode salah adalah galat formulir, sama dengan /totp/confirm dan POST /auth/reauth: 400 VALIDATION_ERROR
  /// dengan `field_errors.totp_code` atau `field_errors.backup_code` berisi sisa percobaan (mis. "Kode salah.
  /// Sisa percobaan 3."); mfa_token tetap berlaku sampai kedaluwarsa sehingga UI tetap di layar /login/mfa.
  /// 401 UNAUTHENTICATED hanya untuk mfa_token yang tidak sah atau kedaluwarsa (termasuk mfa_token pendaftaran),
  /// admin tidak lagi `active`, atau TOTP tidak terverifikasi; UI kembali ke /login.
  /// Galat lain: 400 VALIDATION_ERROR bila tidak ada kode atau keduanya dikirim; 429 RATE_LIMITED setelah 5
  /// kegagalan dalam 15 menit per admin (juga dihitung ke ambang per IP). Kegagalan ke-5 yang mengunci tahap
  /// kode ditulis sekali sebagai audit `admin.mfa_locked` (tanpa kode); kode salah pertama dalam jendela 15 menit
  /// diaudit `admin.auth_failed` (`after.stage` mfa, tanpa kode; F-17).
  ///
  /// `POST /admin/auth/mfa` (operationId `adminVerifyMfa`).
  Future<AdminSession> adminVerifyMfa(
    AdminMfaRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminVerifyMfa',
        method: 'POST',
        path: '/admin/auth/mfa',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => AdminSession.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Lihat undangan admin dari token sekali pakai sebelum menerima (F-16, PRD 8.2).
  ///
  /// Halaman `/invite` membaca token dari fragmen tautan `${ADMIN_ORIGIN}/invite#t=<token>` lalu mengirimnya di
  /// body (kepala berkas): token tidak pernah ada di path/query halaman maupun API sehingga tidak tercatat di log
  /// akses server atau proxy. Tidak mengonsumsi token. Hanya hash token yang disimpan
  /// (`admins.invite_token_hash`). 410 OTP_EXPIRED bila token tidak dikenal, kedaluwarsa, sudah dipakai, atau
  /// undangan dibatalkan (tidak dibedakan); 429 RATE_LIMITED per IP.
  ///
  /// `POST /admin/auth/invitations/preview` (operationId `adminPreviewInvitation`).
  Future<AdminInvitationPreview> adminPreviewInvitation(
    AdminInvitationTokenRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminPreviewInvitation',
        method: 'POST',
        path: '/admin/auth/invitations/preview',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => AdminInvitationPreview.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Terima undangan admin dan ganti sandi awal dengan token sekali pakai (F-16, PRD 8.2 langkah 3).
  ///
  /// Dalam satu transaksi dengan baris admin terkunci: token undangan diverifikasi (hash, belum kedaluwarsa,
  /// status `invited`) lalu dikonsumsi (`invite_token_hash` dan `invite_expires_at` dikosongkan), sandi awal
  /// acak diganti sandi pilihan admin (aturan PRD 2.5), email akun admin dianggap terverifikasi, secret TOTP
  /// dari pendaftaran sebelumnya yang tidak selesai dibuang, dan audit `admin.invitation_accepted` ditulis. Admin TETAP `invited` sampai TOTP dikonfirmasi; respons memberi
  /// `mfa_token` PENDAFTARAN dengan `totp_enrollment_required: true`: audience `kapdh-admin-enroll`, berlaku
  /// 30 menit sejak penerimaan (`mfa_expires_at`), terikat admin dan HMAC password_hash yang baru disimpan. Token
  /// ini satu-satunya kredensial pendaftaran TOTP, tidak diperpanjang oleh /totp/enroll, dan tidak dapat
  /// diperoleh lagi lewat login (kepala berkas); simpan hanya di memori halaman. Bila kedaluwarsa sebelum
  /// /totp/confirm berhasil, admin meminta undangan ulang ke Super Admin.
  /// Galat: 400 VALIDATION_ERROR `field_errors.password`; 410 OTP_EXPIRED bila token tidak berlaku (termasuk
  /// penerimaan kedua yang kalah balapan); 429 RATE_LIMITED per IP.
  ///
  /// `POST /admin/auth/invitations/accept` (operationId `adminAcceptInvitation`).
  Future<AdminLoginResponse> adminAcceptInvitation(
    AdminInvitationAcceptRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminAcceptInvitation',
        method: 'POST',
        path: '/admin/auth/invitations/accept',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => AdminLoginResponse.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Mulai pendaftaran TOTP; menghasilkan secret dan otpauth URI untuk QR (F-02, F-16).
  ///
  /// Hanya dengan mfa_token pendaftaran dari POST /admin/auth/invitations/accept (audience `kapdh-admin-enroll`,
  /// 30 menit). Membuat secret TOTP baru (disimpan terenkripsi AES-GCM di `mfa_totp`, `verified_at` kosong) dan
  /// menggantikan secret yang belum terverifikasi sebelumnya; boleh diulang selama token berlaku (mis. QR gagal
  /// dipindai) tanpa memperpanjang masa berlakunya. Secret hanya ditampilkan di respons ini dan tidak pernah
  /// dicatat di log atau audit (ARCHITECTURE §2 butir 3).
  ///
  /// Urutan pemeriksaan (sama dengan /totp/confirm, baris admin terkunci):
  /// 1. Token: tanda tangan, audience `kapdh-admin-enroll` (mfa_token login ditolak), belum kedaluwarsa, admin
  ///    subjek ada, dan pengikat HMAC sama dengan password_hash saat ini. Gagal -> 401 UNAUTHENTICATED.
  /// 2. Aktivasi sudah selesai: admin `active` dengan TOTP terverifikasi (mis. /totp/confirm sebelumnya berhasil
  ///    tetapi responsnya hilang, atau konfirmasi bersamaan menang) -> 403 FORBIDDEN "Aktivasi sudah selesai.
  ///    Masuk dengan sandi dan kode autentikator." UI mengarahkan ke /login (bukan meminta undangan ulang).
  /// 3. Selain itu admin harus masih `invited`, tanpa undangan ulang (`invite_token_hash` kosong), dan akun
  ///    users `active`; bila tidak (dinonaktifkan, dipulihkan/diundang ulang) -> 401 UNAUTHENTICATED, UI
  ///    menyarankan meminta undangan ulang ke Super Admin.
  /// Pendaftaran ulang TOTP admin yang sudah aktif hanya melalui pemulihan oleh Super Admin (undangan ulang).
  /// Galat lain: 429 RATE_LIMITED.
  ///
  /// `POST /admin/auth/totp/enroll` (operationId `adminStartTotpEnrollment`).
  Future<AdminTotpEnrollment> adminStartTotpEnrollment(
    AdminTotpEnrollmentRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminStartTotpEnrollment',
        method: 'POST',
        path: '/admin/auth/totp/enroll',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => AdminTotpEnrollment.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Konfirmasi kode TOTP pertama; admin aktif, backup code diterbitkan, sesi admin dibuat (F-16, PRD 8.2).
  ///
  /// Memakai mfa_token pendaftaran yang sama dengan /totp/enroll dengan urutan pemeriksaan yang sama (lihat
  /// operasi itu): token tidak sah -> 401; aktivasi sudah selesai -> 403; admin tidak lagi `invited` tanpa
  /// undangan ulang atau akun tidak aktif -> 401. Pemeriksaan dilakukan setelah baris admin dikunci
  /// (FOR UPDATE), sehingga konfirmasi bersamaan diserialkan: yang menang mengaktifkan admin dan yang kalah
  /// melihat langkah 2 (403 aktivasi sudah selesai), bukan 401.
  ///
  /// Dalam satu transaksi dengan baris admin terkunci dan status masih `invited` tanpa undangan ulang
  /// (UPDATE bersyarat): kode diverifikasi terhadap secret yang belum terverifikasi (anti-replay langkah), TOTP
  /// ditandai `verified_at` dengan UPDATE bersyarat, 10 backup code baru dibuat (hanya hash yang disimpan),
  /// admin `invited` menjadi `active` dengan `activated_at`, audit `admin.activated`/`admin.mfa_enrolled` dan
  /// `admin.login` (login pertama, dasar `previous_login_at`) ditulis, email pemberitahuan keamanan dijadwalkan
  /// lewat outbox (`admin.security_notice`), dan sesi admin `mfa_level` 2 dibuat (refresh cookie). Backup code
  /// hanya ditampilkan sekali di respons ini.
  ///
  /// Hasil tidak diketahui (respons hilang, timeout, klik ganda; PRD 4.5): mengulang dengan token yang sama
  /// menghasilkan 403 "Aktivasi sudah selesai" bila percobaan sebelumnya berhasil. UI lalu mengarahkan admin ke
  /// /login (sandi + kode autentikator yang baru didaftarkan) dan memberi tahu bahwa backup code yang belum
  /// sempat disimpan dapat dibuat ulang di halaman Akun lewat POST /admin/auth/backup-codes (reautentikasi
  /// sandi + TOTP); backup code lama yang tidak pernah terlihat menjadi tidak berlaku saat dibuat ulang.
  /// Galat: 400 VALIDATION_ERROR `field_errors.totp_code` kode salah atau pendaftaran belum dimulai; 401
  /// UNAUTHENTICATED mfa_token tidak berlaku atau admin tidak lagi dalam pendaftaran; 403 FORBIDDEN aktivasi
  /// sudah selesai (termasuk pengulangan setelah respons hilang dan konfirmasi bersamaan yang kalah); 429
  /// RATE_LIMITED setelah 5 kode salah dalam 15 menit (penguncian diaudit sekali sebagai `admin.mfa_locked`;
  /// kode salah pertama dalam jendela diaudit `admin.auth_failed` dengan `after.stage` enrollment).
  /// /totp/enroll menulis audit `admin.mfa_enrollment_started` tanpa secret.
  ///
  /// `POST /admin/auth/totp/confirm` (operationId `adminConfirmTotpEnrollment`).
  Future<AdminTotpEnrollmentResult> adminConfirmTotpEnrollment(
    AdminTotpConfirmRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminConfirmTotpEnrollment',
        method: 'POST',
        path: '/admin/auth/totp/confirm',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => AdminTotpEnrollmentResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Identitas admin, izin efektif dan versi izin untuk menyusun menu (AC F15-1, F16-3).
  ///
  /// Izin dibaca dari database setiap request; `super_admin` memiliki seluruh 15 izin (ARCHITECTURE §4.5).
  /// `permissions_version` naik setiap perubahan izin; klien yang melihat versi berbeda memuat ulang menu, dan
  /// server tetap menolak hak yang dicabut walaupun token belum kedaluwarsa (AC F16-3). Menu yang disembunyikan
  /// tidak menggantikan pemeriksaan izin API (PRD 2.3). Dipanggil tanpa X-Background-Request untuk tombol
  /// "Tetap masuk" pada peringatan idle (AC F02-5); polling berkala wajib mengirim X-Background-Request.
  /// Galat: 401 UNAUTHENTICATED (sesi dicabut atau idle 30 menit); 403 MFA_REQUIRED bila memakai mfa_token;
  /// 403 FORBIDDEN bila admin tidak lagi aktif atau dipanggil dengan token sesi mobile.
  ///
  /// [backgroundRequest]: Isi `1` hanya pada request polling/refetch otomatis web admin. Request bertanda ini tidak memperbarui
  /// `sessions.last_activity_at`, sehingga idle timeout 30 menit tetap berjalan (AC F02-5, N-08). Request yang
  /// dipicu pengguna tidak boleh mengirim header ini. Server (AuthGuard) menghormatinya pada SETIAP operasi
  /// berautentikasi admin, terlepas dari deklarasi kontrak; deklarasi di sini hanya untuk GET /admin/me. Usulan
  /// perubahan bersama (belum dibuat): pindahkan parameter ini ke root.yaml sebagai
  /// `components.parameters.BackgroundRequest` agar operasi GET admin yang di-polling di domain lain (hitungan
  /// dashboard, antrean pembayaran, notifikasi admin) mendeklarasikannya; klien web admin mengirimnya lewat
  /// interceptor untuk semua refetch otomatis.
  ///
  /// `GET /admin/me` (operationId `getAdminMe`).
  Future<AdminProfile> getAdminMe({
    String? backgroundRequest,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getAdminMe',
        method: 'GET',
        path: '/admin/me',
        authRequired: true,
        headers: <String, Object?>{
          'X-Background-Request': ?backgroundRequest,
        },
        decode: (Object? v0) => AdminProfile.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat ulang 10 backup code; yang lama tidak berlaku lagi (F-02). Perlu reautentikasi.
  ///
  /// Wajib header X-Reauth-Token dari POST /auth/reauth (sandi + TOTP, maksimal 10 menit). Dalam satu
  /// transaksi seluruh hash backup code lama diganti 10 hash baru, audit `admin.backup_codes_regenerated` (tanpa
  /// kode) ditulis, dan email pemberitahuan keamanan dijadwalkan lewat outbox. Kode hanya ditampilkan sekali.
  /// Galat: 401 UNAUTHENTICATED; 403 REAUTH_REQUIRED, MFA_REQUIRED, atau FORBIDDEN (admin tidak aktif, token
  /// sesi mobile).
  ///
  /// [reauthToken]: Token dari POST /auth/reauth (audience kapdh-reauth, terikat sesi, berlaku maksimal 10 menit) untuk tindakan
  /// kredensial (ARCHITECTURE §4.3, ADR-025). Tidak ada atau kedaluwarsa menghasilkan 403 REAUTH_REQUIRED.
  ///
  /// `POST /admin/auth/backup-codes` (operationId `adminRegenerateBackupCodes`).
  Future<AdminBackupCodes> adminRegenerateBackupCodes({
    required String reauthToken,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminRegenerateBackupCodes',
        method: 'POST',
        path: '/admin/auth/backup-codes',
        authRequired: true,
        headers: <String, Object?>{
          'X-Reauth-Token': reauthToken,
        },
        decode: (Object? v0) => AdminBackupCodes.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ganti sandi admin dengan sandi lama; sesi admin lain dicabut (AC F02-4, N-08).
  ///
  /// Mensyaratkan sandi saat ini. Dalam satu transaksi sandi baru (aturan PRD 2.5) disimpan, sesi admin lain
  /// dicabut (sesi saat ini tetap), audit `admin.password_changed` ditulis tanpa nilai sandi, dan email
  /// pemberitahuan keamanan dijadwalkan lewat outbox (`admin.security_notice`). Socket sesi lain diputus setelah
  /// commit. Sandi lama salah -> 400 VALIDATION_ERROR `field_errors.current_password` (bukan 401) dan dihitung
  /// ke batas kegagalan login (429 setelah ambang); kegagalan pertama dalam jendela 15 menit diaudit
  /// `admin.auth_failed` (`after.stage` change_password, tanpa nilai sandi; F-17).
  ///
  /// `POST /admin/auth/password/change` (operationId `adminChangePassword`).
  Future<void> adminChangePassword(
    ChangePasswordRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminChangePassword',
        method: 'POST',
        path: '/admin/auth/password/change',
        authRequired: true,
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );
}
