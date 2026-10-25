// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Status pengiriman notifikasi per kanal dan retry terkendali oleh pengurus (F-13, AC F13-4, PRD 4.5).
///
/// Kelas API untuk tag kontrak "Admin Notifications". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminNotificationsApi {
  const AdminNotificationsApi(this._dio);

  final Dio _dio;

  /// Daftar hasil pengiriman email/push per kanal dan perangkat (izin notifications.manage, F-13).
  ///
  /// Kegagalan kanal ditampilkan ke pengurus untuk retry yang terkendali (F-13, PRD 4.5). Status `sent` berarti
  /// diterima provider (misalnya FCM accepted), bukan jaminan dibaca perangkat (F-13). `error_class` memakai
  /// klasifikasi worker (FCM: UNREGISTERED, INVALID_ARGUMENT, SENDER_ID_MISMATCH, QUOTA_EXCEEDED, UNAVAILABLE,
  /// INTERNAL, NETWORK (jaringan/batas waktu), AUTH_ERROR (kredensial FCM/APNs); email: bounce_hard, bounce_soft,
  /// rejected, timeout, network, auth_error (kredensial SMTP), unknown; pembatalan sisi server: token_revoked,
  /// token_reassigned, preference_disabled, recipient_unavailable, push_disabled). UNREGISTERED,
  /// SENDER_ID_MISMATCH dan INVALID_ARGUMENT yang menunjuk token registrasi menonaktifkan token, sedangkan
  /// 429/5xx/jaringan (serta AUTH_ERROR karena token akses OAuth FCM ditolak/gagal ditukar; 401 tanpa
  /// THIRD_PARTY_AUTH_ERROR) memakai retry dengan backoff otomatis tanpa menonaktifkan token (AC F13-4): jeda 1, 2, 4,
  /// 8, 16 menit (Retry-After provider dihormati, maksimal 1 jam), paling banyak 6 percobaan otomatis lalu
  /// `failed`. Selama retry otomatis status tetap `pending` dengan `error_class` percobaan terakhir. Satu
  /// percobaan ke provider dibatasi 60 detik; saat batas habis percobaan DIBATALKAN (koneksi SMTP ditutup
  /// sebelum akhir DATA, permintaan FCM diputus), dicatat `timeout`/NETWORK lalu dicoba ulang dengan backoff.
  /// Email memakai Message-ID stabil per pengiriman dan push memakai collapse key = id notifikasi, untuk
  /// meredam sisa ambiguitas jaringan (balasan provider hilang tepat setelah pesan diterima). `from`
  /// inklusif dan `to` eksklusif terhadap created_at; `from` harus sebelum `to` (selain itu 400). Urutan
  /// `updated_at_desc` memakai kolom yang dapat berubah, jadi halaman berikutnya dapat melewatkan atau
  /// mengulang baris yang berubah selama penelusuran. `total` mengikuti filter. Tanpa notifications.manage
  /// ditolak 403 (AC F15-1).
  ///
  /// `retryable=true` hanya mengembalikan kegagalan yang masih dapat ditindak (definisi
  /// AdminNotificationDelivery.retryable); kombinasi `status=failed&retryable=true&from=<failed_delivery_since>`
  /// menghasilkan `total` yang sama dengan DashboardJobs.failed_delivery_count pada waktu yang sama. Kegagalan
  /// yang tidak dapat dikirim ulang (token dicabut atau UNREGISTERED, token berpindah akun, penerima tidak
  /// tersedia, preferensi dimatikan) tetap terlihat sebagai riwayat dengan `retryable=false`.
  ///
  /// [errorClass]: Kelas galat persis, misalnya UNREGISTERED.
  /// [userId]: Penerima (users.id), untuk menelusuri keluhan "tidak menerima notifikasi".
  /// [retryable]: true hanya pengiriman yang dapat dijadwalkan ulang saat ini (selalu berstatus failed); false hanya yang
  /// tidak dapat. Kosong berarti keduanya.
  /// [from]: Batas bawah created_at (inklusif, UTC).
  /// [to]: Batas atas created_at (eksklusif, UTC).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/notifications/deliveries` (operationId `adminListNotificationDeliveries`).
  Future<AdminNotificationDeliveryPage> adminListNotificationDeliveries({
    NotificationDeliveryStatus? status,
    NotificationChannel? channel,
    NotificationCategory? category,
    String? errorClass,
    String? userId,
    String? notificationId,
    bool? retryable,
    DateTime? from,
    DateTime? to,
    AdminDeliverySort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListNotificationDeliveries',
        method: 'GET',
        path: '/admin/notifications/deliveries',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          if (channel case final v?) 'channel': v.toJson(),
          if (category case final v?) 'category': v.toJson(),
          'error_class': ?errorClass,
          'user_id': ?userId,
          'notification_id': ?notificationId,
          'retryable': ?retryable,
          if (from case final v?) 'from': encodeDateTime(v),
          if (to case final v?) 'to': encodeDateTime(v),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminNotificationDeliveryPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Jadwalkan ulang pengiriman yang gagal secara terkendali (izin notifications.manage, AC F13-4).
  ///
  /// Untuk 1..100 pengiriman sekaligus (satu baris atau setelah gangguan provider). Hanya pengiriman `failed`
  /// yang dijadwalkan ulang, dengan UPDATE bersyarat `WHERE status = 'failed'` yang untuk push juga mensyaratkan
  /// token masih milik penerima notifikasi (`device_tokens.revoked_at IS NULL AND device_tokens.user_id =
  /// notifications.user_id`, dievaluasi dalam statement yang sama): status menjadi `pending`, next_retry_at =
  /// sekarang, attempt tetap (riwayat percobaan terlihat). Pengiriman dilewati, bukan galat, bila: tidak
  /// ditemukan, statusnya bukan failed (sudah dikirim ulang admin lain atau worker), token push sudah dicabut
  /// (UNREGISTERED atau logout, AC F13-4/F13-5), token sudah berpindah ke AKUN lain sehingga isi notifikasi akun
  /// lama tidak boleh dikirim ke perangkat itu (`token_reassigned`, AC F13-5; perpindahan keluarga sesi milik
  /// pengguna yang sama tidak menghalangi retry, lihat registerDevice), penerima sudah
  /// dihapus/dinonaktifkan, atau preferensi kategori/kanal kini dimatikan (F-13). Worker memeriksa ulang syarat
  /// kepemilikan token yang sama saat mengklaim pengiriman dan sekali lagi tepat sebelum provider dipanggil.
  /// Kotak masuk tidak pernah diduplikasi (AC F13-1). Retry
  /// diaudit `notification.delivery.retried` dalam transaksi yang sama (AC F17-1) dan dibatasi per admin
  /// (RATE_LIMITED, 20 permintaan per menit). Idempotency-Key mencegah penjadwalan ganda saat klik ulang.
  /// Pengiriman dikirim job worker `notifications.retry` (setiap menit), bukan oleh request ini; karena attempt
  /// tidak direset, pengiriman yang sudah mencapai batas percobaan otomatis mendapat satu percobaan per retry
  /// pengurus (gangguan sementara berikutnya langsung `failed` lagi).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/notifications/deliveries/retry` (operationId `adminRetryNotificationDeliveries`).
  Future<AdminDeliveryRetryResult> adminRetryNotificationDeliveries(
    AdminDeliveryRetryRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminRetryNotificationDeliveries',
        method: 'POST',
        path: '/admin/notifications/deliveries/retry',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminDeliveryRetryResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Event outbox yang perlu tindakan atau sedang menunggu (izin notifications.manage, PRD 5.1, 5.5).
  ///
  /// Memantau dispatcher outbox (PRD 5.1): tanpa `status`, hanya event `failed` dan `dead` (perlu tindakan)
  /// yang dikembalikan. `last_error` adalah pesan aman tanpa PII, token atau isi payload (N-14); payload dan
  /// dedup key tidak pernah diekspos. `request_id` menghubungkan ke log API/worker (N-14). `topic` dicocokkan
  /// persis; topik yang dikenal: notification.created, account.deletion.requested, audit.export.requested,
  /// event.cancelled, admin.security_notice, member.password_reset_initiated (ARCHITECTURE §4.7).
  ///
  /// [from]: Batas bawah created_at (inklusif, UTC).
  /// [to]: Batas atas created_at (eksklusif, UTC).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/notifications/outbox` (operationId `adminListOutboxEvents`).
  Future<AdminOutboxEventPage> adminListOutboxEvents({
    AdminOutboxStatus? status,
    String? topic,
    DateTime? from,
    DateTime? to,
    AdminOutboxSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListOutboxEvents',
        method: 'GET',
        path: '/admin/notifications/outbox',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          'topic': ?topic,
          if (from case final v?) 'from': encodeDateTime(v),
          if (to case final v?) 'to': encodeDateTime(v),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminOutboxEventPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kembalikan event outbox failed/dead ke antrean (izin notifications.manage, PRD 5.1).
  ///
  /// Untuk 1..100 event. Hanya event `failed` atau `dead` yang TIDAK sedang diklaim dispatcher yang
  /// dikembalikan ke `pending`, dengan satu UPDATE bersyarat (ARCHITECTURE §2.11):
  /// `WHERE id = ANY(...) AND status IN ('failed','dead') AND (locked_until IS NULL OR locked_until <= now())
  /// RETURNING ...` yang mengisi next_attempt_at = sekarang dan mengosongkan locked_until; attempts dan
  /// last_error tetap sebagai riwayat. Lease dispatcher yang masih berlaku tidak pernah diputus, sehingga dua
  /// dispatcher tidak mengklaim event yang sama bersamaan. Dispatcher memproses ulang dengan dedup key yang sama
  /// dan setiap konsumen idempoten per domain, sehingga retry tidak menggandakan uang, periode, nomor, kursi
  /// atau notifikasi (PRD 5.1). Event yang tidak lolos predikat dilewati dengan alasan: `not_found`,
  /// `in_progress` (sedang diklaim dispatcher; coba lagi setelah klaim selesai) atau `not_retryable` (status
  /// pending atau dispatched). Diaudit `outbox.retried` (AC F17-1); dibatasi per admin (RATE_LIMITED, 20
  /// permintaan per menit). attempts tidak direset, sehingga event `dead` mendapat satu percobaan per retry
  /// pengurus.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/notifications/outbox/retry` (operationId `adminRetryOutboxEvents`).
  Future<AdminOutboxRetryResult> adminRetryOutboxEvents(
    AdminOutboxRetryRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminRetryOutboxEvents',
        method: 'POST',
        path: '/admin/notifications/outbox/retry',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminOutboxRetryResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
