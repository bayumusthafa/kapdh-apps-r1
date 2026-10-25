// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Beranda, berita (feed dan detail), like, kategori, serta halaman informasi dan legal yang dapat dibaca sebelum
/// aktivasi (F-08, PRD 3.8, AC F08-1..F08-4).
///
///
/// Kelas API untuk tag kontrak "Content". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class ContentApi {
  const ContentApi(this._dio);

  final Dio _dio;

  /// Beranda anggota aktif; banner aktif, event mendatang, berita terbaru dan akses cepat (F-08, AC F08-2).
  ///
  /// Satu panggilan untuk layar Beranda (PRD 3.8: banner aktif, kegiatan mendatang, feed berita published, dan
  /// akses cepat KTA/notifikasi).
  ///
  /// - `banners`: hanya `active = true` dan di dalam jendela tanggal (`starts_at <= now < ends_at`, `ends_at`
  ///   null = tanpa batas akhir); banner di luar jendela tidak dikirim (AC F08-2). Urutan `sort_order` naik lalu
  ///   `starts_at` turun; maksimal 10. Target diselesaikan server saat dibaca: `target.available = false` bila
  ///   berita/event/halaman tujuan sudah tidak tersedia, dan klien menampilkan pesan yang jelas alih-alih
  ///   membuka layar kosong (AC F08-2).
  /// - `upcoming_events`: event berstatus `open` atau `closed` yang belum berakhir (`ends_at > now`), tanpa draft,
  ///   done atau cancelled; urut `starts_at` naik; maksimal 5.
  /// - `posts`: berita `published` dengan `published_at <= now` (draft, terjadwal masa depan, dan archived tidak
  ///   pernah tampil, AC F08-1); urut `published_at` turun; maksimal 5. Feed lengkap memakai GET /posts.
  /// - `quick_access`: jumlah notifikasi belum dibaca dan ringkasan KTA untuk pintasan.
  /// - `generated_at`: waktu server saat respons dibuat; klien menyimpannya bersama cache Beranda dan
  ///   menampilkan "Diperbarui ..." ketika menampilkan cache lama saat offline (AC F08-4).
  ///
  /// Akses: anggota aktif (verified/expiring). unverified/expired mendapat 403 MEMBERSHIP_REQUIRED (klien memuat
  /// ulang /me dan mengarahkan sesuai status), suspended 403 ACCOUNT_SUSPENDED.
  ///
  /// `GET /home` (operationId `getHome`).
  Future<Home> getHome({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getHome',
        method: 'GET',
        path: '/home',
        authRequired: true,
        decode: (Object? v0) => Home.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Feed berita yang sudah terbit dan sudah waktunya tampil (AC F08-1).
  ///
  /// Hanya berita `published` dengan `published_at <= now` (waktu server); draft, terjadwal masa depan, dan
  /// archived tidak pernah dikirim (AC F08-1). Urutan tetap `published_at` turun lalu `id` turun (keyset), sehingga
  /// paging tidak menduplikasi item. Filter `category` memakai slug kategori berjenis `post`; slug yang tidak
  /// dikenal menghasilkan daftar kosong, bukan 404. Daftar kosong ditampilkan klien sebagai keadaan kosong yang
  /// membantu (AC F08-4).
  ///
  /// Akses: anggota aktif (verified/expiring); lainnya 403 MEMBERSHIP_REQUIRED / ACCOUNT_SUSPENDED.
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  /// [category]: Slug kategori berita (kind `post`), misalnya `pengumuman`.
  ///
  /// `GET /posts` (operationId `listPosts`).
  Future<PostPage> listPosts({
    String? cursor,
    int? limit,
    String? category,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listPosts',
        method: 'GET',
        path: '/posts',
        authRequired: true,
        queryParameters: <String, Object?>{
          'cursor': ?cursor,
          'limit': ?limit,
          'category': ?category,
        },
        decode: (Object? v0) => PostPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail berita dengan body HTML tersanitasi server (F-08, AC F08-1).
  ///
  /// Berita yang belum terbit, terjadwal masa depan, atau sudah diarsipkan menghasilkan 404 NOT_FOUND (tidak
  /// dibedakan dari slug yang tidak ada, N-09); klien menampilkan pesan "Berita tidak lagi tersedia", termasuk saat
  /// dibuka dari banner atau notifikasi lama (AC F08-2, AC F13-3).
  ///
  /// `body_html` sudah disanitasi server saat disimpan (PRD 3.8); tautan luar diberi penanda agar klien
  /// menampilkan indikasi yang jelas.
  ///
  /// Slug yang melebihi panjang maksimum ditolak 400 VALIDATION_ERROR. Akses: anggota aktif (verified/expiring);
  /// lainnya 403 MEMBERSHIP_REQUIRED / ACCOUNT_SUSPENDED.
  ///
  /// [slug]: Slug berita (huruf kecil, angka, tanda hubung).
  ///
  /// `GET /posts/{slug}` (operationId `getPost`).
  Future<Post> getPost(
    String slug, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getPost',
        method: 'GET',
        path: '/posts/${Uri.encodeComponent(slug)}',
        authRequired: true,
        decode: (Object? v0) => Post.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Sukai berita; idempoten, maksimal satu like per pengguna per berita (AC F08-3).
  ///
  /// Idempoten secara alami (PUT): menekan berulang atau mengulang request tidak menambah like kedua karena key
  /// `post_likes(post_id, user_id)`; `like_count` dipelihara trigger database sehingga selalu sama dengan jumlah
  /// like (AC F08-3). Tidak memerlukan Idempotency-Key. Respons selalu berisi keadaan akhir.
  ///
  /// Hanya berita yang tampil di feed (published dan sudah waktunya); lainnya 404 NOT_FOUND. Slug tidak valid
  /// -> 400 VALIDATION_ERROR. Akses: anggota aktif (verified/expiring); lainnya 403 MEMBERSHIP_REQUIRED /
  /// ACCOUNT_SUSPENDED.
  ///
  /// [slug]: Slug berita (huruf kecil, angka, tanda hubung).
  ///
  /// `PUT /posts/{slug}/like` (operationId `likePost`).
  Future<LikeState> likePost(
    String slug, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'likePost',
        method: 'PUT',
        path: '/posts/${Uri.encodeComponent(slug)}/like',
        authRequired: true,
        decode: (Object? v0) => LikeState.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan like; idempoten (AC F08-3).
  ///
  /// Idempoten secara alami (DELETE): membatalkan like yang tidak ada tetap 200 dengan `liked = false`.
  /// `like_count` dipelihara trigger database (AC F08-3).
  ///
  /// Hanya berita yang tampil di feed; lainnya 404 NOT_FOUND. Slug tidak valid -> 400 VALIDATION_ERROR. Akses:
  /// anggota aktif (verified/expiring); lainnya 403 MEMBERSHIP_REQUIRED / ACCOUNT_SUSPENDED.
  ///
  /// [slug]: Slug berita (huruf kecil, angka, tanda hubung).
  ///
  /// `DELETE /posts/{slug}/like` (operationId `unlikePost`).
  Future<LikeState> unlikePost(
    String slug, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'unlikePost',
        method: 'DELETE',
        path: '/posts/${Uri.encodeComponent(slug)}/like',
        authRequired: true,
        decode: (Object? v0) => LikeState.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kategori aktif berita atau event untuk tab/filter (guideline "Manajemen Kategori", F-08, F-09).
  ///
  /// Hanya kategori `active = true`, urut `sort_order` lalu `label`. Tanpa paging karena jumlahnya kecil.
  /// Dipakai tab berita/event di aplikasi dan pilihan kategori formulir event di web admin. Kategori nonaktif
  /// tidak tersedia untuk pilihan baru, tetapi label historis tetap tampil pada konten yang sudah memakainya.
  ///
  /// Akses: sesi terautentikasi apa pun (anggota atau pengurus); tidak ada data privat.
  ///
  /// [kind]: Jenis kategori; kosong = semua jenis.
  ///
  /// `GET /categories` (operationId `listCategories`).
  Future<ContentCategoryList> listCategories({
    ContentCategoryKind? kind,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listCategories',
        method: 'GET',
        path: '/categories',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (kind case final v?) 'kind': v.toJson(),
        },
        decode: (Object? v0) => ContentCategoryList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar halaman informasi dan legal yang sudah terbit; publik tanpa login (F-08, PRD 3.8).
  ///
  /// Halaman yang pernah diterbitkan (memiliki salinan tayang): kebijakan privasi, ketentuan layanan, ketentuan
  /// komunitas, bantuan, tentang, serta halaman informasi lain dari pengurus. Draf tidak pernah dikirim. Urutan:
  /// dokumen legal (privacy, terms, community) lebih dahulu, lalu halaman lain menurut judul.
  ///
  /// Dipakai situs publik, layar legal aplikasi, dan layar registrasi sebelum aktivasi (PRD 2.2: pending_otp dan
  /// unverified tetap dapat membaca legal). Tanpa autentikasi; dibatasi rate limit per IP (120 permintaan
  /// per menit per IP, bersama GET /public/pages/{slug}; 429 dengan `retry_after_seconds`). Respons 200
  /// dapat di-cache publik paling lama 60 detik (`Cache-Control: public, max-age=60`); respons galat (400,
  /// 404, 429) membawa `Cache-Control: no-store`.
  ///
  /// `consent` memuat versi persetujuan registrasi (F-01): `policy_version` adalah string gabungan kanonis
  /// versi tayang kebijakan privasi DAN ketentuan layanan (`privacy:<v>;terms:<v>`) yang dikirim klien apa
  /// adanya sebagai `accept_policy_version` pada registrasi, lalu disimpan di `users.policy_version`. Satu
  /// nilai itu menunjuk tepat dua teks yang disetujui, dan keduanya dapat direproduksi dari audit
  /// `page.published` (F-01, F-17). Lihat skema `LegalConsentVersions`.
  ///
  /// `GET /public/pages` (operationId `listPublicPages`).
  Future<PublicPageList> listPublicPages({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listPublicPages',
        method: 'GET',
        path: '/public/pages',
        authRequired: false,
        decode: (Object? v0) => PublicPageList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Halaman legal atau informasi versi tayang terbaru; publik tanpa login (F-08, PRD 3.8).
  ///
  /// Mengembalikan salinan TAYANG (published_title/published_body_html) beserta `version` tayang dokumen INI
  /// dan `published_at`; perubahan draf pengurus yang belum diterbitkan tidak pernah terlihat. Untuk dokumen
  /// legal, `version` sama dengan `app_settings.legal.<privacy|terms|community>_version`.
  ///
  /// `version` per dokumen BUKAN nilai persetujuan registrasi: kebijakan privasi dan ketentuan memiliki
  /// penghitung versi masing-masing, sehingga klien mengirim `consent.policy_version` gabungan dari
  /// GET /public/pages sebagai `accept_policy_version` (F-01, skema `LegalConsentVersions`).
  ///
  /// Slug baku: `kebijakan-privasi`, `ketentuan`, `ketentuan-komunitas`, `bantuan`, `tentang`. Halaman yang
  /// belum pernah terbit atau slug yang tidak ada menghasilkan 404 NOT_FOUND; slug melebihi panjang maksimum
  /// -> 400 VALIDATION_ERROR. Tanpa autentikasi; dibatasi rate limit per IP (120 permintaan per menit per IP,
  /// bersama GET /public/pages). Respons 200 dapat di-cache publik paling lama 60 detik
  /// (`Cache-Control: public, max-age=60`); respons galat (400, 404, 429) membawa `Cache-Control: no-store`
  /// sehingga halaman yang baru pertama kali terbit tidak tertahan 404 di cache.
  ///
  /// [slug]: Slug halaman, misalnya `kebijakan-privasi`.
  ///
  /// `GET /public/pages/{slug}` (operationId `getPublicPage`).
  Future<PublicPage> getPublicPage(
    String slug, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getPublicPage',
        method: 'GET',
        path: '/public/pages/${Uri.encodeComponent(slug)}',
        authRequired: false,
        decode: (Object? v0) => PublicPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
