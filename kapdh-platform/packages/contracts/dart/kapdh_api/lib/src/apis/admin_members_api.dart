// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pengelolaan anggota oleh pengurus: daftar dengan pencarian/filter/urutan/paging server, detail
/// administratif, koreksi identitas dan nomor (AC F05-6), suspend/unsuspend (PRD 4.2, AC F12-4, F12-5),
/// histori keanggotaan, dan inisiasi pemulihan sandi alumni oleh Super Admin (AC F16-4) (F-15, F-16).
///
///
/// Kelas API untuk tag kontrak "Admin Members". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminMembersApi {
  const AdminMembersApi(this._dio);

  final Dio _dio;

  /// Daftar anggota dengan pencarian, filter, urutan, paging dan total dari server (F-15, guideline hal. 16).
  ///
  /// Tabel "Manajemen Users": total alumni terdaftar (`total` sesuai filter), pencarian `q` (nama, email, nomor
  /// anggota atau kota; tidak peka huruf besar), filter angkatan, effective_status (dihitung dari timestamp
  /// saat request, AC F07-3), kota, jenis kelamin, profesi, keahlian dan keterkaitan dengan akun admin.
  /// Mencakup akun alumni pending_otp sampai deletion_pending; akun yang sudah terhapus tidak tampil.
  ///
  /// Paging keyset sesuai `sort` tanpa duplikasi/terlewat antar halaman (AC F10-1); cursor terikat pada
  /// filter dan sort yang sama, cursor dari kombinasi lain ditolak 400 VALIDATION_ERROR. Daftar memuat email
  /// dan kota untuk tujuan administratif; kontak lain hanya di detail.
  ///
  /// [q]: Cari nama, email, nomor anggota (awalan) atau kota.
  /// [cohort]: Angkatan.
  /// [effectiveStatus]: Status efektif terkini (PRD 2.2).
  /// [city]: Kota domisili (sama persis, tidak peka huruf besar).
  /// [professionId]: Profesi (master, termasuk yang nonaktif); cocok bila salah satu profesi anggota tertaut master itu.
  /// [skillId]: Keahlian (master, termasuk yang nonaktif).
  /// [hasLinkedAdmin]: true = hanya alumni yang tertaut ke akun admin; false = hanya yang belum (dialog delegasi admin, F-16).
  /// [sort]: Urutan (bawaan registered_desc).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/members` (operationId `adminListMembers`).
  Future<AdminMemberPage> adminListMembers({
    String? q,
    int? cohort,
    EffectiveStatus? effectiveStatus,
    String? city,
    Gender? gender,
    String? professionId,
    String? skillId,
    bool? hasLinkedAdmin,
    AdminMemberSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListMembers',
        method: 'GET',
        path: '/admin/members',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          'cohort': ?cohort,
          if (effectiveStatus case final v?) 'effective_status': v.toJson(),
          'city': ?city,
          if (gender case final v?) 'gender': v.toJson(),
          'profession_id': ?professionId,
          'skill_id': ?skillId,
          'has_linked_admin': ?hasLinkedAdmin,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminMemberPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail administratif anggota, termasuk kontak terlepas dari flag privasi (F-10, F-15).
  ///
  /// Memuat identitas, kontak dan tautan sosial terlepas dari flag privasi (pengurus berizin tetap dapat
  /// mengakses data untuk tujuan administratif yang tercatat, F-10); setiap pembukaan detail dicatat di audit
  /// (`member.viewed`, tanpa salinan data). Juga memuat periode keanggotaan, status suspend, keterkaitan
  /// dengan akun admin, ringkasan tiket, serta ringkasan pembayaran dan moderasi. Histori lengkap ada di
  /// GET /admin/members/{userId}/membership-events. `version` dipakai sebagai If-Match untuk perubahan.
  /// Akun bukan alumni atau sudah terhapus -> 404.
  ///
  /// Penyaringan per izin (PRD 2.3, AC F15-1: admin hanya melihat data area izinnya), dievaluasi dari DB setiap
  /// request dan berlaku sama untuk respons 200 operasi lain yang mengembalikan AdminMemberDetail maupun
  /// `current` pada 409 VERSION_CONFLICT:
  /// - tanpa payments.read: `recent_payments` null;
  /// - tanpa events.manage DAN tanpa payments.read: `recent_tickets` null. Tiket memuat partisipasi event dan
  ///   informasi pembayaran tiket (`total`, status awaiting_payment/awaiting_review/paid) yang hanya dibuka
  ///   kepada pengelola event (daftar peserta, adminListEventTickets) atau pembaca pembayaran (antrean
  ///   pembayaran tiket); events.checkin saja tidak cukup;
  /// - tanpa moderation.read: `moderation` null dan `suspension.reason` (alasan internal moderasi) null dengan
  ///   `suspension.reason_redacted` true. `suspended_at`, `suspended_by` dan `member_message` (pesan yang
  ///   memang ditampilkan ke anggota) tetap dikirim karena status suspend menentukan status keanggotaan.
  /// super_admin memiliki semua izin sehingga menerima detail utuh.
  ///
  /// [userId]: users.id akun alumni.
  ///
  /// `GET /admin/members/{userId}` (operationId `adminGetMember`).
  Future<AdminMemberDetail> adminGetMember(
    String userId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetMember',
        method: 'GET',
        path: '/admin/members/${Uri.encodeComponent(userId)}',
        authRequired: true,
        decode: (Object? v0) => AdminMemberDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah data administratif dan koreksi identitas anggota; nomor dihitung ulang dengan N tetap (AC F05-6).
  ///
  /// Izin members.manage (PRD 2.3). Alasan wajib dan tercatat di audit bersama before/after tersaring
  /// (AC F17-1). Field yang tidak dikirim tidak berubah. `member_number` dan field lain di luar skema DITOLAK
  /// 400 VALIDATION_ERROR (AC F05-6: nomor tidak pernah dari klien). Email tidak dapat diubah di sini (alur
  /// koreksi email terverifikasi, F-01); privasi tetap pilihan anggota.
  ///
  /// Koreksi identitas (full_name, gender, cohort, class_in, class_out): bila prefix AA.SS.JK berubah, server
  /// menghitung ulang nomor dari data tersimpan dan mempertahankan N dalam SATU UPDATE bersama segmen
  /// pembentuknya (constraint alumni_member_number_chk), mencatat membership_event `number_correction`
  /// dengan nomor lama dan baru, audit `member.number_corrected`, menerbitkan ulang QR (QR lama menjadi
  /// "perlu diperbarui"), dan memberi notifikasi kategori membership ke anggota (rute /kta), semuanya dalam
  /// satu transaksi (AC F05-6, F17-1). Contoh: 12.02.01.7 dengan kelas keluar dikoreksi menjadi 6 menjadi
  /// 12.01.01.7. Kelas keluar tidak boleh lebih rendah dari kelas masuk (400).
  ///
  /// `professions`, `education`, `social_links` dan skill_ids mengikuti aturan yang sama dengan PATCH /me/profile
  /// (daftar pengganti, master aktif AC F10-4, SocialHandle: nama pengguna atau URL https, skema lain 400),
  /// termasuk aturan transisi field lama (profession_id, last_education_*, social_*) dan penolakan field lama
  /// bersama penggantinya. Audit tidak menyalin isi profesi/pendidikan/tautan (hanya nama field yang berubah).
  /// `remove_avatar` menghapus foto yang tidak pantas (berkas dilepas dan dibersihkan job). Akun deletion_pending tidak dapat diubah (400). Admin tidak dapat mengubah akun alumni yang tertaut
  /// ke identitas adminnya sendiri (admins.linked_alumni_user_id; konflik kepentingan, PRD 2.3) -> 403
  /// FORBIDDEN. Versi berbeda dari If-Match -> 409 VERSION_CONFLICT dengan `current` berbentuk
  /// AdminMemberDetail yang disaring per izin seperti GET detail (AC F15-4, F15-1).
  ///
  /// [userId]: users.id akun alumni.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/members/{userId}` (operationId `adminUpdateMember`).
  Future<AdminMemberDetail> adminUpdateMember(
    String userId,
    AdminMemberUpdate body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateMember',
        method: 'PATCH',
        path: '/admin/members/${Uri.encodeComponent(userId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMemberDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batasi (suspend) anggota dari halaman anggota dengan alasan dan pesan untuk anggota (PRD 4.2, AC F12-3, F12-4).
  ///
  /// Tindakan moderasi setara keputusan suspend pada adminResolveReport (moderasi hanya di web admin, F-12),
  /// sehingga memakai aturan izin yang SAMA dengan jalur moderasi: moderation.read dan moderation.resolve
  /// (PRD 2.3 "moderation.read dan moderation.resolve"), ditambah members.read untuk halaman anggota. Pelaku
  /// dengan demikian selalu dapat membaca kembali alasan internal yang ditulisnya. UI wajib meminta konfirmasi
  /// (PRD 4.5); body `confirm` harus true. Prasyarat: anggota tidak sedang suspended dan akun tidak
  /// deletion_pending (400 bila dilanggar dengan versi terkini). Tindakan atas akun alumni yang tertaut ke admin
  /// pelaku ditolak 403 FORBIDDEN (konflik kepentingan, PRD 2.3).
  ///
  /// Dalam SATU transaksi (AC F12-3, F17-1, F04-1): alumni.suspended_at/suspension_reason/suspension_message/
  /// suspended_by_admin_id diisi; tanggal periode TIDAK diubah (PRD 4.2); membership_event `suspend` dengan
  /// aktor dan alasan; audit `member.suspended`; notifikasi kategori account (wajib) ke anggota dengan rute
  /// /restricted. Setelah commit seluruh sesi umum anggota dicabut (`session.revoked` reason
  /// account_suspended, all_sessions true) dan socket diputus (AC F12-4, F02-6), sama dengan jalur moderasi.
  /// Akibat: effective_status suspended mengalahkan masa aktif, direktori menyembunyikan profil, verifikasi KTA
  /// menjadi Tidak aktif (AC F12-4), tiket anggota tidak berlaku untuk check-in dan refund diputuskan per kasus
  /// (PRD 2.2). Persetujuan pembayaran berikutnya tidak menghapus suspend (AC F07-4). Anggota dapat mengajukan
  /// banding dari portal pembatasan (POST /appeals, domain moderation). Pengulangan dengan Idempotency-Key sama
  /// mengembalikan hasil pertama. Respons dan `current` pada 409 disaring per izin seperti GET detail.
  ///
  /// [userId]: users.id akun alumni.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/members/{userId}/suspend` (operationId `adminSuspendMember`).
  Future<AdminMemberDetail> adminSuspendMember(
    String userId,
    AdminMemberSuspendRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminSuspendMember',
        method: 'POST',
        path: '/admin/members/${Uri.encodeComponent(userId)}/suspend',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMemberDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Cabut pembatasan anggota; status dihitung ulang dari expires_at (PRD 4.2, AC F12-3, F12-5).
  ///
  /// Izin sama dengan jalur moderasi (moderation.read dan moderation.resolve, PRD 2.3) ditambah members.read;
  /// UI wajib meminta konfirmasi (PRD 4.5), body `confirm` harus true. Prasyarat: anggota sedang suspended
  /// (400 bila tidak, dengan versi terkini). Admin tidak dapat mencabut pembatasan akun alumni yang tertaut ke
  /// dirinya sendiri (403 FORBIDDEN, konflik kepentingan PRD 2.3).
  ///
  /// Dalam SATU transaksi (AC F12-3, F12-5, F17-1), dengan baris alumni terkunci:
  /// 1. kolom suspend dikosongkan; membership_event `unsuspend` dengan aktor dan alasan; audit
  ///    `member.unsuspended`;
  /// 2. setiap banding aktif milik anggota (reports berkategori `appeal`, target_user_id = anggota, status
  ///    open/in_review; dikunci FOR UPDATE) ditutup sebagai DIKABULKAN, sama dengan aturan adminResolveReport
  ///    untuk "jalur unsuspend lain (menu anggota admin)": status resolved, action unsuspend,
  ///    resolution_note merujuk pencabutan dari menu anggota beserta `reason`, resolved_by_admin_id = pelaku,
  ///    resolved_at = waktu server transaksi ini, version naik, audit `moderation.report_resolved` per
  ///    banding. Banding tampil bagi pemohon dengan outcome action_taken dan `decision_message` =
  ///    `member_message` (atau teks baku "Pembatasan akun Anda telah dicabut pengurus" bila kosong);
  /// 3. satu notifikasi kategori account ke anggota yang memuat `member_message` (atau teks baku) dan, bila ada
  ///    banding yang ditutup, menyatakan banding dikabulkan; tidak ada notifikasi ganda per banding.
  /// effective_status dihitung ulang dari verifikasi dan expires_at, bukan otomatis verified: anggota yang masa
  /// aktifnya habis menjadi expired dan yang belum pernah paid menjadi unverified (AC F12-5). Idempotency-Key
  /// dihormati. Respons dan `current` pada 409 disaring per izin seperti GET detail.
  ///
  /// [userId]: users.id akun alumni.
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/members/{userId}/unsuspend` (operationId `adminUnsuspendMember`).
  Future<AdminMemberDetail> adminUnsuspendMember(
    String userId,
    AdminMemberUnsuspendRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUnsuspendMember',
        method: 'POST',
        path: '/admin/members/${Uri.encodeComponent(userId)}/unsuspend',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMemberDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Super Admin menginisiasi pemulihan sandi alumni tanpa melihat atau menentukan sandi (F-16, AC F16-4).
  ///
  /// Hanya Super Admin (PRD 2.3; admin dengan izin apa pun -> 403 FORBIDDEN), dengan sesi ber-TOTP dan
  /// reautentikasi (X-Reauth-Token <= 10 menit, ARCHITECTURE §4.3; tanpa token -> 403 REAUTH_REQUIRED).
  /// Body `confirm` harus true dan `reason` wajib.
  ///
  /// Dalam SATU transaksi (AC F16-4, F17-1): baris users dikunci; challenge OTP purpose password_reset
  /// diterbitkan (challenge aktif sebelumnya untuk tujuan yang sama disupersede, otp_codes_active_key,
  /// PRD 2.5); seluruh sesi akun target dicabut dan socket diputus setelah commit (`session.revoked` reason
  /// password_reset, all_sessions true); notifikasi keamanan (kategori security, wajib) ke target; audit
  /// `member.password_reset_initiated` tanpa kode/token; outbox `member.password_reset_initiated`. Kode tidak
  /// pernah ada di respons, log, audit atau URL (ARCHITECTURE §2).
  ///
  /// Penyerahan dan penukaran challenge (AC F16-4 "hanya melalui kanal terverifikasi", AC F02-4), satu bentuk
  /// kanonik yang sama dengan forgotPassword di domain auth:
  /// 1. Email OTP dikirim ke email terverifikasi target (sinkron, ADR-004) dan memuat kode OTP serta tautan
  ///    aplikasi `kapdh://app/forgot/otp?challenge_id=<challenge_id>` (bentuk eksternal deep link
  ///    ARCHITECTURE §4.7, rute /forgot/otp §8.4; nama parameter sama dengan field `challenge_id` pada
  ///    PasswordResetVerifyRequest). Tidak ada bentuk tautan lain (tanpa App Links/Universal Links di R1.0).
  ///    challenge_id bukan rahasia tanpa kode (kode terikat challenge, 5 percobaan, 10 menit); kode hanya ada di
  ///    badan email.
  /// 2. Tautan membuka layar /forgot/otp yang terikat challenge tersebut (tanpa memanggil POST
  ///    /auth/password/forgot, sehingga challenge pengurus TIDAK disupersede). Anggota memasukkan kode dan
  ///    menukarnya dengan reset_token lewat POST /auth/password/forgot/verify (verifyPasswordResetOtp,
  ///    challenge_id + code), lalu menyimpan sandi baru dengan POST /auth/password/reset (AC F02-4).
  /// 3. Kode kedaluwarsa atau tidak diterima di layar itu: anggota meminta kirim ulang untuk challenge yang sama
  ///    (POST /auth/otp/resend dengan challenge_id). Tautan tidak dapat dibuka (mis. klien email tidak
  ///    mendukung skema aplikasi): anggota memulai "Lupa sandi" mandiri. Challenge baru mana pun menggantikan
  ///    challenge pengurus dan tetap hanya dikirim ke email terverifikasi, sehingga pemulihan tetap dapat
  ///    diselesaikan.
  /// Notifikasi keamanan (inbox/push/email pemberitahuan) hanya memberi tahu bahwa pemulihan dimulai pengurus
  /// dan meminta anggota membuka email; tidak memuat challenge_id maupun kode.
  ///
  /// Prasyarat: akun alumni berstatus active (termasuk suspended; pemulihan akun diizinkan, PRD 2.2); akun
  /// pending_otp, disabled atau deletion_pending -> 400. Akun alumni yang tertaut ke Super Admin pelaku
  /// memakai alur lupa sandi mandiri (403 FORBIDDEN). Batas pengiriman OTP per email berlaku (429, PRD 2.5).
  /// Idempotency-Key dihormati sehingga klik ganda tidak mengirim dua challenge.
  ///
  /// [userId]: users.id akun alumni.
  /// [reauthToken]: Token dari POST /auth/reauth (audience kapdh-reauth, terikat sesi, berlaku maksimal 10 menit) untuk tindakan
  /// kredensial (ARCHITECTURE §4.3, ADR-025). Tidak ada atau kedaluwarsa menghasilkan 403 REAUTH_REQUIRED.
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/members/{userId}/password-reset` (operationId `adminInitiateMemberPasswordReset`).
  Future<AdminMemberPasswordResetResult> adminInitiateMemberPasswordReset(
    String userId,
    AdminMemberPasswordResetRequest body, {
    required String reauthToken,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminInitiateMemberPasswordReset',
        method: 'POST',
        path: '/admin/members/${Uri.encodeComponent(userId)}/password-reset',
        authRequired: true,
        headers: <String, Object?>{
          'X-Reauth-Token': reauthToken,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMemberPasswordResetResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Histori keanggotaan dan moderasi anggota (aktivasi, renewal, suspend, unsuspend, koreksi nomor, peringatan) (PRD 4.2, 6.3).
  ///
  /// Riwayat periode dan moderasi dipisahkan dari kolom periode sehingga tanggal habis tidak hilang saat
  /// suspend (PRD 4.2). Setiap entri memuat aktor (null untuk sistem), alasan, payment sumber
  /// (activation/renewal) dan nilai sebelum/sesudah. Peringatan (warn) tidak mengubah tanggal (AC F12-3).
  /// Urut terbaru lebih dulu, keyset (created_at, id), dengan total.
  ///
  /// Penyaringan per izin (PRD 2.3, AC F15-1), konsisten dengan GET detail:
  /// - tanpa moderation.read: entri `warn` (murni moderasi) tidak dikembalikan dan tidak dihitung di `total`;
  ///   filter `kind=warn` ditolak 403 FORBIDDEN. Entri `suspend`/`unsuspend` tetap tampil (memengaruhi status
  ///   keanggotaan) tetapi `reason` null dengan `reason_redacted` true;
  /// - alasan `number_correction` (koreksi administratif, members.manage) tampil untuk members.read.
  ///
  /// [userId]: users.id akun alumni.
  /// [kind]: Filter jenis peristiwa.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/members/{userId}/membership-events` (operationId `adminListMemberMembershipEvents`).
  Future<AdminMembershipEventPage> adminListMemberMembershipEvents(
    String userId, {
    AdminMembershipEventKind? kind,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListMemberMembershipEvents',
        method: 'GET',
        path: '/admin/members/${Uri.encodeComponent(userId)}/membership-events',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (kind case final v?) 'kind': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminMembershipEventPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
