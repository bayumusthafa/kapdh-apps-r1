// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pendaftaran, OTP, koreksi email, login, sesi perangkat, pemulihan/penggantian sandi dan reautentikasi
/// (F-01, F-02, PRD 2.5, PRD 5.2). Batas baseline PRD 2.5 (Usulan, final D1): OTP 6 digit berlaku 10 menit,
/// 5 percobaan, kirim ulang setelah 60 detik, 5 pengiriman per jam per email plus batas IP; 10 kegagalan login
/// dalam 15 menit memicu cooldown 15 menit tanpa menutup jalur lupa sandi. Penolakan batas memakai 429
/// RATE_LIMITED dengan `retry_after_seconds` dan header Retry-After.
///
///
/// Kelas API untuk tag kontrak "Auth". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AuthApi {
  const AuthApi(this._dio);

  final Dio _dio;

  /// Daftar akun alumni dan kirim OTP email (F-01, AC F01-1, F01-4).
  ///
  /// Langkah "Data Diri" stepper pendaftaran (guidelines R8): membuat akun `pending_otp` beserta data diri
  /// minimum; email dinormalisasi (huruf kecil, tanpa spasi tepi) sebelum pemeriksaan unik
  /// (`users_kind_email_key`, per jenis identitas selama akun belum `deleted`). Tidak ada field NIK/KTP
  /// (disahkan v3.3, N-09). Kode OTP tidak pernah dikirim ke klien (AC F01-1).
  ///
  /// Request ulang dengan email yang sama selama akun masih `pending_otp` melanjutkan akun yang sama: data dan
  /// sandi terbaru menggantikan yang lama dan challenge signup/email_change sebelumnya batal (binding sandi
  /// berubah), sehingga tidak ada akun ganda (AC F01-4). Idempotency-Key yang sama dengan payload sama
  /// mengembalikan challenge pertama (PRD 4.3). Nomor anggota belum dialokasikan sampai OTP terverifikasi.
  ///
  /// Persetujuan privasi dan ketentuan dicatat bersama versi dan waktunya (F-01). Klien menampilkan kedua
  /// dokumen dari GET /public/pages lalu mengirim `consent.policy_version` (skema `LegalConsentVersions`,
  /// domain content) apa adanya sebagai `accept_policy_version`. Server TIDAK mempercayai nilai klien: di dalam
  /// transaksi register ia menyusun ulang nilai terkini dari `app_settings.legal`
  /// (`privacy:<privacy_version>;terms:<terms_version>`) dan membandingkannya sebelum memeriksa email. Hanya nilai
  /// yang sama persis yang disimpan di `users.policy_version`, dengan `users.policy_accepted_at` = waktu server
  /// (Clock) saat request diterima; pendaftaran ulang akun `pending_otp` memperbarui keduanya. Tidak sama ->
  /// 409 VERSION_CONFLICT dengan `current` berisi `LegalConsentVersions` terkini: klien memuat ulang dokumen,
  /// meminta persetujuan lagi, lalu mengirim ulang. Selama kebijakan privasi atau ketentuan belum pernah terbit,
  /// `current.policy_version` null dan setiap registrasi ditolak 409 yang sama; klien menampilkan "Pendaftaran
  /// belum dibuka" (PRD 8.2 langkah 4).
  ///
  /// Galat: 400 VALIDATION_ERROR (field tidak valid, `accept_policy_version` tidak berpola, kelas keluar sebelum
  /// kelas masuk, angkatan di luar rentang); 409 VERSION_CONFLICT (versi persetujuan usang atau dokumen legal
  /// belum terbit, lihat di atas); 409 VALIDATION_ERROR `field_errors.email` bila email sudah dipakai akun
  /// alumni yang aktif, dinonaktifkan atau sedang dihapus; 409 IDEMPOTENCY_CONFLICT; 429 RATE_LIMITED (batas
  /// pengiriman OTP; cooldown kirim ulang; atau batas kegagalan sandi). Registrasi ulang akun `pending_otp`
  /// membandingkan sandi dengan sandi tersimpan, sehingga setiap perbandingan memakai jatah batas kegagalan login
  /// email itu (PRD 2.5: 10 kegagalan per 15 menit, bersama login): sandi sama mereset penghitung, sandi berbeda
  /// tercatat sebagai kegagalan; setelah habis setiap registrasi ulang email itu ditolak 429 tanpa penulisan.
  /// Setiap registrasi (termasuk yang dijawab 409 email sudah terdaftar) memakai satu jatah anggaran registrasi
  /// per IP (120 per jam) SEBELUM keberadaan email dinilai, sehingga jawaban 409 tidak dapat dipakai sebagai oracle
  /// email terdaftar tanpa batas (PRD 2.5); anggaran habis -> 429 tanpa menilai email.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /auth/register` (operationId `register`).
  Future<OtpChallenge> register(
    RegisterRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'register',
        method: 'POST',
        path: '/auth/register',
        authRequired: false,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => OtpChallenge.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Verifikasi OTP pendaftaran atau koreksi email lalu aktifkan akun (F-01, AC F01-2, F01-3).
  ///
  /// Hanya untuk challenge `signup` dan `email_change`. Kode benar dikonsumsi sekali secara atomik: akun menjadi
  /// `active`, `email_verified_at` terisi, nomor anggota AA.SS.JK.N dialokasikan sekali dari
  /// `app.membership_no_seq` dengan KTA berstatus Tidak Aktif (effective_status `unverified`), lalu sesi mobile
  /// diterbitkan dan klien melanjutkan ke langkah Biaya KTA (AC F01-2, PRD 4.2). Sesi mencatat `device_name`
  /// dari body serta platform dan versi aplikasi dari header X-App-Platform/X-App-Version.
  ///
  /// Challenge pemulihan sandi diverifikasi di POST /auth/password/forgot/verify dan challenge hapus akun di
  /// POST /public/deletion/verify. Challenge dengan tujuan lain, tidak dikenal, kedaluwarsa, sudah dipakai,
  /// sudah diganti (resend, pendaftaran ulang, koreksi email), percobaan habis, sandi akun berubah setelah
  /// kode dikirim, atau akun tidak lagi `pending_otp` (mis. pendaftaran dibatalkan lewat penghapusan web,
  /// account.yaml), semuanya ditolak 410 OTP_EXPIRED tanpa membedakan penyebab; aktivasi memakai UPDATE
  /// bersyarat `WHERE status = 'pending_otp'` dengan baris users terkunci sehingga tidak pernah balapan dengan
  /// penghapusan. UI menawarkan challenge baru sesuai cooldown (AC F01-3).
  ///
  /// Hasil tidak diketahui (respons hilang, timeout, ketuk ganda; AC F01-4, PRD 4.5): verifikasi tidak dapat
  /// diulang karena kode sudah dikonsumsi, dan token sesi tidak pernah disimpan di penyimpanan idempotensi. Bila
  /// pengulangan menghasilkan 410 setelah percobaan sebelumnya berakhir tanpa respons, klien TIDAK langsung
  /// meminta challenge baru (resend akan ikut 410 karena akun mungkin sudah aktif), melainkan memanggil
  /// POST /auth/login dengan email dan sandi yang masih ada di memori dari langkah Data Diri, atau meminta
  /// pengguna masuk bila aplikasi sempat ditutup. `next: home` berarti aktivasi sudah berhasil dan sesi baru
  /// diterbitkan; `next: verify_otp` berarti akun belum aktif dan `challenge` yang dikembalikan dipakai untuk
  /// melanjutkan.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [appVersion]: Versi aplikasi Flutter (semver), dikirim di setiap request oleh klien mobile. Mutasi dari versi di bawah
  /// `min_app_version` platform tersebut ditolak 426 UPGRADE_REQUIRED (PRD 4.5).
  ///
  /// `POST /auth/otp/verify` (operationId `verifyOtp`).
  Future<OtpVerifyResponse> verifyOtp(
    OtpVerifyRequest body, {
    DevicePlatform? appPlatform,
    String? appVersion,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'verifyOtp',
        method: 'POST',
        path: '/auth/otp/verify',
        authRequired: false,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
          'X-App-Version': ?appVersion,
        },
        data: body.toJson(),
        decode: (Object? v0) => OtpVerifyResponse.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kirim ulang OTP untuk challenge yang sama tujuannya; kode lama dibatalkan (PRD 2.5, AC F01-3).
  ///
  /// Berlaku untuk semua tujuan (`signup`, `email_change`, `password_reset`, `deletion`). Challenge baru bertujuan
  /// sama (challenge_id baru, 5 percobaan, berlaku 10 menit) menggantikan yang lama secara atomik dengan baris
  /// users terkunci; kode lama tidak dapat dipakai lagi. Untuk challenge aktivasi, slot signup/email_change
  /// dibatalkan bersama (lihat kepala berkas). Ditolak 429 RATE_LIMITED sebelum `resend_available_at` (cooldown
  /// 60 detik) atau bila batas 5 pengiriman per jam per email/IP terlampaui; `retry_after_seconds` berisi sisa
  /// waktu tunggu.
  ///
  /// Challenge pengganti yang diberikan alur non-enumerasi (lupa sandi, hapus akun web) untuk email yang tidak
  /// terdaftar atau tidak memenuhi syarat diperlakukan persis seperti challenge nyata: resend menghasilkan
  /// challenge pengganti baru dengan cooldown dan batas yang sama, tanpa mengirim email (PRD 2.5).
  /// 410 OTP_EXPIRED bila challenge sudah dipakai, sudah diganti, tidak dikenal (termasuk challenge yang dibuat
  /// lebih dari 24 jam lalu, nyata maupun pengganti), atau akun tidak lagi pada
  /// keadaan yang sesuai tujuan (`signup`/`email_change`: pending_otp; `password_reset`: active; `deletion`:
  /// active, pending_otp, deletion_pending atau disabled). Resend selalu mengirim email dan memakai batas kirim;
  /// untuk sekadar membaca keadaan challenge (layar yang dibuka dari tautan atau setelah aplikasi dimulai
  /// ulang) gunakan POST /auth/otp/status.
  ///
  /// `POST /auth/otp/resend` (operationId `resendOtp`).
  Future<OtpChallenge> resendOtp(
    OtpResendRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'resendOtp',
        method: 'POST',
        path: '/auth/otp/resend',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => OtpChallenge.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Baca keadaan challenge OTP tanpa mengirim, mengganti atau mengonsumsi kode (PRD 2.5, AC F16-4, F01-3).
  ///
  /// Hanya-baca untuk semua tujuan. Dipakai layar OTP yang dibuka dari tautan email (pemulihan sandi yang
  /// diinisiasi pengurus, AC F16-4, rute /forgot/otp) atau yang dipulihkan setelah aplikasi dimulai ulang, agar
  /// dapat menampilkan email tujuan, masa berlaku 10 menit, "Sisa percobaan n dari 5" dan hitung mundur kirim
  /// ulang (prototype screen_1_otp) tanpa memanggil POST /auth/otp/resend, yang akan ditolak cooldown 60 detik,
  /// mengganti kode yang baru diterima pengguna, mengirim email lagi dan memakan batas 5 kirim per jam.
  ///
  /// Tidak mengirim email, tidak membuat/membatalkan challenge, tidak menambah percobaan dan tidak dihitung ke
  /// batas kirim OTP per email. Mengembalikan 200 tepat ketika POST /auth/otp/resend masih dapat menerima
  /// challenge ini, termasuk challenge yang sudah kedaluwarsa (`expires_at` lampau) atau percobaannya habis
  /// (`attempts_left` 0) sehingga UI langsung menawarkan kirim ulang; 410 OTP_EXPIRED tepat ketika resend juga
  /// akan 410 (sudah dipakai, sudah diganti, tidak dikenal, atau akun tidak lagi pada keadaan yang sesuai
  /// tujuan; tidak dibedakan). Challenge pengganti dari alur non-enumerasi (lupa sandi, hapus akun web)
  /// menghasilkan bentuk, nilai dan waktu respons yang sama dengan challenge nyata (PRD 2.5).
  /// challenge_id dikirim di body, tidak di path/query, agar tidak tercatat di log akses. Galat: 400
  /// VALIDATION_ERROR; 410 OTP_EXPIRED; 429 RATE_LIMITED (batas per IP, terpisah dari batas kirim OTP).
  ///
  /// `POST /auth/otp/status` (operationId `getOtpChallengeStatus`).
  Future<OtpChallenge> getOtpChallengeStatus(
    OtpChallengeStatusRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getOtpChallengeStatus',
        method: 'POST',
        path: '/auth/otp/status',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => OtpChallenge.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Koreksi email akun pending_otp melalui alur terverifikasi (PRD 2.2, F-01).
  ///
  /// Tautan "Salah email? Ubah alamat email" pada layar OTP. Hanya untuk akun alumni `pending_otp` (email belum
  /// pernah terverifikasi). Pemilik membuktikan kepemilikan akun dengan `challenge_id` signup/email_change
  /// miliknya (boleh kedaluwarsa, belum dikonsumsi) dan sandi akun; kegagalan sandi dihitung ke batas kegagalan
  /// login (PRD 2.5).
  ///
  /// Dalam satu transaksi dengan baris users terkunci: email diganti ke `new_email` (ternormalisasi, unik per
  /// jenis identitas), challenge signup/email_change yang masih aktif dibatalkan sehingga email lama tidak dapat
  /// lagi mengaktifkan akun, lalu challenge `email_change` baru dikirim ke email baru. Akun baru aktif setelah
  /// kode itu diverifikasi di POST /auth/otp/verify (AC F01-2), sehingga email baru terbukti dimiliki pendaftar.
  /// Perubahan dicatat di audit tanpa kode OTP.
  ///
  /// Galat: 400 VALIDATION_ERROR (`field_errors.new_email` tidak valid atau sama dengan email sekarang;
  /// `field_errors.password` sandi salah); 409 VALIDATION_ERROR `field_errors.new_email` bila email baru sudah
  /// terdaftar; 410 OTP_EXPIRED bila challenge tidak dikenal/sudah dipakai atau akun tidak lagi `pending_otp`;
  /// 429 RATE_LIMITED (cooldown kegagalan login atau batas kirim OTP ke email baru). Kuota kirim OTP (per IP dan
  /// per email baru) dipakai SEBELUM keberadaan email baru dinilai, sehingga jawaban 409 ikut terbatas dan akun
  /// pending milik pemanggil tidak menjadi oracle email terdaftar tanpa batas (PRD 2.5).
  ///
  /// `POST /auth/email-correction` (operationId `correctPendingEmail`).
  Future<OtpChallenge> correctPendingEmail(
    EmailCorrectionRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'correctPendingEmail',
        method: 'POST',
        path: '/auth/email-correction',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => OtpChallenge.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Login alumni dengan email dan sandi (F-02, AC F02-1).
  ///
  /// Email dicocokkan setelah normalisasi terhadap akun alumni yang belum `deleted`; waktu respons dibuat
  /// serupa untuk email tidak terdaftar. Hasil menurut `users.status` (PRD 2.2, 4.2):
  /// - `active` -> `next: home` dan `session` (access token 15 menit, refresh token berotasi; AC F02-1).
  ///   effective_status di GET /me menentukan rute (termasuk anggota suspended ke portal pembatasan).
  /// - `pending_otp` -> `next: verify_otp` dan `challenge` aktivasi, tanpa token sesi. Challenge aktivasi yang
  ///   sedang aktif (`signup` atau `email_change`, mana pun yang ada) dikembalikan apa adanya bila belum
  ///   kedaluwarsa dan masih memiliki sisa percobaan, agar tidak memakan batas kirim. Bila tidak ada, dengan
  ///   baris users terkunci seluruh challenge signup dan email_change yang masih aktif dibatalkan lalu satu
  ///   challenge baru dikirim ke email akun saat ini, bertujuan sama dengan challenge aktivasi terakhir akun
  ///   (`email_change` bila email pernah dikoreksi, selain itu `signup`). Paling banyak satu challenge aktivasi
  ///   aktif per akun (kepala berkas). Klien memakai `challenge.purpose` dari respons ini, bukan nilai yang
  ///   diingat dari layar OTP sebelumnya.
  /// - `deletion_pending` -> `next: deletion_pending` dan `deletion` (status permintaan penghapusan), tanpa
  ///   sesi; sandi yang benar adalah challenge terbatas untuk pemeriksaan status (PRD 2.2, F-14).
  /// - `disabled` -> `next: account_disabled` tanpa sesi; klien menampilkan kontak bantuan (pemulihan hanya
  ///   melalui pengurus, PRD 2.2). Status ini tidak memiliki operasi API: masuk (`disable`), pemulihan yang
  ///   disetujui (`enable`) dan permintaan penghapusan (`delete`) dijalankan operator lewat CLI teraudit
  ///   `account:status` atas keputusan pengurus (runbook docs/runbooks/alumni-account-disabled.md).
  /// Sesi mencatat `device_name` dari body serta platform dan versi aplikasi dari header
  /// X-App-Platform/X-App-Version, dan memperbarui `users.last_login_at`. Sesi hanya diterbitkan bila sandi
  /// yang dinilai masih sandi akun dan akun masih `active` di bawah kunci baris users: login yang sedang
  /// berjalan ketika reset/ganti sandi atau penonaktifan commit mendapat 401 yang sama (AC F02-4).
  ///
  /// Galat: 401 UNAUTHENTICATED "Email atau sandi salah" (tidak membedakan email tidak terdaftar); 429
  /// RATE_LIMITED setelah 10 kegagalan dalam 15 menit per email atau ambang per IP, cooldown 15 menit dengan
  /// tautan lupa sandi yang tetap berfungsi (PRD 2.5).
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [appVersion]: Versi aplikasi Flutter (semver), dikirim di setiap request oleh klien mobile. Mutasi dari versi di bawah
  /// `min_app_version` platform tersebut ditolak 426 UPGRADE_REQUIRED (PRD 4.5).
  ///
  /// `POST /auth/login` (operationId `login`).
  Future<LoginResponse> login(
    LoginRequest body, {
    DevicePlatform? appPlatform,
    String? appVersion,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'login',
        method: 'POST',
        path: '/auth/login',
        authRequired: false,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
          'X-App-Version': ?appVersion,
        },
        data: body.toJson(),
        decode: (Object? v0) => LoginResponse.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Rotasi refresh token. Reuse token lama mencabut seluruh keluarga sesi (AC F02-3).
  ///
  /// Flutter mengirim `refresh_token` di body (satu proses refresh terkoordinasi per perangkat, PRD 5.2). Web
  /// admin mengirim cookie HttpOnly `kapdh_admin_rt` dan header Origin yang sama dengan ADMIN_ORIGIN (CSRF);
  /// body boleh kosong; respons hanya berisi access token dan refresh token baru dikirim lewat Set-Cookie.
  ///
  /// Rotasi atomik: sesi baru dalam keluarga yang sama dibuat dan sesi lama ditandai `replaced_by` dengan
  /// UPDATE bersyarat; token yang sudah dirotasi atau dicabut, bila dipakai lagi, mencabut seluruh keluarga dan
  /// menghasilkan 401 (AC F02-3). Pemakaian ganda BERSAMAAN dengan token yang sama diperlakukan sama dengan
  /// pemakaian ulang berurutan: tepat satu rotasi berhasil (200), setiap permintaan lain mendapat 401 setelah
  /// melihat token sudah dirotasi, dan seluruh keluarga (termasuk baris hasil rotasi pemenang) dicabut, token
  /// push-nya dinonaktifkan, socketnya diputus (`session.revoked` alasan `refresh_reuse_detected`) dan kejadian
  /// keamanan diaudit. Pencuri yang berlomba dengan klien sah tidak pernah mempertahankan keluarga sesi; klien
  /// sah wajib mengoordinasikan satu refresh per perangkat/tab (PRD 5.2), sehingga pemakaian ganda hanya terjadi
  /// pada klien rusak atau token yang dicuri. Token yang dicabut tanpa rotasi (logout, idle admin, pencabutan
  /// sesi, keluar semua perangkat, reset sandi) cukup ditolak 401 tanpa kejadian keamanan. Baris baru mewarisi
  /// keadaan keluarga dari baris yang dirotasi:
  /// `reauthenticated_at`, `last_activity_at`, `mfa_level` dan `device_name` (kepala berkas), sehingga
  /// X-Reauth-Token yang masih berlaku tetap diterima setelah refresh. Refresh tidak dihitung
  /// sebagai aktivitas: sesi admin yang menganggur lebih dari 30 menit ditolak 401 (AC F02-5, N-08). Akun `disabled`, `deletion_pending` atau `deleted` ditolak 401.
  /// TTL refresh (D1: mobile 60 hari, admin 12 jam) adalah umur ABSOLUT keluarga sesi sejak login (PRD 5.2,
  /// terpisah dari idle timeout): baris hasil rotasi mewarisi `expires_at` keluarga dan rotasi tidak pernah
  /// memperpanjangnya. Setelah batas itu refresh ditolak 401 dan pengguna masuk ulang (admin: sandi + TOTP).
  /// Refresh mobile memperbarui `app_version`/`platform` sesi dari header X-App-Version/X-App-Platform.
  /// Rotasi yang sedang berjalan diserialkan dengan pencabutan sesi (logout, logout-all, revokeSession,
  /// deteksi pemakaian ulang, reset/ganti sandi) lewat kunci baris users: pencabutan selalu ikut mencabut baris
  /// hasil rotasi, atau rotasi kalah dan menjawab 401; tidak ada keluarga sesi yang lolos dari pencabutan yang
  /// sudah dijawab sukses (AC F02-3, F02-6).
  /// 403 FORBIDDEN bila Origin cookie admin tidak sesuai.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [appVersion]: Versi aplikasi Flutter (semver), dikirim di setiap request oleh klien mobile. Mutasi dari versi di bawah
  /// `min_app_version` platform tersebut ditolak 426 UPGRADE_REQUIRED (PRD 4.5).
  ///
  /// `POST /auth/refresh` (operationId `refreshSession`).
  Future<TokenPair> refreshSession({
    RefreshRequest? body,
    DevicePlatform? appPlatform,
    String? appVersion,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'refreshSession',
        method: 'POST',
        path: '/auth/refresh',
        authRequired: false,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
          'X-App-Version': ?appVersion,
        },
        data: body?.toJson(),
        decode: (Object? v0) => TokenPair.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Cabut sesi saat ini dan nonaktifkan token push perangkat ini (F-02, AC F13-5).
  ///
  /// Mencabut keluarga sesi pemanggil, menonaktifkan token push yang terdaftar dengan sesi itu
  /// (`device_tokens.session_id`) sehingga perangkat tidak lagi menerima notifikasi akun ini (AC F13-5), dan
  /// memutus socket sesi itu (event `session.revoked`). Untuk sesi admin, cookie `kapdh_admin_rt` dihapus.
  /// Klien menghapus token, cache KTA offline dan data akun privat (PRD 5.2, AC F05-2..4).
  ///
  /// `POST /auth/logout` (operationId `logout`).
  Future<void> logout({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'logout',
        method: 'POST',
        path: '/auth/logout',
        authRequired: true,
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Keluar dari semua perangkat; HTTP dan socket lama tidak dapat dipakai lagi (AC F02-6).
  ///
  /// Dalam satu transaksi: semua sesi pengguna dicabut dan `session_version` naik sehingga access token yang
  /// belum kedaluwarsa pun ditolak; setelah commit seluruh socket pengguna diputus (event `session.revoked`) dan
  /// token push dari sesi yang dicabut berhenti menerima notifikasi (AC F02-6, AC F13-5, PRD 9.2). Kejadian
  /// diaudit; alumni menerima notifikasi kategori `security` (wajib) dengan deep link `/account/sessions`. Untuk
  /// sesi admin, cookie `kapdh_admin_rt` dihapus. Rotasi refresh atau login perangkat lain yang sedang berjalan
  /// saat permintaan ini tiba selesai lebih dulu lalu ikut dicabut, atau gagal 401 (lihat refreshSession).
  ///
  /// `POST /auth/logout-all` (operationId `logoutAll`).
  Future<void> logoutAll({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'logoutAll',
        method: 'POST',
        path: '/auth/logout-all',
        authRequired: true,
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar perangkat yang sedang masuk ke akun ini (F-02, layar Sesi).
  ///
  /// Satu item per keluarga sesi yang belum dicabut dan belum kedaluwarsa milik pemanggil (alumni melihat sesi
  /// mobile, admin melihat sesi web admin). `id` adalah identitas keluarga sesi yang stabil selama rotasi refresh
  /// token. Urutan stabil `created_at` (awal keluarga sesi, tidak pernah berubah) terbaru lebih dahulu, lalu `id`
  /// menurun; cursor keyset memakai pasangan itu sehingga aktivitas perangkat selama paging (termasuk request
  /// daftar ini yang memperbarui `last_seen_at`) tidak membuat item terulang atau terlewat. `created_at` adalah
  /// baris tertua keluarga yang masih disimpan; `device_name`, `platform`, `app_version` dan `expires_at` dari
  /// baris aktif terbaru keluarga, `last_seen_at` aktivitas terakhir di seluruh keluarga. Klien menampilkan
  /// sesi `current` di atas dan boleh mengurutkan tampilan menurut `last_seen_at`. Tidak memuat token, hash,
  /// maupun IP.
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /auth/sessions` (operationId `listSessions`).
  Future<SessionPage> listSessions({
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listSessions',
        method: 'GET',
        path: '/auth/sessions',
        authRequired: true,
        queryParameters: <String, Object?>{
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => SessionPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Cabut satu perangkat milik sendiri (F-02).
  ///
  /// Mencabut seluruh keluarga sesi `sessionId` milik pemanggil, menonaktifkan token push sesi itu dan memutus
  /// socketnya setelah commit (`session.revoked`). Mencabut sesi saat ini sama dengan logout (untuk sesi admin
  /// cookie `kapdh_admin_rt` dihapus). 404 NOT_FOUND bila sesi tidak ada, sudah dicabut atau kedaluwarsa, atau
  /// milik pengguna lain (tidak dibedakan, N-09); 400 VALIDATION_ERROR bila `sessionId` bukan UUID. Rotasi
  /// refresh keluarga itu yang sedang berjalan selesai lebih dulu dan baris barunya ikut dicabut (bukan 404).
  ///
  /// [sessionId]: Identitas keluarga sesi dari `Session.id` (GET /auth/sessions).
  ///
  /// `DELETE /auth/sessions/{sessionId}` (operationId `revokeSession`).
  Future<void> revokeSession(
    String sessionId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'revokeSession',
        method: 'DELETE',
        path: '/auth/sessions/${Uri.encodeComponent(sessionId)}',
        authRequired: true,
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Mulai pemulihan sandi; respons selalu sama dan tidak mengungkap email terdaftar (F-02, PRD 2.5).
  ///
  /// Bila email milik akun alumni `active` (termasuk anggota yang disuspend), challenge `password_reset` dibuat
  /// (baris users dikunci, challenge lama dibatalkan) dan kode dikirim ke email terverifikasi. Untuk email lain
  /// (tidak terdaftar, `pending_otp`, `disabled`, `deletion_pending`) server mengembalikan challenge pengganti
  /// berbentuk sama tanpa mengirim email; batas pengiriman per email/IP diterapkan identik pada keduanya
  /// sehingga respons, waktu dan 429 tidak membedakan keadaan akun. Cooldown kegagalan login tidak menutup alur
  /// ini (PRD 2.5). Akun admin memulihkan sandi melalui undangan ulang Super Admin (F-16), bukan endpoint ini.
  /// Permintaan ulang untuk email yang sama selama cooldown kirim ulang 60 detik challenge aktif (ketuk ganda,
  /// request diulang) mengembalikan challenge aktif yang sama tanpa email baru dan tanpa memakai batas kirim;
  /// bila percobaan challenge itu sudah habis, 429 RATE_LIMITED sampai cooldown lewat. Aturan ini sama untuk
  /// challenge nyata dan pengganti. Email kode nyata tidak ditunggu sebelum respons dikirim, sehingga waktu
  /// respons tidak bergantung pada server email; bila email tidak sampai, pengguna memakai kirim ulang.
  ///
  /// Reset yang diinisiasi pengurus (AC F16-4, F-16; operasi adminInitiateMemberPasswordReset milik domain
  /// admin-members, topik outbox `member.password_reset_initiated`) mencabut seluruh sesi anggota, mengirim
  /// notifikasi keamanan, dan menerbitkan challenge `password_reset` yang sama bentuknya HANYA ke email
  /// terverifikasi anggota. Email itu memuat kode dan tautan aplikasi yang didefinisikan admin-members:
  /// `${PUBLIC_WEB_URL}/app/forgot/otp?challenge=<challenge_id>` atau bentuk skema setara
  /// `kapdh://app/forgot/otp?challenge=<challenge_id>` (rute /forgot/otp, ARCHITECTURE §4.7, §8.4). Tautan hanya
  /// membawa challenge_id, bukan kode, sehingga kode dari email tetap wajib dimasukkan di
  /// POST /auth/password/forgot/verify. Layar yang dibuka dari tautan memanggil POST /auth/otp/status dengan
  /// challenge_id itu untuk menampilkan email, masa berlaku, sisa percobaan dan hitung mundur kirim ulang tanpa
  /// mengganti kode yang baru diterima; POST /auth/otp/resend hanya dipanggil bila pengguna menekan "Kirim
  /// ulang". Bila anggota justru memulai endpoint ini, challenge dari pengurus dibatalkan dan diganti challenge
  /// baru ke email yang sama, yaitu kanal terverifikasi yang sama.
  ///
  /// `POST /auth/password/forgot` (operationId `forgotPassword`).
  Future<OtpChallenge> forgotPassword(
    ForgotPasswordRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'forgotPassword',
        method: 'POST',
        path: '/auth/password/forgot',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => OtpChallenge.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tukar OTP pemulihan dengan reset_token sekali pakai (F-02, AC F02-4).
  ///
  /// Kode `password_reset` yang benar dikonsumsi sekali secara atomik (UPDATE bersyarat `consumed_at`) dan ditukar
  /// dengan `reset_token`: JWT audience `kapdh-password-reset` berumur 10 menit, subject akun, klaim `cid`
  /// challenge yang dikonsumsi dan pengikat HMAC dari password_hash saat ini (pola `otp_codes.binding`). Token
  /// tidak disimpan di server; sifat sekali pakainya dijamin POST /auth/password/reset yang mengganti password_hash
  /// sehingga pengikat tidak lagi cocok (kepala berkas). Token batal pula bila sandi berubah lewat jalur lain lebih
  /// dahulu. Challenge pengganti dari alur non-enumerasi selalu diperlakukan sebagai kode salah sampai percobaan
  /// habis (410), sama seperti challenge nyata.
  /// Bila respons hilang, kode sudah dikonsumsi: pengguna memulai ulang lupa sandi (challenge baru, batas kirim
  /// tetap berlaku); reset_token yang tidak pernah diterima kedaluwarsa sendiri.
  /// Galat: 400 VALIDATION_ERROR kode salah dengan sisa percobaan di `field_errors.code`; 410 OTP_EXPIRED
  /// (kedaluwarsa, dipakai, diganti, percobaan habis, tujuan lain); 429 RATE_LIMITED.
  ///
  /// `POST /auth/password/forgot/verify` (operationId `verifyPasswordResetOtp`).
  Future<PasswordResetGrant> verifyPasswordResetOtp(
    PasswordResetVerifyRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'verifyPasswordResetOtp',
        method: 'POST',
        path: '/auth/password/forgot/verify',
        authRequired: false,
        data: body.toJson(),
        decode: (Object? v0) => PasswordResetGrant.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Simpan sandi baru dengan reset_token; seluruh sesi dicabut (AC F02-4, F16-4).
  ///
  /// Dalam satu transaksi dengan baris users terkunci (FOR UPDATE): reset_token diverifikasi (tanda tangan,
  /// audience, kedaluwarsa, challenge `cid` milik akun yang sama bertujuan `password_reset` dan sudah dikonsumsi,
  /// akun masih `active`, pengikat sama dengan password_hash saat ini), lalu sandi baru di-hash bcrypt dan
  /// disimpan dengan UPDATE bersyarat `WHERE id = <akun> AND password_hash = <hash terikat> RETURNING`. Nol baris
  /// berarti token sudah dipakai (atau sandi berubah lebih dahulu) -> 410; karena hash berganti, token yang sama
  /// tidak pernah berhasil dua kali, termasuk dua request bersamaan. Dalam transaksi yang sama semua sesi
  /// dicabut dan `session_version` naik; setelah commit socket diputus (`session.revoked`). Notifikasi
  /// kategori `security` (wajib, tidak dapat dimatikan) dan email pemberitahuan dikirim lewat outbox dengan deep
  /// link `/account/sessions`; isi pemberitahuan tidak memuat sandi atau token. Pengguna lalu masuk ulang.
  /// Sandi 8..72 byte UTF-8 dengan huruf besar, kecil, angka dan simbol; ditolak, bukan dipotong (PRD 2.5).
  /// Bila respons hilang dan pengulangan menghasilkan 410, sandi baru mungkin sudah tersimpan: klien
  /// mengarahkan ke login dengan sandi baru sebelum menyarankan lupa sandi ulang (PRD 4.5).
  /// Galat: 400 VALIDATION_ERROR `field_errors.new_password`; 410 OTP_EXPIRED bila reset_token kedaluwarsa,
  /// sudah dipakai, tidak sah, akun tidak lagi aktif, atau sandi sudah berubah (tidak dibedakan).
  ///
  /// `POST /auth/password/reset` (operationId `resetPassword`).
  Future<void> resetPassword(
    ResetPasswordRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'resetPassword',
        method: 'POST',
        path: '/auth/password/reset',
        authRequired: false,
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ganti sandi alumni dengan sandi lama; sesi perangkat lain dicabut (AC F02-4).
  ///
  /// Mensyaratkan sandi saat ini (AC F02-4). Dalam satu transaksi sandi baru disimpan dan semua sesi lain milik
  /// pengguna dicabut (sesi saat ini tetap berlaku); socket sesi lain diputus setelah commit. Notifikasi
  /// `security` dan email pemberitahuan dikirim lewat outbox. Admin memakai POST /admin/auth/password/change.
  /// Sandi lama yang salah adalah galat formulir 400 VALIDATION_ERROR `field_errors.current_password` (bukan
  /// 401, agar klien tidak memicu refresh/logout) dan dihitung ke batas kegagalan login (429 setelah ambang).
  /// Sandi baru mengikuti aturan PRD 2.5 (`field_errors.new_password`). Token sesi admin ditolak 403 FORBIDDEN
  /// (operasi khusus audience mobile, ARCHITECTURE §4.3).
  ///
  /// `POST /auth/password/change` (operationId `changePassword`).
  Future<void> changePassword(
    ChangePasswordRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'changePassword',
        method: 'POST',
        path: '/auth/password/change',
        authRequired: true,
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Reautentikasi untuk tindakan kredensial; token berlaku maksimal 10 menit (F-14, F-16, ADR-025).
  ///
  /// Membuktikan ulang identitas pemilik sesi sebelum tindakan kredensial: hapus akun anggota (F-14), buat ulang
  /// backup code admin (F-02), kirim ulang undangan, pemulihan dan koreksi email login admin (F-16; koreksi email
  /// bersyarat lewat PATCH /admin/admins/{adminId}), serta reset sandi anggota (AC F16-4). Sejak keputusan PO
  /// 2026-10-15 (ADR-025) perubahan pengaturan, biaya, metode bayar, serta undang/ubah nama-peran-izin-status/hapus
  /// admin tidak lagi memintanya. Alumni: sandi. Admin: sandi DAN salah satu `totp_code`
  /// (kode yang sama tidak dapat dipakai dua kali, `mfa_totp.last_used_step`) atau `backup_code` (sekali pakai,
  /// dikonsumsi atomik). `reauth_token` dikirim lewat header X-Reauth-Token pada operasi kredensial dan berlaku
  /// maksimal 10 menit (ARCHITECTURE §4.3); boleh dipakai berulang dalam jendela itu (mis. beberapa pemulihan
  /// admin berturut-turut).
  ///
  /// Pengikatan ke KELUARGA sesi, bukan baris sesi (kepala berkas): token adalah JWT audience `kapdh-reauth`
  /// dengan `sub` = pengguna, `sid` = `family_id` sesi pemanggil (sama dengan `Session.id` di GET
  /// /auth/sessions), `lvl` = tingkat MFA saat reautentikasi (2 bila TOTP/backup code dipakai) dan `iat` =
  /// waktu reautentikasi; `sessions.reauthenticated_at` keluarga diperbarui ke waktu yang sama dan diwarisi
  /// baris baru setiap rotasi refresh. Operasi `reauth: true` (dan operasi ber-ReauthTokenConditional untuk isi
  /// kredensialnya) menerima token bila tanda tangan dan audience sah, umur `iat` paling lama 10 menit, `sub`
  /// sama dengan pengguna access token, `sid` sama dengan
  /// `family_id` sesi yang membawa access token (bukan id baris), dan untuk sesi admin `lvl` 2; selain itu 403
  /// REAUTH_REQUIRED. Dengan demikian refresh access token 15 menit di tengah alur sensitif (mis. membaca
  /// pengungkapan lalu POST /me/deletion, atau dialog reautentikasi Super Admin untuk tindakan kredensial) tidak
  /// memaksa reautentikasi ulang, sedangkan token dari keluarga lain (perangkat lain) selalu ditolak. Mencabut
  /// keluarga (logout, revokeSession, logout-all, reset sandi, penghapusan akun) membuat access token keluarga
  /// itu ditolak 401 sehingga reauth_token-nya tidak dapat dipakai lagi.
  ///
  /// Anggota suspended tetap dapat reautentikasi untuk penghapusan akun (deletion-only).
  /// Kredensial salah adalah galat formulir 400 VALIDATION_ERROR (`field_errors.password`,
  /// `field_errors.totp_code` atau `field_errors.backup_code`), bukan 401; 5 kegagalan dalam 15 menit per sesi
  /// menghasilkan 429 RATE_LIMITED.
  ///
  /// `POST /auth/reauth` (operationId `reauthenticate`).
  Future<ReauthResponse> reauthenticate(
    ReauthRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'reauthenticate',
        method: 'POST',
        path: '/auth/reauth',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => ReauthResponse.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
