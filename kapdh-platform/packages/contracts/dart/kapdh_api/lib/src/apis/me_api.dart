// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Profil, status keanggotaan, KTA dan periode milik sendiri serta master terkontrol (F-05, F-07, F-10,
/// PRD 2.2, 3.5). Semua nilai status dihitung server dari data canonical; klien hanya merender dan merutekan.
///
///
/// Kelas API untuk tag kontrak "Me". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class MeApi {
  const MeApi(this._dio);

  final Dio _dio;

  /// Profil sendiri, status akun, effective_status dan penunjuk iuran terbuka untuk perutean klien (PRD 2.2, AC F02-1).
  ///
  /// Dipanggil setelah login, saat aplikasi kembali aktif, dan setelah galat MEMBERSHIP_REQUIRED atau
  /// ACCOUNT_SUSPENDED untuk menentukan rute (routeForStatus, PRD 2.2). Dapat dipanggil semua effective_status
  /// yang memiliki sesi (unverified, verified, expiring, expired, suspended). Akun pending_otp tidak memperoleh
  /// sesi (login mengarah ke OTP); akun disabled/deletion_pending sesinya dicabut sehingga mendapat 401.
  ///
  /// Perutean onboarding (prototipe layar 2, 3, 4, 5) memakai `registration_payment`:
  /// - effective_status unverified dan `registration_payment` null: layar Biaya KTA (/onboarding/fees);
  /// - stage `awaiting_proof`: layar pembayaran/unggah bukti (/payments/{id});
  /// - stage `awaiting_review`: layar Menunggu Verifikasi;
  /// - stage `rejected`: layar Ditolak dengan `rejection_reason` (AC F03-3, F04-2).
  /// Perpanjangan memakai `renewal_eligible`, `renewal_opens_at` dan `renewal_payment` dengan aturan yang sama
  /// (AC F07-5). Nilai `version` dipakai sebagai If-Match pada PATCH /me/profile.
  ///
  /// `GET /me` (operationId `getMe`).
  Future<Me> getMe({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMe',
        method: 'GET',
        path: '/me',
        authRequired: true,
        decode: (Object? v0) => Me.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah profil umum, profesi/keahlian, avatar dan privasi sendiri (F-10, PRD 4.6, AC F10-2, F10-4).
  ///
  /// Hanya field yang dikirim yang diubah (PATCH); null pada field nullable berarti mengosongkan. Hanya untuk
  /// effective_status nonsuspended (unverified, verified, expiring, expired); suspended mendapat 403
  /// ACCOUNT_SUSPENDED.
  ///
  /// Field identitas keanggotaan TIDAK dapat diubah lewat endpoint ini (PRD 3.5, 6.4, AC F05-6): nama lengkap,
  /// jenis kelamin, angkatan, kelas masuk/keluar, email dan nomor anggota. Nomor dialokasikan saat OTP
  /// terverifikasi sehingga setelah itu koreksi hanya oleh pengurus berizin members.manage
  /// (PATCH /admin/members/{userId}); email lewat alur koreksi email terverifikasi (F-01). Body yang memuat
  /// field di luar skema (mis. member_number, cohort) ditolak 400 VALIDATION_ERROR dan tidak ada field yang
  /// berubah.
  ///
  /// Aturan server:
  /// - `professions`, `education` dan `social_links` masing-masing MENGGANTIKAN seluruh daftar ([] mengosongkan);
  ///   aturan per daftar ada di ProfileUpdate. Profesi yang cocok dengan label master aktif (tanpa membedakan
  ///   huruf besar/kecil) ditautkan ke master itu; label lain disimpan sebagai ketikan sendiri.
  /// - skill_ids hanya boleh menunjuk master aktif, kecuali master nonaktif yang SUDAH terpasang pada profil ini
  ///   (label historis tetap, AC F10-4); selain itu 400 VALIDATION_ERROR pada field tersebut. skill_ids
  ///   menggantikan seluruh himpunan keahlian (maksimal 10, tanpa duplikat).
  /// - avatar_file_id wajib berkas milik pemanggil dengan purpose `avatar` dan status ready; selain itu 422
  ///   FILE_INVALID (tanpa membedakan berkas milik orang lain dari berkas yang tidak ada, N-09).
  /// - Privasi: kontak dan tautan sosial bawaan tersembunyi (show_phone/show_email/show_social false, N-15);
  ///   field tersembunyi tidak ikut payload direktori/profil anggota lain (AC F10-2).
  /// - Setiap tautan sosial memakai aturan SocialHandle: nama pengguna atau URL https; skema lain (javascript:,
  ///   data:, http:, dll.) ditolak 400 VALIDATION_ERROR pada field tersebut (N-09, N-14).
  /// - Perubahan avatar/kota/profesi tercermin pada GET /me/card berikutnya.
  ///
  /// Masa transisi aplikasi 1.0.0 (field lama, deprecated): `profession_id`, `last_education_institution`,
  /// `last_education_city` dan `social_instagram`/`social_x`/`social_facebook`/`social_linkedin` tetap diterima.
  /// Masing-masing hanya mengubah satu entri daftar barunya: profession_id melepas profesi pertama yang tertaut
  /// master lalu menaruh master baru (wajib aktif) sebagai profesi utama, atau null melepasnya saja; 400 pada
  /// profession_id bila daftar profesi sudah penuh (5); last_education_institution mengganti institusi entri
  /// pendidikan teratas atau membuat entri baru (null menghapus entri teratas); social_‹platform› mengganti tautan
  /// pertama platform itu atau menambahkannya di akhir (null menghapusnya; 400 pada field itu bila tautan baru
  /// tidak muat karena daftar sudah penuh, 10). last_education_city hanya disimpan
  /// untuk dibaca kembali oleh aplikasi lama dan dikosongkan server bila institusi teratas berganti. Field lama
  /// bersama penggantinya dalam satu body (mis. profession_id dengan professions, social_x dengan social_links)
  /// ditolak 400 VALIDATION_ERROR pada field lama.
  /// Versi berbeda dari If-Match menghasilkan 409 VERSION_CONFLICT dengan `current` berbentuk Me (AC F15-4).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /me/profile` (operationId `updateMyProfile`).
  Future<Me> updateMyProfile(
    ProfileUpdate body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'updateMyProfile',
        method: 'PATCH',
        path: '/me/profile',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => Me.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Data KTA digital, status kartu, ajakan bayar/perpanjang dan token QR bertanda tangan (F-05, AC F05-1..F05-5).
  ///
  /// Kartu dibuat saat OTP pendaftaran terverifikasi dengan status Tidak Aktif dan menjadi Aktif setelah
  /// registration paid (AC F05-1). Isi mengikuti guideline hal. 6 dan prototipe layar 6/7: foto, nama,
  /// angkatan + profesi, kode angkatan "KAPDH n", tahun lulus, kota saja (bukan alamat lengkap), nomor anggota,
  /// QR, masa berlaku, label status dengan tombol Bayar/Perpanjang, dan waktu sinkronisasi.
  ///
  /// Token QR hanya diterbitkan bila status kartu `active` atau `expiring` (verified/expiring, tidak suspended);
  /// token JWT bertanda tangan server berumur maksimal 7 hari dan tidak melewati expires_at (PRD 3.5,
  /// ARCHITECTURE §3.2). Setiap pemanggilan menerbitkan token baru; token lama tetap tunduk expiry dan status
  /// server terbaru (AC F05-5). Koreksi nomor oleh admin membuat QR lama "perlu diperbarui" (AC F05-6).
  ///
  /// Cache offline (AC F05-2..F05-4): klien menyimpan respons ini bersama id pengguna dan menampilkannya
  /// berlabel Offline hanya sampai `offline_valid_until`; null berarti kartu tidak boleh tampil aktif secara
  /// offline. Cache dihapus saat logout/ganti akun. Anggota suspended mendapat label `suspended` tanpa QR
  /// sehingga cache aktif langsung diganti saat kembali online (AC F05-4).
  ///
  /// `GET /me/card` (operationId `getMyCard`).
  Future<MemberCard> getMyCard({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMyCard',
        method: 'GET',
        path: '/me/card',
        authRequired: true,
        decode: (Object? v0) => MemberCard.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Periode keanggotaan, jendela dan kelayakan perpanjangan, serta histori periode sendiri (F-07, AC F07-1..F07-5).
  ///
  /// Status dihitung dari timestamp saat request, bukan dari jadwal worker (AC F07-3). Jendela renewal dibuka
  /// 30 hari sebelum expires_at dan tetap terbuka setelah expired, tanpa masa tenggang (AC F07-5, D4). Renewal
  /// menambah 12 bulan kalender Asia/Jakarta dari max(expires_at lama, approved_at) (AC F07-1, F07-2). Suspend
  /// tidak membuang tanggal periode (PRD 4.2) tetapi menutup kelayakan pembayaran baru (PRD 2.2). Dapat dibaca
  /// semua effective_status yang memiliki sesi, termasuk expired dan suspended (riwayat sendiri).
  ///
  /// `GET /me/membership` (operationId `getMyMembership`).
  Future<Membership> getMyMembership({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMyMembership',
        method: 'GET',
        path: '/me/membership',
        authRequired: true,
        decode: (Object? v0) => Membership.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Master profesi atau keahlian yang AKTIF untuk pemilihan profil dan filter direktori (F-10, AC F10-4).
  ///
  /// Hanya master aktif, urut sort_order lalu label. Master nonaktif tidak dapat dipilih baru, tetapi tetap
  /// tampil sebagai label historis pada profil yang sudah memakainya (AC F10-4). Daftar kecil sehingga tidak
  /// dipaging. Pengelolaan oleh pengurus ada di /admin/masters/{kind} (master.manage).
  ///
  /// [kind]: Jenis master terkontrol (professions atau skills).
  ///
  /// `GET /masters/{kind}` (operationId `listMasters`).
  Future<MasterItemList> listMasters(
    MasterKind kind, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listMasters',
        method: 'GET',
        path: '/masters/${Uri.encodeComponent(kind.toJson())}',
        authRequired: true,
        decode: (Object? v0) => MasterItemList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
