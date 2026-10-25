// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pengelolaan berita terjadwal, banner, halaman informasi/legal berversi, kategori berita dan gambar konten
/// oleh pengurus berizin content.manage, serta kategori event oleh pengurus berizin events.manage (F-08, F-15,
/// AC F08-1, F08-2, F15-1, F15-4, F15-5; guideline p13, p14).
///
///
/// Kelas API untuk tag kontrak "Admin Content". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminContentApi {
  const AdminContentApi(this._dio);

  final Dio _dio;

  /// Tabel berita (Feed Informasi) dengan pencarian, filter, urutan dan paging server (F-15, guideline p13).
  ///
  /// Kolom guideline p13: judul konten, gambar, kategori, tanggal publikasi, aksi kelola. `total` = jumlah item
  /// yang cocok dengan filter. `state` turunan server: `scheduled` = published dengan `published_at > now`.
  ///
  /// [q]: Cari judul atau slug (tidak peka huruf besar/kecil).
  /// [state]: Filter keadaan berita; kosong = semua.
  /// [sort]: Urutan; bawaan `updated_at_desc`. Selalu ditambah `id` sebagai pemutus seri (keyset).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/content/posts` (operationId `adminListPosts`).
  Future<AdminPostPage> adminListPosts({
    String? q,
    AdminPostState? state,
    String? categoryId,
    AdminPostSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPosts',
        method: 'GET',
        path: '/admin/content/posts',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          if (state case final v?) 'state': v.toJson(),
          'category_id': ?categoryId,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminPostPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat berita baru sebagai draft (guideline p13 "Tambah Konten Baru", F-08).
  ///
  /// Berita selalu dibuat `draft`; penerbitan (sekarang atau terjadwal) memakai POST .../publish. `body_html`
  /// disanitasi server sebelum disimpan (PRD 3.8). `slug` kosong dibangkitkan dari judul dan dibuat unik.
  ///
  /// Validasi: `category_id` harus kategori `post` yang aktif; `cover_file_id` harus berkas purpose `post_cover`
  /// dari POST /admin/content/media yang belum dihapus. Slug sudah dipakai -> 409 VALIDATION_ERROR
  /// (`field_errors.slug`). Idempotency-Key mencegah draf ganda saat tombol simpan terkirim dua kali.
  ///
  /// Rincian implementasi (aditif): cover baru wajib diunggah pengurus pemanggil dan belum dipakai objek lain
  /// (satu berkas = satu objek; selain itu 400 `field_errors.cover_file_id`). Gambar di dalam `body_html` wajib
  /// gambar konten KAPDH yang ada (selain itu 400 `field_errors.body_html`) dan dilampirkan agar tidak
  /// dibersihkan job berkas.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/posts` (operationId `adminCreatePost`).
  Future<AdminPost> adminCreatePost(
    AdminPostCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreatePost',
        method: 'POST',
        path: '/admin/content/posts',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail berita untuk formulir edit, termasuk draf body dan versi (F-15).
  ///
  /// `GET /admin/content/posts/{postId}` (operationId `adminGetPost`).
  Future<AdminPost> adminGetPost(
    String postId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPost',
        method: 'GET',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}',
        authRequired: true,
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus berita draft atau archived setelah konfirmasi (guideline p13 "Hapus Konten", PRD 4.5).
  ///
  /// Hanya `draft` atau `archived`; berita yang tampil atau terjadwal diarsipkan dahulu (409 VERSION_CONFLICT
  /// dengan `current`). Like ikut terhapus; banner yang menunjuk berita ini menjadi `available = false` (AC F08-2).
  /// Cover yang tidak lagi dirujuk berita/banner/halaman lain dibuang (berkas `deleted`, objek dihapus setelah
  /// commit). Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/content/posts/{postId}` (operationId `adminDeletePost`).
  Future<void> adminDeletePost(
    String postId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeletePost',
        method: 'DELETE',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah isi berita pada keadaan apa pun (guideline p13 "Edit Konten", AC F15-4).
  ///
  /// Hanya field yang dikirim yang berubah; `version` naik. Perubahan pada berita yang sedang tampil langsung
  /// terlihat anggota. `slug` hanya dapat diubah selama `slug_locked = false` (berita belum pernah tampil ke
  /// anggota, lihat `AdminPost.slug_locked`) agar tautan dan notifikasi lama tidak rusak; selain itu 400
  /// VALIDATION_ERROR (`field_errors.slug`). Status dan `published_at` tidak diubah di sini (pakai
  /// publish/unschedule/archive/restore).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/content/posts/{postId}` (operationId `adminUpdatePost`).
  Future<AdminPost> adminUpdatePost(
    String postId,
    AdminPostUpdateRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdatePost',
        method: 'PATCH',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Terbitkan sekarang atau jadwalkan dengan published_at (AC F08-1, F15-5).
  ///
  /// Invarian waktu terbit (berlaku untuk semua transisi berita, sesuai CHECK `posts_published_chk` dan
  /// `posts_announced_chk`): sekali berita pernah tampil ke anggota (status published dengan
  /// `published_at <= now`), `published_at` menyimpan waktu tayang pertama dan tidak pernah dikosongkan atau
  /// dipindah ke masa depan lagi. Karena itu berita terjadwal selalu belum pernah tampil dan `announced_at`-nya
  /// null, dan `slug_locked` dapat diturunkan dari `published_at` saja.
  ///
  /// Aturan per keadaan:
  /// - `draft` yang belum pernah tampil (`published_at` null): `published_at` kosong/null = terbit sekarang
  ///   (waktu server); masa depan = terjadwal (`state = scheduled`, tidak tampil di feed sampai waktunya,
  ///   AC F08-1).
  /// - `draft` hasil restore yang pernah tampil (`published_at` terisi): hanya terbit sekarang; berita kembali
  ///   tampil dengan `published_at` (Tgl Publikasi) aslinya. `published_at` masa depan -> 409 VALIDATION_ERROR
  ///   (`field_errors.published_at`), karena berita yang pernah tampil tidak dapat dijadwalkan ulang.
  /// - `scheduled`: menjadwalkan ulang (masa depan) atau terbit sekarang (null).
  /// - `published` yang sudah tampil atau `archived` -> 409 VERSION_CONFLICT dengan `current` (archived
  ///   dipulihkan dahulu lewat restore).
  /// Waktu lampau selalu ditolak 400 VALIDATION_ERROR; klien mengirim null untuk "terbit sekarang".
  ///
  /// Pengumuman (AC F15-5): job `content.announce` (setiap menit) mengklaim berita dengan
  /// `UPDATE posts SET announced_at = now WHERE status = 'published' AND published_at <= now AND announced_at
  /// IS NULL ... RETURNING` lalu, dalam transaksi yang sama, membuat notifikasi inbox kategori `news` (rute
  /// `/news/{slug}`) dengan `dedup_key = news:<post_id>:<user_id>` (ON CONFLICT DO NOTHING) sehingga setiap
  /// berita diumumkan tepat sekali. Penerima: pengguna alumni berstatus akun `active` yang effective_status-nya
  /// verified atau expiring pada saat pengumuman (anggota yang dapat membuka berita, PRD 2.2); unverified,
  /// expired, suspended, pending_otp, disabled dan deletion_pending tidak menerima. Push dikirim hanya bila
  /// preferensi push `news` aktif (baris notification_preferences yang tidak ada = aktif); berita tidak
  /// memiliki kanal email (ARCHITECTURE §4.7). Berita yang sudah diumumkan tidak diumumkan lagi walaupun
  /// diterbitkan ulang; berita yang diarsipkan atau dibatalkan jadwalnya sebelum waktunya tidak pernah
  /// diumumkan atau dihidupkan kembali oleh job lama. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/posts/{postId}/publish` (operationId `adminPublishPost`).
  Future<AdminPost> adminPublishPost(
    String postId,
    AdminPostPublishRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminPublishPost',
        method: 'POST',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}/publish',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan jadwal terbit; berita terjadwal kembali menjadi draft (AC F15-5).
  ///
  /// Hanya untuk `state = scheduled` (published dengan `published_at > now`). Berita terjadwal belum pernah
  /// tampil dan `announced_at`-nya selalu null (invarian pada publish), sehingga `published_at` dikosongkan
  /// tanpa melanggar `posts_announced_chk` dan job pengumuman tidak pernah menerbitkannya. Pembaruan bersyarat
  /// `WHERE version = :v AND status = 'published' AND published_at > now AND announced_at IS NULL`; bila
  /// waktunya sudah lewat (berita sudah tampil) atau keadaan lain -> 409 VERSION_CONFLICT dengan `current`;
  /// gunakan archive untuk menurunkan berita yang tampil.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/posts/{postId}/unschedule` (operationId `adminUnschedulePost`).
  Future<AdminPost> adminUnschedulePost(
    String postId, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUnschedulePost',
        method: 'POST',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}/unschedule',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Arsipkan berita; hilang dari feed dan tidak pernah dihidupkan kembali oleh job (AC F08-1, F15-5).
  ///
  /// Dari `draft`, `scheduled`, atau `published` -> `archived`. Berita archived tidak tampil di feed/detail
  /// anggota (404) dan job terjadwal lama tidak dapat menerbitkan atau mengumumkannya karena job hanya
  /// memproses `status = 'published'` (AC F15-5). Banner yang menunjuknya menjadi `available = false`.
  ///
  /// Waktu terbit mengikuti invarian pada publish: berita `scheduled` (belum pernah tampil) diarsipkan dengan
  /// `published_at` dikosongkan, sehingga jadwal yang lewat kemudian tidak pernah terbaca sebagai "pernah
  /// tampil"; berita yang pernah tampil menyimpan `published_at` dan `announced_at`. Satu pernyataan bersyarat:
  /// `SET status = 'archived', published_at = CASE WHEN published_at > now THEN NULL ELSE published_at END`.
  /// Sudah archived -> 409 VERSION_CONFLICT. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/posts/{postId}/archive` (operationId `adminArchivePost`).
  Future<AdminPost> adminArchivePost(
    String postId, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminArchivePost',
        method: 'POST',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}/archive',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Pulihkan berita archived menjadi draft; terbit lagi hanya lewat publish eksplisit (AC F15-5).
  ///
  /// Hanya dari `archived` -> `draft`; tidak pernah langsung tampil. `published_at` dan `announced_at` tidak
  /// berubah: berita yang pernah tampil tetap `slug_locked` dan hanya dapat diterbitkan ulang sekarang dengan
  /// Tgl Publikasi aslinya; berita yang pernah diumumkan tidak diumumkan lagi. Penerbitan ulang memerlukan
  /// POST .../publish oleh pengurus. Keadaan lain -> 409 VERSION_CONFLICT dengan `current`.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/posts/{postId}/restore` (operationId `adminRestorePost`).
  Future<AdminPost> adminRestorePost(
    String postId, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminRestorePost',
        method: 'POST',
        path: '/admin/content/posts/${Uri.encodeComponent(postId)}/restore',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (Object? v0) => AdminPost.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tabel banner beranda dengan status jendela tayang (guideline p13 tab Banner, F-08).
  ///
  /// Kolom guideline p13 tab Banner: judul, gambar, kategori, tanggal publikasi (`starts_at`), aksi kelola.
  /// `state` turunan server dari `active` dan jendela tanggal; target diselesaikan agar pengurus melihat banner
  /// yang tujuannya sudah tidak tersedia (AC F08-2).
  ///
  /// Kolom "Kategori": tabel banners R1.0 tidak memiliki kategori sendiri (PRD 6.2: media, target, urutan,
  /// mulai/selesai). Kolom diisi `target.category`, yaitu kategori berita/event tujuan banner; null (ditampilkan
  /// "-") untuk target `none`, `page`, `url`, atau tujuan tanpa kategori. Kategori milik banner sendiri
  /// memerlukan kolom DB baru dan keputusan produk.
  ///
  /// [q]: Cari judul banner.
  /// [state]: Filter keadaan tayang; kosong = semua.
  /// [sort]: Urutan; bawaan `sort_order_asc`. Selalu ditambah `id` sebagai pemutus seri (keyset).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/content/banners` (operationId `adminListBanners`).
  Future<AdminBannerPage> adminListBanners({
    String? q,
    AdminBannerState? state,
    AdminBannerSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListBanners',
        method: 'GET',
        path: '/admin/content/banners',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          if (state case final v?) 'state': v.toJson(),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminBannerPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat banner dengan gambar, target tervalidasi, jendela tayang dan urutan (F-08, AC F08-2).
  ///
  /// Validasi target (tabel banners): `none` tanpa nilai; `post` = id berita; `event` = id event; `page` = slug
  /// halaman; `url` = tautan https (http/javascript: ditolak). Tujuan internal harus ada saat disimpan; bila
  /// kemudian tidak tersedia, Beranda menandainya `available = false`. `image_file_id` harus berkas purpose
  /// `banner_image` dari POST /admin/content/media. `ends_at` harus setelah `starts_at`. Pelanggaran -> 400
  /// VALIDATION_ERROR dengan `field_errors` (mis. `target_value`).
  ///
  /// Rincian implementasi (aditif): gambar wajib diunggah pengurus pemanggil dan belum dipakai objek lain; URL
  /// target tidak boleh memuat nama pengguna/sandi; id berita/event disimpan dalam huruf kecil.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/banners` (operationId `adminCreateBanner`).
  Future<AdminBanner> adminCreateBanner(
    AdminBannerCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreateBanner',
        method: 'POST',
        path: '/admin/content/banners',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminBanner.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail banner untuk formulir edit (F-08).
  ///
  /// `GET /admin/content/banners/{bannerId}` (operationId `adminGetBanner`).
  Future<AdminBanner> adminGetBanner(
    String bannerId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetBanner',
        method: 'GET',
        path: '/admin/content/banners/${Uri.encodeComponent(bannerId)}',
        authRequired: true,
        decode: (Object? v0) => AdminBanner.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus banner setelah konfirmasi (guideline p13 "Hapus Konten", PRD 4.5).
  ///
  /// Banner dapat dihapus pada keadaan apa pun; untuk menyembunyikan sementara gunakan `active = false`.
  /// Gambar yang tidak lagi dipakai dibersihkan job berkas.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/content/banners/{bannerId}` (operationId `adminDeleteBanner`).
  Future<void> adminDeleteBanner(
    String bannerId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeleteBanner',
        method: 'DELETE',
        path: '/admin/content/banners/${Uri.encodeComponent(bannerId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah banner, termasuk urutan, jendela, aktif dan target (AC F08-2, F15-4).
  ///
  /// Hanya field yang dikirim yang berubah; `version` naik. `target_type` dan `target_value` wajib dikirim
  /// bersama dan divalidasi seperti saat membuat. Mengganti gambar melepas gambar lama; gambar yang tidak lagi
  /// dirujuk konten lain dibuang (berkas `deleted`, objek dihapus setelah commit).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/content/banners/{bannerId}` (operationId `adminUpdateBanner`).
  Future<AdminBanner> adminUpdateBanner(
    String bannerId,
    AdminBannerUpdateRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateBanner',
        method: 'PATCH',
        path: '/admin/content/banners/${Uri.encodeComponent(bannerId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminBanner.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar halaman informasi dan legal beserta versi tayang dan draf (F-08, PRD 6.2).
  ///
  /// Urutan bawaan `system_first`: halaman baku lebih dahulu (kebijakan-privasi, ketentuan, ketentuan-komunitas,
  /// bantuan, tentang), lalu halaman lain menurut judul. `has_unpublished_changes` menandai draf yang berbeda
  /// dari salinan tayang.
  ///
  /// [q]: Cari judul atau slug.
  /// [sort]: Urutan; bawaan `system_first`. Selalu ditambah `id` sebagai pemutus seri (keyset).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/content/pages` (operationId `adminListPages`).
  Future<AdminInfoPageList> adminListPages({
    String? q,
    AdminInfoPageSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPages',
        method: 'GET',
        path: '/admin/content/pages',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminInfoPageList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat halaman informasi baru sebagai draf; belum terlihat publik sampai diterbitkan (F-08).
  ///
  /// Halaman baru selalu draf (belum ada salinan tayang). `body_html` disanitasi server. Slug sudah dipakai ->
  /// 409 VALIDATION_ERROR (`field_errors.slug`). Halaman legal baku dibuat oleh seed referensi (PRD 8.2 langkah
  /// 4), bukan lewat endpoint ini.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/pages` (operationId `adminCreatePage`).
  Future<AdminInfoPage> adminCreatePage(
    AdminInfoPageCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreatePage',
        method: 'POST',
        path: '/admin/content/pages',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminInfoPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail halaman; draf kerja dan salinan tayang terpisah (F-08, PRD 6.2).
  ///
  /// `GET /admin/content/pages/{pageId}` (operationId `adminGetPage`).
  Future<AdminInfoPage> adminGetPage(
    String pageId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPage',
        method: 'GET',
        path: '/admin/content/pages/${Uri.encodeComponent(pageId)}',
        authRequired: true,
        decode: (Object? v0) => AdminInfoPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus halaman informasi non-baku setelah konfirmasi (PRD 4.5).
  ///
  /// Halaman baku (`system = true`: kebijakan-privasi, ketentuan, ketentuan-komunitas, bantuan, tentang) tidak
  /// dapat dihapus karena wajib tersedia (PRD 8.2) dan versinya menjadi acuan persetujuan (F-01) -> 409
  /// VALIDATION_ERROR. Banner yang menunjuk halaman ini menjadi `available = false` (AC F08-2). Versi tayang
  /// yang pernah terbit tetap tercatat di audit. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/content/pages/{pageId}` (operationId `adminDeletePage`).
  Future<void> adminDeletePage(
    String pageId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeletePage',
        method: 'DELETE',
        path: '/admin/content/pages/${Uri.encodeComponent(pageId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Simpan draf halaman; teks yang tayang dan versi legal tidak berubah (AC F15-4, PRD 6.2).
  ///
  /// Mengubah draf (`title`, `body_html`) dan menaikkan `version`; salinan tayang dan `published.version` tetap
  /// sampai POST .../publish. `slug` hanya dapat diubah untuk halaman non-baku yang belum pernah terbit
  /// (`slug_locked = false`); selain itu 400 VALIDATION_ERROR.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/content/pages/{pageId}` (operationId `adminUpdatePage`).
  Future<AdminInfoPage> adminUpdatePage(
    String pageId,
    AdminInfoPageUpdateRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdatePage',
        method: 'PATCH',
        path: '/admin/content/pages/${Uri.encodeComponent(pageId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminInfoPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Terbitkan draf sebagai versi tayang baru; versi legal naik satu (F-01, F-08, PRD 6.2).
  ///
  /// Dalam satu transaksi: draf disalin ke salinan tayang, `published.version` naik satu (mulai 1),
  /// `published.published_at` = waktu server, `version` naik, dan untuk dokumen legal (`legal_document`)
  /// `app_settings.legal.<privacy|terms|community>_version` diperbarui ke versi baru. Audit `page.published`
  /// menyimpan versi beserta teks yang diterbitkan sehingga versi yang pernah disetujui pengguna dapat
  /// direproduksi (F-01, F-17). Menerbitkan `privacy` atau `terms` mengubah `LegalConsentVersions.policy_version`
  /// gabungan (`privacy:<v>;terms:<v>`, GET /public/pages) sehingga registrasi berikutnya menyetujui pasangan
  /// versi yang baru; persetujuan lama di `users.policy_version` tidak diubah.
  ///
  /// Draf identik dengan salinan tayang -> 409 VALIDATION_ERROR (tidak ada perubahan; versi legal tidak dinaikkan
  /// tanpa perubahan). Versi lama -> 409 VERSION_CONFLICT dengan `current`.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/pages/{pageId}/publish` (operationId `adminPublishPage`).
  Future<AdminInfoPage> adminPublishPage(
    String pageId,
    AdminInfoPagePublishRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminPublishPage',
        method: 'POST',
        path: '/admin/content/pages/${Uri.encodeComponent(pageId)}/publish',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminInfoPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tabel kategori berita beserta jumlah pemakaian (guideline p13 "Manajemen Kategori", F-15).
  ///
  /// Hanya kategori `kind = post`, termasuk yang nonaktif. `usage_count` = jumlah berita (semua keadaan) yang
  /// memakai kategori; kategori yang dipakai tidak dapat dihapus (nonaktifkan saja). Kategori event dikelola
  /// lewat /admin/content/event-categories dengan izin events.manage.
  ///
  /// [active]: Filter aktif/nonaktif; kosong = semua.
  /// [q]: Cari label atau slug.
  /// [sort]: Urutan; bawaan `sort_order_asc`. Selalu ditambah `id` sebagai pemutus seri (keyset).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/content/post-categories` (operationId `adminListPostCategories`).
  Future<AdminContentCategoryPage> adminListPostCategories({
    bool? active,
    String? q,
    AdminContentCategorySort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPostCategories',
        method: 'GET',
        path: '/admin/content/post-categories',
        authRequired: true,
        queryParameters: <String, Object?>{
          'active': ?active,
          'q': ?q,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminContentCategoryPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat kategori berita (guideline p13 "Manajemen Kategori").
  ///
  /// Kategori dibuat dengan `kind = post`. `slug` kosong dibangkitkan dari label. Slug unik per jenis
  /// (`categories_kind_slug_key`); sudah dipakai -> 409 VALIDATION_ERROR (`field_errors.slug`). Tercatat di
  /// audit.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/post-categories` (operationId `adminCreatePostCategory`).
  Future<AdminContentCategory> adminCreatePostCategory(
    AdminContentCategoryCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreatePostCategory',
        method: 'POST',
        path: '/admin/content/post-categories',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminContentCategory.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail kategori berita beserta jumlah pemakaian.
  ///
  /// Id kategori berjenis event pada path ini -> 404 NOT_FOUND.
  ///
  /// `GET /admin/content/post-categories/{categoryId}` (operationId `adminGetPostCategory`).
  Future<AdminContentCategory> adminGetPostCategory(
    String categoryId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPostCategory',
        method: 'GET',
        path: '/admin/content/post-categories/${Uri.encodeComponent(categoryId)}',
        authRequired: true,
        decode: (Object? v0) => AdminContentCategory.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus kategori berita yang belum dipakai setelah konfirmasi (PRD 4.5).
  ///
  /// Kategori yang dipakai berita (FK RESTRICT `posts.category_id`) -> 409 VALIDATION_ERROR dengan saran
  /// menonaktifkan; pemeriksaan ditegakkan constraint database (SQLSTATE 23503/23001), bukan hitungan
  /// baca-lalu-hapus. Id kategori event -> 404 NOT_FOUND. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/content/post-categories/{categoryId}` (operationId `adminDeletePostCategory`).
  Future<void> adminDeletePostCategory(
    String categoryId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeletePostCategory',
        method: 'DELETE',
        path: '/admin/content/post-categories/${Uri.encodeComponent(categoryId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah label, slug, urutan atau status aktif kategori berita (AC F15-4).
  ///
  /// Jenis tidak dapat diubah. `active = false` menyembunyikan kategori dari pilihan baru dan tab anggota, tetapi
  /// label historis tetap tampil pada berita yang memakainya. Slug sudah dipakai -> 409 VALIDATION_ERROR. Id
  /// kategori event -> 404 NOT_FOUND. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/content/post-categories/{categoryId}` (operationId `adminUpdatePostCategory`).
  Future<AdminContentCategory> adminUpdatePostCategory(
    String categoryId,
    AdminContentCategoryUpdateRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdatePostCategory',
        method: 'PATCH',
        path: '/admin/content/post-categories/${Uri.encodeComponent(categoryId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminContentCategory.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tabel pengelolaan kategori event beserta jumlah pemakaian (guideline p14 "Manajemen Kategori").
  ///
  /// Hanya kategori `kind = event`, termasuk yang nonaktif, dengan paging, urutan dan `usage_count` (jumlah
  /// event semua status yang memakai kategori). Izin events.manage, sehingga pengurus event mengelola
  /// kategorinya sendiri tanpa izin konten (PRD 2.3, AC F15-1). Daftar ringkas untuk pilihan formulir event
  /// disediakan domain events (GET /admin/event-categories).
  ///
  /// [active]: Filter aktif/nonaktif; kosong = semua.
  /// [q]: Cari label atau slug.
  /// [sort]: Urutan; bawaan `sort_order_asc`. Selalu ditambah `id` sebagai pemutus seri (keyset).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/content/event-categories` (operationId `adminListManagedEventCategories`).
  Future<AdminContentCategoryPage> adminListManagedEventCategories({
    bool? active,
    String? q,
    AdminContentCategorySort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListManagedEventCategories',
        method: 'GET',
        path: '/admin/content/event-categories',
        authRequired: true,
        queryParameters: <String, Object?>{
          'active': ?active,
          'q': ?q,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminContentCategoryPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat kategori event (guideline p14 "Manajemen Kategori", izin events.manage).
  ///
  /// Kategori dibuat dengan `kind = event`. `slug` kosong dibangkitkan dari label. Slug unik per jenis; sudah
  /// dipakai -> 409 VALIDATION_ERROR (`field_errors.slug`). Tercatat di audit.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/content/event-categories` (operationId `adminCreateEventCategory`).
  Future<AdminContentCategory> adminCreateEventCategory(
    AdminContentCategoryCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreateEventCategory',
        method: 'POST',
        path: '/admin/content/event-categories',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminContentCategory.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail kategori event beserta jumlah pemakaian (izin events.manage).
  ///
  /// Id kategori berjenis post pada path ini -> 404 NOT_FOUND.
  ///
  /// `GET /admin/content/event-categories/{categoryId}` (operationId `adminGetEventCategory`).
  Future<AdminContentCategory> adminGetEventCategory(
    String categoryId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetEventCategory',
        method: 'GET',
        path: '/admin/content/event-categories/${Uri.encodeComponent(categoryId)}',
        authRequired: true,
        decode: (Object? v0) => AdminContentCategory.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus kategori event yang belum dipakai setelah konfirmasi (PRD 4.5, izin events.manage).
  ///
  /// Kategori yang dipakai event (FK RESTRICT `events.category_id`) -> 409 VALIDATION_ERROR dengan saran
  /// menonaktifkan; pemeriksaan ditegakkan constraint database (SQLSTATE 23503/23001). Id kategori berita ->
  /// 404 NOT_FOUND. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/content/event-categories/{categoryId}` (operationId `adminDeleteEventCategory`).
  Future<void> adminDeleteEventCategory(
    String categoryId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeleteEventCategory',
        method: 'DELETE',
        path: '/admin/content/event-categories/${Uri.encodeComponent(categoryId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah label, slug, urutan atau status aktif kategori event (AC F15-4, izin events.manage).
  ///
  /// Jenis tidak dapat diubah. `active = false` menyembunyikan kategori dari pilihan event baru dan tab anggota,
  /// tetapi label historis tetap tampil pada event yang memakainya. Slug sudah dipakai -> 409 VALIDATION_ERROR.
  /// Id kategori berita -> 404 NOT_FOUND. Tercatat di audit.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/content/event-categories/{categoryId}` (operationId `adminUpdateEventCategory`).
  Future<AdminContentCategory> adminUpdateEventCategory(
    String categoryId,
    AdminContentCategoryUpdateRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateEventCategory',
        method: 'PATCH',
        path: '/admin/content/event-categories/${Uri.encodeComponent(categoryId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminContentCategory.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Unggah gambar cover berita atau banner (N-10, PRD 2.5).
  ///
  /// JPG/PNG <= 5 MB; magic bytes diperiksa, dimensi/decompression berlebihan ditolak, EXIF dibuang dan gambar
  /// di-encode ulang (N-10). Berkas berpurpose `post_cover`/`banner_image` bervisibilitas publik karena tampil di
  /// aplikasi; tidak boleh berisi data pribadi. Berkas yang tidak dilampirkan ke berita/banner dalam 24 jam
  /// dihapus job `files.cleanup-temp` (PRD 2.5). Batas 10 unggahan berhasil per purpose per admin per 24 jam
  /// bergulir (N-10) -> 429 RATE_LIMITED.
  ///
  /// `POST /admin/content/media` (operationId `adminUploadContentMedia`).
  Future<ContentMedia> adminUploadContentMedia(
    AdminContentMediaUploadRequest body, {
    CancelToken? cancelToken,
    Options? options,
    ProgressCallback? onSendProgress,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUploadContentMedia',
        method: 'POST',
        path: '/admin/content/media',
        authRequired: true,
        data: body.toFormData(),
        decode: (Object? v0) => ContentMedia.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
        onSendProgress: onSendProgress,
      );
}
