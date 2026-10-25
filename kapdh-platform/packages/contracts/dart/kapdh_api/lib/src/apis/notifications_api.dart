// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Kotak masuk resmi, deep link, preferensi push/email dan token perangkat (F-13, AC F13-1..F13-5).
///
/// Kelas API untuk tag kontrak "Notifications". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class NotificationsApi {
  const NotificationsApi(this._dio);

  final Dio _dio;

  /// Kotak masuk notifikasi sendiri, riwayat resmi (F-13, AC F13-2).
  ///
  /// Kotak masuk in-app adalah riwayat resmi dan selalu ditulis, apa pun preferensi push/email atau izin push OS
  /// (F-13, AC F13-2). Urutan terbaru dahulu dengan keyset (created_at, id) menurun (indeks
  /// notifications_user_id_created_at_id_idx, PRD 6.5). Hanya notifikasi milik pemanggil yang dikembalikan.
  /// `unread_count` dihitung atas seluruh kotak masuk (tidak dipengaruhi filter) untuk lencana lonceng.
  /// Cursor terikat pada filter; cursor tidak valid atau dari filter lain menghasilkan 400 VALIDATION_ERROR.
  ///
  /// [unreadOnly]: True untuk hanya menampilkan notifikasi yang belum dibaca.
  /// [category]: Saring per kategori.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /notifications` (operationId `listNotifications`).
  Future<NotificationPage> listNotifications({
    bool? unreadOnly,
    NotificationCategory? category,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listNotifications',
        method: 'GET',
        path: '/notifications',
        authRequired: true,
        queryParameters: <String, Object?>{
          'unread_only': ?unreadOnly,
          if (category case final v?) 'category': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => NotificationPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Jumlah notifikasi belum dibaca untuk lencana lonceng (F-13).
  ///
  /// Bacaan ringan untuk lencana di Beranda tanpa memuat halaman kotak masuk. Event realtime
  /// `notification.created` membawa jumlah terbaru; endpoint ini dipakai saat aplikasi kembali ke foreground atau
  /// setelah reconnect (ARCHITECTURE §4.9).
  ///
  /// `GET /notifications/unread-count` (operationId `getNotificationUnreadCount`).
  Future<NotificationUnreadCount> getNotificationUnreadCount({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getNotificationUnreadCount',
        method: 'GET',
        path: '/notifications/unread-count',
        authRequired: true,
        decode: (Object? v0) => NotificationUnreadCount.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Satu notifikasi milik sendiri, dipakai sebelum membuka deep link dari push (AC F13-3, F13-5).
  ///
  /// Saat push diketuk, aplikasi memanggil endpoint ini dengan `notification_id` dari payload push sebelum membuka
  /// objek tujuan. Sesi yang sudah logout ditolak 401, dan notifikasi milik akun lain (berganti akun) menghasilkan
  /// 404 NOT_FOUND tanpa membedakan tidak ada atau bukan milik (AC F13-3, F13-5, N-09). Rute tujuan tetap
  /// diperiksa ulang oleh endpoint objeknya (misalnya pembayaran milik sendiri), jadi rute bukan izin akses.
  /// Endpoint ini tidak menandai dibaca; panggil POST /notifications/read. `notificationId` yang bukan UUID
  /// menghasilkan 400 VALIDATION_ERROR.
  ///
  /// [notificationId]: Id notifikasi (UUID v7), misalnya dari payload data push.
  ///
  /// `GET /notifications/{notificationId}` (operationId `getNotification`).
  Future<InboxNotification> getNotification(
    String notificationId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getNotification',
        method: 'GET',
        path: '/notifications/${Uri.encodeComponent(notificationId)}',
        authRequired: true,
        decode: (Object? v0) => InboxNotification.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tandai notifikasi tertentu atau semua sebagai dibaca (F-13).
  ///
  /// Isi tepat salah satu: `ids` (1..100 id) atau `all: true`. Dengan `all`, `up_to` opsional membatasi pada
  /// notifikasi dengan created_at <= up_to, sehingga notifikasi yang datang setelah layar dimuat tidak ikut
  /// ditandai. Id yang tidak ada atau milik akun lain diabaikan tanpa galat (N-09). Operasi idempoten secara
  /// alami: read_at yang sudah terisi tidak diubah. Kombinasi tidak valid menghasilkan 400 VALIDATION_ERROR.
  ///
  /// `POST /notifications/read` (operationId `markNotificationsRead`).
  Future<MarkNotificationsReadResult> markNotificationsRead(
    MarkNotificationsReadRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'markNotificationsRead',
        method: 'POST',
        path: '/notifications/read',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => MarkNotificationsReadResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Preferensi kategori push dan email (F-13, AC F13-2).
  ///
  /// Baris preferensi yang tidak ada berarti aktif (default). Kategori security dan account wajib dan selalu
  /// dikirim; keduanya dilaporkan di `mandatory_categories` dan tidak memiliki saklar (ARCHITECTURE §4.7).
  ///
  /// `GET /notifications/preferences` (operationId `getNotificationPreferences`).
  Future<NotificationPreferences> getNotificationPreferences({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getNotificationPreferences',
        method: 'GET',
        path: '/notifications/preferences',
        authRequired: true,
        decode: (Object? v0) => NotificationPreferences.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Simpan seluruh preferensi push dan email; security dan account tidak dapat dimatikan (F-13).
  ///
  /// Mengganti seluruh preferensi (semua saklar wajib dikirim). Mematikan kategori hanya menghentikan push/email
  /// berikutnya; kotak masuk in-app tetap ditulis dan riwayat keputusan tetap terlihat (F-13, AC F13-2).
  /// Pengiriman yang sudah dijadwalkan untuk kategori yang dimatikan dibatalkan worker sebelum dikirim
  /// (status cancelled). Push untuk security/account dan email OTP tidak dipengaruhi preferensi.
  ///
  /// `PUT /notifications/preferences` (operationId `updateNotificationPreferences`).
  Future<NotificationPreferences> updateNotificationPreferences(
    NotificationPreferencesUpdate body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'updateNotificationPreferences',
        method: 'PUT',
        path: '/notifications/preferences',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => NotificationPreferences.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftarkan atau perbarui token FCM perangkat untuk keluarga sesi saat ini (AC F13-4, F13-5).
  ///
  /// Upsert berdasarkan token (device_tokens_token_key). Token diikat ke pengguna pemanggil dan ke KELUARGA sesi
  /// pemanggil (`sessions.family_id`), bukan ke satu baris sesi: rotasi refresh (AC F02-3) membuat baris
  /// sessions baru dalam keluarga yang sama setiap kali access token diperbarui (sekitar 15 menit) dan
  /// menandai baris lama `replaced_by`, sedangkan identitas sesi yang stabil adalah keluarganya (Session.id
  /// pada domain auth). device_tokens.session_id menunjuk baris keluarga yang terakhir diketahui; setiap
  /// pencocokan token dengan sesi selalu melalui `sessions.family_id`.
  ///
  /// Langkah dalam SATU transaksi:
  /// 1. Baris sesi pemanggil (sid access token) dibaca untuk family_id. Baris sesi AKTIF keluarga itu dikunci
  ///    (FOR NO KEY UPDATE, urutan kunci yang sama dengan logout/pencabutan sesi) sehingga pendaftaran yang
  ///    bersamaan dengan logout berurutan: bila keluarga sudah dicabut, 401 UNAUTHENTICATED dan token tidak
  ///    pernah aktif untuk sesi yang sudah keluar. Baris device_tokens untuk token ini
  ///    dikunci (SELECT ... FOR UPDATE; bila belum ada, INSERT ... ON CONFLICT (token) DO NOTHING lalu dikunci).
  /// 2. Token berpindah AKUN (device_tokens.user_id berbeda dari pemanggil, misalnya logout lalu masuk akun
  ///    lain di perangkat yang sama): seluruh pengiriman `pending` pada token itu dibatalkan (status
  ///    `cancelled`, error_class `token_reassigned`) SEBELUM token diikat ke pemanggil, sehingga judul dan isi
  ///    notifikasi akun lama tidak pernah sampai ke akun baru (AC F13-5, N-09). Pengiriman `failed` akun lama
  ///    tetap sebagai riwayat dan tidak dapat dikirim ulang ke perangkat ini (adminRetryNotificationDeliveries
  ///    melewatinya dengan alasan `token_reassigned`).
  /// 3. Pengguna yang SAMA, baik dalam keluarga sesi yang sama (setelah rotasi refresh atau token FCM
  ///    diperbarui) maupun keluarga baru (masuk ulang tanpa logout, atau session_id kosong karena baris sesi lama
  ///    dibersihkan): tidak ada pengiriman yang dibatalkan; pengiriman `pending` tetap dikirim ke perangkat
  ///    pemiliknya sehingga tidak ada notifikasi yang hilang (AC F13-1).
  /// 4. Token diikat: user_id = pemanggil, session_id = baris sesi pemanggil saat ini, platform, app_version;
  ///    revoked_at, failure_class dan failure_count dikosongkan; last_seen_at diperbarui.
  /// 5. Token lain milik pemanggil yang belum dicabut dan terikat ke baris mana pun dari keluarga sesi yang
  ///    sama (token FCM lama perangkat ini yang telah diperbarui) dicabut. Pengiriman `pending`-nya dipindahkan
  ///    ke token baru (UPDATE device_token_id) kecuali sudah ada pengiriman untuk notifikasi yang sama ke token
  ///    baru (notification_deliveries_target_key); sisanya dibatalkan dengan error_class `token_revoked`. Push
  ///    yang sudah dijadwalkan tidak hilang dan tidak terkirim ganda (AC F13-1).
  ///
  /// Sebagai pertahanan berlapis, worker hanya mengirim push bila pada saat klaim pengiriman (statement yang
  /// sama) device_tokens.revoked_at IS NULL DAN device_tokens.user_id = notifications.user_id; selain itu
  /// pengiriman dibatalkan tanpa dikirim. Predikat yang sama diperiksa ulang untuk SETIAP pengiriman tepat
  /// sebelum provider dipanggil (transaksi pendek: token dikunci FOR SHARE, lalu baris pengiriman FOR UPDATE
  /// dengan syarat masih `pending` dan attempt klaim yang sama), sehingga logout, unregister, perpindahan token
  /// atau preferensi yang commit setelah klaim tetapi sebelum giliran sebuah pengiriman selalu mencegah
  /// pengiriman itu. Yang dapat lolos hanya percobaan yang SUDAH berjalan di provider saat pencabutan commit
  /// (paling lama batas waktu satu percobaan, 60 detik); bila provider menerimanya, riwayat mencatatnya `sent`
  /// apa adanya. Predikat yang sama dipakai retry admin, jadi `token_reassigned` selalu berarti token kini
  /// milik AKUN lain.
  ///
  /// Pencabutan berbasis keluarga (AC F13-5): logout, logout-all, pencabutan sesi (DELETE
  /// /auth/sessions/{sessionId}), reuse refresh token yang mencabut keluarga, dan penghapusan akun mencabut
  /// setiap token yang session_id-nya menunjuk baris mana pun dari keluarga yang dicabut
  /// (`device_tokens.session_id IN (SELECT id FROM sessions WHERE family_id = ...)`) dalam transaksi
  /// pencabutan, dan membatalkan pengiriman `pending`-nya (error_class `token_revoked`). Agar ikatan tidak putus
  /// oleh pembersihan baris sesi lama (FK ON DELETE SET NULL), rotasi refresh memindahkan device_tokens.session_id
  /// dari baris lama ke baris baru dalam transaksi rotasi yang sama (modul auth), dan job pembersihan sesi
  /// mencabut token keluarga yang kedaluwarsa sebelum menghapus barisnya. Sesi yang berakhir tanpa logout (refresh
  /// kedaluwarsa) juga berarti keluar: job worker `notifications.device-sweep` (setiap jam) mencabut token yang
  /// keluarga sesinya tidak lagi memiliki baris aktif (belum dicabut dan belum kedaluwarsa) atau yang tidak terikat
  /// baris sesi mana pun, beserta pengiriman `pending`-nya (`token_revoked`); token yang diikat ulang ke sesi baru
  /// secara bersamaan tidak ikut dicabut. PUT /devices dari keluarga sesi yang sudah kedaluwarsa ditolak 401.
  /// Token tidak pernah dicatat di log atau audit (ARCHITECTURE §2) dan tidak pernah dikembalikan API.
  ///
  /// `PUT /devices` (operationId `registerDevice`).
  Future<void> registerDevice(
    RegisterDeviceRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'registerDevice',
        method: 'PUT',
        path: '/devices',
        authRequired: true,
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Cabut token FCM perangkat ini, misalnya sebelum logout atau saat izin push dicabut (AC F13-5).
  ///
  /// Token dikirim di body, bukan di path, agar tidak tercatat di log akses. Hanya token milik pemanggil
  /// (device_tokens.user_id = pemanggil, keluarga sesi mana pun) yang dicabut (revoked_at diisi) dan, dalam
  /// transaksi yang sama, pengiriman `pending` pada token itu dibatalkan
  /// (`cancelled`, error_class `token_revoked`); token yang tidak dikenal atau milik akun lain diabaikan dengan
  /// respons yang sama (N-09). Pemanggilan berulang tetap 204. Logout tetap mencabut token sesi di server
  /// walaupun panggilan ini gagal karena jaringan (AC F13-5).
  ///
  /// `POST /devices/unregister` (operationId `unregisterDevice`).
  Future<void> unregisterDevice(
    UnregisterDeviceRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'unregisterDevice',
        method: 'POST',
        path: '/devices/unregister',
        authRequired: true,
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );
}
