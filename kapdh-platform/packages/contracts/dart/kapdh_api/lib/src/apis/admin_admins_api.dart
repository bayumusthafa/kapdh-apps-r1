// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Undangan admin, penugasan peran dan izin, serta pemulihan akun admin oleh Super Admin dengan sesi MFA;
/// reautentikasi hanya untuk kirim ulang undangan, pemulihan, dan koreksi email login (F-16, AC F16-1..F16-3,
/// ADR-025).
///
///
/// Kelas API untuk tag kontrak "Admin Admins". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminAdminsApi {
  const AdminAdminsApi(this._dio);

  final Dio _dio;

  /// Daftar dan pencarian admin (Super Admin, F-16, guideline hlm. 15).
  ///
  /// Tabel "Daftar Admin": nama, email login admin, peran dan akses, status. `q` mencari nama tampilan atau email
  /// (tanpa membedakan huruf besar/kecil). `total` mengikuti filter; `counts` adalah ringkasan seluruh admin
  /// untuk kartu "N Admin, M aktif". Sesi admin wajib sudah TOTP (403 MFA_REQUIRED, AC F02-2); tanpa izin
  /// admins.manage ditolak 403 FORBIDDEN walaupun menu disembunyikan (PRD 2.3).
  ///
  /// [q]: Nama tampilan atau email admin.
  /// [permission]: Hanya admin yang memiliki izin efektif ini (super_admin selalu cocok).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/admins` (operationId `adminListAdmins`).
  Future<AdminAccountPage> adminListAdmins({
    String? q,
    AdminRole? role,
    AdminAccountStatus? status,
    Permission? permission,
    AdminAccountSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListAdmins',
        method: 'GET',
        path: '/admin/admins',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          if (role case final v?) 'role': v.toJson(),
          if (status case final v?) 'status': v.toJson(),
          if (permission case final v?) 'permission': v.toJson(),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminAccountPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Undang admin baru dari alumni terpilih atau email (Super Admin, F-16, AC F16-1).
  ///
  /// "Delegasi User jadi Admin" (PRD 3.16): sistem membuat identitas login admin BARU (users.kind=admin) yang
  /// terpisah dari akun alumni dan tidak memberi hak admin pada sesi aplikasi alumni. Dua bentuk:
  ///
  /// - `alumni_user_id`: admin ditautkan ke akun alumni tersebut (admins.linked_alumni_user_id) untuk pemeriksaan
  ///   konflik kepentingan pembayaran (PRD 2.3). `email` bawaan = email akun alumni dan `display_name` bawaan =
  ///   nama lengkap alumni bila tidak diisi. Alumni yang tidak ditemukan, akunnya tidak active (termasuk
  ///   deletion_pending), atau sedang suspended menghasilkan 400 VALIDATION_ERROR pada `alumni_user_id`. Alumni
  ///   yang sudah tertaut ke identitas admin yang masih ada (status apa pun; unique admins_linked_alumni_user_id_key)
  ///   menghasilkan 409 VALIDATION_ERROR pada `alumni_user_id`, termasuk saat dua undangan bersamaan berebut
  ///   alumni yang sama (pelanggaran unique dipetakan, bukan pemeriksaan tanpa kunci). Lihat GET
  ///   /admin/admins/candidates untuk status kelayakan sebelum memilih.
  /// - tanpa `alumni_user_id`: `email` dan `display_name` wajib; admin tanpa tautan alumni.
  ///
  /// `role=admin` menerima `permissions` (izin yang assignable, beserta syarat `requires` di katalog GET
  /// /admin/permissions); `admins.manage`, izin ganda, atau izin tanpa prasyaratnya ditolak 400.
  /// `role=super_admin` wajib `permissions` kosong (Super Admin memiliki semua izin).
  ///
  /// Admin dibuat berstatus `invited` dengan sandi awal acak dan token undangan sekali pakai (hanya hash yang
  /// disimpan). Tautan undangan dikirim lewat email ke alamat login admin melalui outbox, tidak pernah ada di
  /// respons. Admin wajib mengganti sandi awal melalui token dan mendaftarkan TOTP sebelum menjadi `active`
  /// (PRD 3.16, 8.2). Email login yang sudah dipakai identitas admin lain yang belum dihapus (unique
  /// users_kind_email_key) menghasilkan 409 VALIDATION_ERROR pada `email`. Ringkasnya: 400 untuk input atau
  /// keadaan alumni yang tidak memenuhi syarat, 409 untuk bentrok unique (email login, tautan alumni). Audit
  /// `admin.invited` dan perubahan izin tercatat dalam transaksi yang sama (AC F16-1, F17-1).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/admins` (operationId `adminInviteAdmin`).
  Future<AdminInvitationResult> adminInviteAdmin(
    AdminInviteRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminInviteAdmin',
        method: 'POST',
        path: '/admin/admins',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminInvitationResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Cari alumni untuk didelegasikan menjadi admin (Super Admin, F-16, guideline hlm. 15).
  ///
  /// Modal "Delegasi User jadi Admin": mencari alumni berdasarkan nama, nomor anggota (No. KTA) atau email.
  /// Setiap item menyatakan `eligible` dan alasan bila tidak dapat dipilih (sudah tertaut ke admin, akun tidak
  /// aktif, atau suspended), sehingga UI menonaktifkan tombol "Jadikan Admin". Tanpa `q`, urutan alumni terbaru.
  /// Akun alumni yang dihapus atau deletion_pending tidak pernah muncul. Alumni `already_admin` yang tertaut ke
  /// identitas yang belum pernah aktif kembali eligible setelah identitas itu dihapus (DELETE
  /// /admin/admins/{adminId}); yang tertaut ke identitas yang pernah aktif tetap `already_admin` dan diaktifkan
  /// kembali lewat identitas yang sama.
  ///
  /// [q]: Nama, nomor anggota, atau email alumni.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/admins/candidates` (operationId `adminListAdminCandidates`).
  Future<AdminCandidatePage> adminListAdminCandidates({
    String? q,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListAdminCandidates',
        method: 'GET',
        path: '/admin/admins/candidates',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminCandidatePage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail admin, izin efektif dan versi (Super Admin, F-16).
  ///
  /// `adminId` yang bukan UUID menghasilkan 400 VALIDATION_ERROR; identitas yang tidak ada (termasuk yang sudah
  /// dihapus) 404 NOT_FOUND.
  ///
  /// [adminId]: Id identitas admin (admins.id), bukan id akun login.
  ///
  /// `GET /admin/admins/{adminId}` (operationId `adminGetAdmin`).
  Future<AdminAccountDetail> adminGetAdmin(
    String adminId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetAdmin',
        method: 'GET',
        path: '/admin/admins/${Uri.encodeComponent(adminId)}',
        authRequired: true,
        decode: (Object? v0) => AdminAccountDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus identitas admin yang belum pernah aktif dan batalkan undangannya (Super Admin, F-16).
  ///
  /// Membatalkan undangan secara permanen dan membebaskan email login serta tautan alumninya, misalnya undangan
  /// ke alamat yang salah atau alumni yang keliru dipilih (F-16, PRD 3.16). Hanya untuk identitas yang belum
  /// pernah aktif (activated_at kosong; status `invited` atau `disabled`); identitas yang pernah aktif tidak
  /// dapat dihapus karena menjadi jejak keputusan dan konflik kepentingan (PRD 2.3, 3.17), sehingga ditolak 409
  /// VALIDATION_ERROR (field_errors `_`); nonaktifkan dengan PATCH status=disabled. Pemanggil sendiri selalu
  /// identitas aktif sehingga tidak pernah dapat menghapus dirinya.
  ///
  /// Satu transaksi READ COMMITTED: DELETE bersyarat pada baris admins (`WHERE id = ... AND version = If-Match
  /// AND activated_at IS NULL RETURNING user_id`), lalu DELETE baris users akun login admin itu (kind admin;
  /// sesi, OTP dan pendaftaran TOTP yang belum selesai ikut terhapus lewat kaskade). Penjaga
  /// admins_last_super_admin_chk tidak terpengaruh karena identitas yang belum pernah aktif tidak dapat login.
  /// Token undangan langsung tidak berlaku (pratinjau dan penerimaan undangan menghasilkan 410 OTP_EXPIRED di
  /// admin-auth). Email login dan alumni tertaut segera dapat dipakai undangan baru (unique users_kind_email_key
  /// dan admins_linked_alumni_user_id_key tidak lagi bentrok). Audit `admin.deleted` (entity_type admin,
  /// entity_id = id admin) ditulis dalam transaksi yang sama dengan `before` berisi display_name, email login,
  /// peran, izin, status dan linked_alumni_user_id; riwayat `admin.invited` tetap ada karena audit append-only
  /// (AC F16-1, F17-1). If-Match tidak ada atau tidak sah: 400 VALIDATION_ERROR; usang: 409 VERSION_CONFLICT
  /// dengan `current`; identitas yang tidak ada atau sudah dihapus: 404 NOT_FOUND.
  ///
  /// [adminId]: Id identitas admin (admins.id), bukan id akun login.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/admins/{adminId}` (operationId `adminDeleteAdmin`).
  Future<void> adminDeleteAdmin(
    String adminId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeleteAdmin',
        method: 'DELETE',
        path: '/admin/admins/${Uri.encodeComponent(adminId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah nama, peran, izin, status, atau email login admin tanpa kredensial terpakai (Super Admin; reautentikasi hanya untuk email, AC F16-1..F16-3).
  ///
  /// Hanya field yang dikirim yang berubah; minimal satu field. Wajib `If-Match` = `version` terakhir; versi
  /// berbeda menghasilkan 409 VERSION_CONFLICT dengan `current` = AdminAccountDetail terbaru (AC F15-4).
  ///
  /// Reautentikasi bersyarat (ADR-025): `X-Reauth-Token` (`ReauthTokenConditional`) wajib HANYA bila `email`
  /// berbeda dari email login sekarang, karena alamat baru menjadi tujuan tautan pengaturan sandi + TOTP (tindakan
  /// kredensial, setara kirim ulang undangan dan pemulihan). Tanpa token yang sah, permintaan itu ditolak 403
  /// REAUTH_REQUIRED tanpa efek; diperiksa setelah validasi isian dan If-Match, sebelum aturan email lainnya
  /// (status yang diizinkan, email terpakai). Nama, peran, izin dan status tidak memerlukannya; token yang dikirim
  /// tetapi tidak sah tidak menolak perubahan tersebut.
  ///
  /// - `permissions` mengganti seluruh himpunan izin (hanya untuk peran `admin`, aturan sama dengan undangan).
  ///   Mengubah peran ke `super_admin` mengosongkan izin tersimpan; mengubah ke `admin` wajib menyertakan
  ///   `permissions` (boleh kosong).
  /// - `status`: `disabled` dari invited/active (undangan dibatalkan, seluruh sesi admin dicabut dan socket
  ///   diputus); `active` hanya dari disabled untuk admin yang pernah aktif (activated_at terisi) dan masih
  ///   memiliki TOTP terverifikasi (`mfa_enrolled`), sehingga kredensial lama dipakai lagi. Selain itu 409
  ///   VALIDATION_ERROR pada `status`: admin yang belum pernah aktif dipulihkan lewat POST
  ///   /admin/admins/{adminId}/invitation, sedangkan admin tanpa TOTP atau yang kredensialnya diduga bocor
  ///   dipulihkan lewat POST /admin/admins/{adminId}/recovery. `reason` wajib untuk `disabled`.
  /// - Setiap perubahan peran/izin/status menaikkan permissions_version sehingga izin yang dicabut tidak berlaku
  ///   pada request API atau socket berikutnya walaupun token belum expired (AC F16-3).
  /// - Super Admin terakhir yang aktif tidak dapat diturunkan atau dinonaktifkan, termasuk oleh dirinya sendiri
  ///   dan saat dua request bersamaan: penjaga transaksi database (admins_last_super_admin_chk) menolak dan API
  ///   mengembalikan 409 VALIDATION_ERROR dengan field_errors pada `role`/`status` serta `current` (AC F16-2).
  ///   Penurunan memakai UPDATE bersyarat ... RETURNING, bukan hitungan tanpa kunci.
  /// - `email` (koreksi email login, misalnya salah ketik saat undangan atau pemulihan; wajib X-Reauth-Token,
  ///   lihat di atas): hanya selama tidak ada kredensial yang dapat dipakai, yaitu status `invited` (undangan
  ///   pertama, atau pemulihan yang sandi dan MFA-nya sudah direset) atau `disabled` yang belum pernah aktif;
  ///   tidak boleh digabung dengan `status` (400 VALIDATION_ERROR). Admin `active`, atau `disabled` yang pernah
  ///   aktif, ditolak 409 VALIDATION_ERROR pada `email`; alamat barunya ditetapkan lewat POST
  ///   /admin/admins/{adminId}/recovery (`email`) karena alamat baru harus disertai reset sandi dan MFA. Bila
  ///   identitas pernah aktif (sedang dipulihkan), pemberitahuan keamanan `admin.security_notice` juga dikirim ke
  ///   alamat lama. Server menormalisasi (lower, trim) dan mengubah users.email akun login admin dalam
  ///   transaksi yang sama (baris admins lebih dahulu, lalu users); bentrok users_kind_email_key menghasilkan
  ///   409 VALIDATION_ERROR pada `email`. Untuk status `invited`, token undangan lama langsung tidak berlaku,
  ///   pendaftaran TOTP yang sedang berjalan dibatalkan (baris mfa_totp yang belum terverifikasi dihapus,
  ///   users.session_version naik, sesi dicabut), dan token baru (invite_expires_at baru) dikirim lewat outbox ke
  ///   alamat BARU; untuk `disabled` yang belum pernah aktif, alamat baru dipakai saat kirim ulang undangan.
  ///   Email yang sama dengan alamat sekarang tidak mengubah apa pun.
  /// - Tautan alumni tidak dapat diubah lewat PATCH. Identitas yang belum pernah aktif yang tertaut ke alumni
  ///   yang salah dihapus (DELETE /admin/admins/{adminId}) lalu alumni yang benar diundang.
  ///
  /// Audit `admin.updated` berisi sebelum/sesudah peran, izin, status dan email login beserta alasan (AC F16-1,
  /// F17-1); email adalah kolom privat yang dimasking pada ekspor CSV audit (AC F17-3).
  ///
  /// [adminId]: Id identitas admin (admins.id), bukan id akun login.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [reauthToken]: Token dari POST /auth/reauth (audience kapdh-reauth, terikat sesi, berlaku maksimal 10 menit) yang wajib HANYA
  /// bila permintaan memuat perubahan kredensial yang disebut deskripsi operasi, misalnya koreksi email login admin
  /// (reautentikasi bersyarat, ADR-025). Perubahan itu tanpa token yang sah menghasilkan 403 REAUTH_REQUIRED;
  /// perubahan lain pada operasi yang sama tidak memerlukannya, dan token yang tidak sah tidak menolak perubahan
  /// lain tersebut.
  ///
  /// `PATCH /admin/admins/{adminId}` (operationId `adminUpdateAdmin`).
  Future<AdminAccountDetail> adminUpdateAdmin(
    String adminId,
    AdminUpdateRequest body, {
    required String ifMatch,
    String? reauthToken,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateAdmin',
        method: 'PATCH',
        path: '/admin/admins/${Uri.encodeComponent(adminId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'X-Reauth-Token': ?reauthToken,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminAccountDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kirim ulang undangan dengan token baru (Super Admin + reautentikasi, F-16).
  ///
  /// Untuk admin `invited` (token lama, kedaluwarsa atau belum, langsung tidak berlaku; termasuk admin yang
  /// sedang dipulihkan lewat POST /admin/admins/{adminId}/recovery) atau admin `disabled` yang belum pernah
  /// aktif (kembali menjadi `invited`). Admin `active`, atau `disabled` yang pernah aktif, ditolak 409
  /// VALIDATION_ERROR: aktifkan kembali dengan PATCH status=active bila kredensialnya masih utuh, atau pulihkan
  /// dengan POST /admin/admins/{adminId}/recovery bila sandi/TOTP hilang atau diduga bocor. Wajib `If-Match`
  /// (tidak ada atau bukan versi yang sah: 400 VALIDATION_ERROR; usang: 409 VERSION_CONFLICT); menaikkan
  /// version. Email undangan dikirim lewat outbox ke email login admin; token tidak ada di respons. Diaudit
  /// `admin.invitation_resent` (AC F17-1).
  ///
  /// [adminId]: Id identitas admin (admins.id), bukan id akun login.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [reauthToken]: Token dari POST /auth/reauth (audience kapdh-reauth, terikat sesi, berlaku maksimal 10 menit) untuk tindakan
  /// kredensial (ARCHITECTURE §4.3, ADR-025). Tidak ada atau kedaluwarsa menghasilkan 403 REAUTH_REQUIRED.
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/admins/{adminId}/invitation` (operationId `adminResendAdminInvitation`).
  Future<AdminInvitationResult> adminResendAdminInvitation(
    String adminId, {
    required String ifMatch,
    required String reauthToken,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminResendAdminInvitation',
        method: 'POST',
        path: '/admin/admins/${Uri.encodeComponent(adminId)}/invitation',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'X-Reauth-Token': reauthToken,
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (Object? v0) => AdminInvitationResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Pulihkan admin yang pernah aktif dengan mereset sandi dan MFA lewat undangan ulang (Super Admin + reautentikasi, F-16).
  ///
  /// Jalur "membantu pemulihan akun" (PRD 3.16; risiko PRD 10 "Pemulihan admin/approval terhambat") untuk admin
  /// yang pernah aktif (activated_at terisi) berstatus `active` atau `disabled`: lupa sandi, kehilangan
  /// perangkat TOTP beserta backup code, atau kredensial diduga bocor. Inilah "reset MFA/undangan ulang oleh
  /// Super Admin" yang dirujuk domain admin-auth (C1). Pengurus tidak pernah melihat atau menentukan sandi dan
  /// secret admin (pola PRD 3.16 untuk reset alumni).
  ///
  /// Dalam SATU transaksi (READ COMMITTED; UPDATE bersyarat ... RETURNING pada baris admins dengan version =
  /// If-Match dan status/activated_at yang memenuhi syarat, baris admins diubah sebelum baris users):
  /// 1. Status admin menjadi `invited` dengan token undangan sekali pakai baru (hanya hash disimpan,
  ///    invite_expires_at baru); disabled_at dikosongkan, activated_at dipertahankan sebagai riwayat;
  ///    permissions_version dan version naik. Peran dan izin tidak berubah.
  /// 2. Baris mfa_totp akun login admin dihapus (secret dan seluruh backup code), sehingga aktivasi berikutnya
  ///    wajib mendaftarkan TOTP baru.
  /// 3. users.password_hash akun login admin diganti hash sandi acak yang tidak diketahui siapa pun; sandi lama
  ///    langsung tidak berlaku.
  /// 4. Seluruh sesi admin target dicabut, users.session_version naik, dan socket diputus, sehingga token yang
  ///    belum expired pun tidak berlaku lagi (AC F16-3).
  /// 5. Bila `email` diisi dan berbeda (admin kehilangan akses ke kotak surat lamanya), users.email akun login
  ///    admin diganti alamat baru yang dinormalisasi; bentrok users_kind_email_key menghasilkan 409
  ///    VALIDATION_ERROR pada `email`. Tanpa `email`, alamat lama dipakai.
  /// 6. Audit `admin.recovery_initiated` berisi alasan serta status (dan email login bila berubah)
  ///    sebelum/sesudah, tanpa token, hash atau secret (AC F16-1, F17-1); outbox: email undangan pemulihan ke
  ///    email login admin yang BERLAKU (alamat baru bila diganti) dan pemberitahuan keamanan
  ///    `admin.security_notice` (pola AC F16-4) ke alamat yang berlaku serta, bila email diganti, juga ke alamat
  ///    lama, sehingga pemilik sah mengetahui pengalihan. Token undangan tidak pernah ada di respons atau log.
  ///    Super Admin wajib memverifikasi identitas admin di luar sistem sebelum mengganti alamat dan
  ///    mencatatnya di `reason`.
  ///
  /// Admin lalu mengulang penerimaan undangan di admin-auth: sandi baru melalui token sekali pakai, lalu
  /// pendaftaran TOTP, sebelum `active` kembali (PRD 3.16). Login sandi-saja ditolak selama `invited` (AC F02-2).
  ///
  /// Penolakan (409 VALIDATION_ERROR dengan field_errors `_`, kecuali disebut lain):
  /// - Super Admin memulihkan dirinya sendiri; gunakan ganti sandi admin atau backup code di admin-auth.
  /// - Admin `invited` atau yang belum pernah aktif; gunakan POST /admin/admins/{adminId}/invitation.
  /// - Super Admin aktif terakhir yang dapat login: penjaga transaksi admins_last_super_admin_chk (23514)
  ///   dipetakan ke 409 VALIDATION_ERROR dengan field_errors `status` dan `current` (AC F16-2). Pemanggil
  ///   sendiri selalu Super Admin aktif, sehingga ini hanya terjadi pada balapan dengan perubahan lain.
  /// - If-Match usang: 409 VERSION_CONFLICT dengan `current` = AdminAccountDetail terbaru (AC F15-4).
  /// Dibatasi per admin (429 RATE_LIMITED); Idempotency-Key mencegah reset ganda saat klik ulang.
  ///
  /// [adminId]: Id identitas admin (admins.id), bukan id akun login.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [reauthToken]: Token dari POST /auth/reauth (audience kapdh-reauth, terikat sesi, berlaku maksimal 10 menit) untuk tindakan
  /// kredensial (ARCHITECTURE §4.3, ADR-025). Tidak ada atau kedaluwarsa menghasilkan 403 REAUTH_REQUIRED.
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/admins/{adminId}/recovery` (operationId `adminRecoverAdmin`).
  Future<AdminRecoveryResult> adminRecoverAdmin(
    String adminId,
    AdminRecoveryRequest body, {
    required String ifMatch,
    required String reauthToken,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminRecoverAdmin',
        method: 'POST',
        path: '/admin/admins/${Uri.encodeComponent(adminId)}/recovery',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'X-Reauth-Token': reauthToken,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminRecoveryResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Katalog izin dan peran berlabel Bahasa Indonesia (F-16, ARCHITECTURE §4.5).
  ///
  /// Dipakai formulir undangan/ubah admin dan tampilan izin sendiri; tersedia untuk semua admin ber-MFA. Urutan
  /// dan label tetap (label bawaan, `requires` = izin prasyarat yang wajib ikut ditugaskan):
  ///
  /// | permission             | label                              | group         | requires        | assignable |
  /// | ---------------------- | ---------------------------------- | ------------- | --------------- | ---------- |
  /// | payments.read          | Lihat pembayaran                   | payments      | -               | ya         |
  /// | payments.decide        | Putuskan pembayaran                | payments      | payments.read   | ya         |
  /// | members.read           | Lihat anggota                      | members       | -               | ya         |
  /// | members.manage         | Kelola anggota                     | members       | members.read    | ya         |
  /// | content.manage         | Kelola konten                      | content       | -               | ya         |
  /// | master.manage          | Kelola master profesi dan keahlian | members       | -               | ya         |
  /// | events.manage          | Kelola event dan tiket             | events        | -               | ya         |
  /// | events.checkin         | Check-in tiket                     | events        | -               | ya         |
  /// | moderation.read        | Lihat laporan                      | moderation    | -               | ya         |
  /// | moderation.resolve     | Putuskan laporan                   | moderation    | moderation.read | ya         |
  /// | audit.read             | Lihat audit                        | audit         | -               | ya         |
  /// | audit.export           | Ekspor audit                       | audit         | audit.read      | ya         |
  /// | settings.manage        | Kelola metode bayar dan pengaturan | settings      | -               | ya         |
  /// | admins.manage          | Kelola admin dan izin              | admins        | -               | tidak      |
  /// | notifications.manage   | Kelola pengiriman notifikasi       | notifications | -               | ya         |
  ///
  /// Peran: `super_admin` "Super Admin" (semua izin, mengelola admin dan izin dengan sesi MFA; reautentikasi
  /// untuk tindakan kredensial); `admin` "Admin" (hanya izin yang ditugaskan) (PRD 2.3).
  ///
  /// `GET /admin/permissions` (operationId `adminListPermissions`).
  Future<AdminPermissionCatalog> adminListPermissions({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPermissions',
        method: 'GET',
        path: '/admin/permissions',
        authRequired: true,
        decode: (Object? v0) => AdminPermissionCatalog.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
