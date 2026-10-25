// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pengelolaan event, kuota, pembatalan/refund, peserta dan check-in tiket oleh pengurus (F-09, F-15, AC F15-2,
/// PRD 4.4). Aturan bersama:
/// - Izin dievaluasi dari DB setiap request (AC F15-1, F16-3); super_admin memiliki semua izin.
/// - Setiap mutasi menulis audit dalam transaksi yang sama (F-17: "kuota/event/tiket/check-in", AC F17-1).
/// - Pembaruan berversi memakai If-Match; versi berbeda -> 409 VERSION_CONFLICT dengan `current` (AC F15-4).
///   `version` event naik pada perubahan field yang diedit pengurus dan perubahan status, TIDAK pada perubahan
///   penghitung kursi oleh reservasi anggota, sehingga formulir admin tidak bentrok dengan arus reservasi.
/// - Setiap transaksi mengikuti urutan kunci global pada deskripsi tag Events: event, lalu tiket (urut id),
///   lalu payment (urut id); id dari baris lain dibaca tanpa kunci lalu status diperiksa ulang sesudah kunci
///   (PRD 6.4).
/// - Angka kursi pada respons baca memakai proyeksi kursi tag Events: hold kedaluwarsa yang belum dilepas job
///   tidak dihitung dalam `held_quantity`, `seats_available`, `min_seats_total` maupun statistik.
/// - Refund adalah keputusan uang: refund otomatis yang diwajibkan D6 (event dibatalkan, pembatalan sendiri
///   sebelum H-3) dicatat tanpa diskresi; refund diskresioner per kasus (adminCancelTicket `refund=true`)
///   memerlukan payments.decide dan tunduk pada aturan konflik kepentingan (PRD 2.3, ARCHITECTURE §3.3).
///
///
/// Kelas API untuk tag kontrak "Admin Events". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminEventsApi {
  const AdminEventsApi(this._dio);

  final Dio _dio;

  /// Kategori event (aktif dan nonaktif) untuk formulir dan filter event (izin events.manage, F-15).
  ///
  /// Baca saja; pembuatan/perubahan kategori event ada di Manajemen Kategori domain konten
  /// (/admin/content/event-categories, izin events.manage, guideline p14). Kategori nonaktif ditampilkan agar
  /// event lama tetap terbaca, tetapi tidak boleh dipilih untuk event baru/diubah.
  ///
  /// `GET /admin/event-categories` (operationId `adminListEventCategories`).
  Future<AdminEventCategoryList> adminListEventCategories({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListEventCategories',
        method: 'GET',
        path: '/admin/event-categories',
        authRequired: true,
        decode: (Object? v0) => AdminEventCategoryList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Unggah gambar cover event (kolom "Gambar" guideline p14; izin events.manage, N-10, PRD 2.5).
  ///
  /// Membuat berkas purpose `event_cover` milik akun login pemanggil (`files.owner_user_id`) untuk dirujuk
  /// `cover_file_id` pada adminCreateEvent/adminUpdateEvent. Unggahan berkas umum POST /files tidak menerima
  /// purpose ini; cover event selalu lewat operasi ini agar izin events.manage yang diperiksa.
  /// - JPG/PNG <= 5 MB; magic bytes diperiksa, dimensi/decompression berlebihan ditolak, EXIF dibuang dan gambar
  ///   di-encode ulang (N-10). Pelanggaran -> 413/415/422 FILE_INVALID.
  /// - Berkas bervisibilitas publik (files_private_purpose_chk mengizinkan event_cover) karena tampil di kartu
  ///   event aplikasi dan situs; tidak boleh berisi data pribadi.
  /// - Status `ready` sesudah diproses. Berkas yang tidak dilampirkan ke event dalam 24 jam (`attached_at` null)
  ///   dihapus job `files.cleanup-temp` (PRD 2.5).
  /// - Batas 10 unggahan berhasil per purpose per akun per 24 jam bergulir (N-10) -> 429 RATE_LIMITED dengan
  ///   `retry_after_seconds`.
  /// Pemasangan cover tercatat pada audit `event.created`/`event.updated` (F-17), bukan saat unggah.
  ///
  /// `POST /admin/event-covers` (operationId `adminUploadEventCover`).
  Future<AdminEventCoverMedia> adminUploadEventCover(
    AdminEventCoverUploadRequest body, {
    CancelToken? cancelToken,
    Options? options,
    ProgressCallback? onSendProgress,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUploadEventCover',
        method: 'POST',
        path: '/admin/event-covers',
        authRequired: true,
        data: body.toFormData(),
        decode: (Object? v0) => AdminEventCoverMedia.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
        onSendProgress: onSendProgress,
      );

  /// Tabel Event dan Tiket dengan pencarian, filter dan paging server (izin events.manage, guideline p14).
  ///
  /// Kolom guideline p14: nama event, gambar, kategori, lokasi, buka/tutup daftar, total tiket (`seats_total`),
  /// sisa tiket (`seats_available`) dan aksi kelola (`has_tickets` menonaktifkan hapus, AC F15-2). Semua status
  /// termasuk draft. Urutan bawaan `starts_at_desc`; setiap urutan diakhiri `id` agar paging stabil.
  ///
  /// [q]: Cari judul atau nama lokasi.
  /// [startsFrom]: Hanya event dengan starts_at >= nilai ini.
  /// [startsTo]: Hanya event dengan starts_at < nilai ini.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/events` (operationId `adminListEvents`).
  Future<AdminEventPage> adminListEvents({
    String? q,
    EventStatus? status,
    String? categoryId,
    DateTime? startsFrom,
    DateTime? startsTo,
    AdminEventSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListEvents',
        method: 'GET',
        path: '/admin/events',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          if (status case final v?) 'status': v.toJson(),
          'category_id': ?categoryId,
          if (startsFrom case final v?) 'starts_from': encodeDateTime(v),
          if (startsTo case final v?) 'starts_to': encodeDateTime(v),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminEventPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat event baru sebagai draft (izin events.manage, F-15, PRD 3.9).
  ///
  /// Event selalu dibuat `draft` dan baru terlihat anggota setelah diterbitkan (POST .../status `open`).
  /// Validasi server: judul 1..200 karakter setelah trim; `ends_at > starts_at`;
  /// `registration_opens_at < registration_closes_at <= ends_at`; `checkin_opens_at`/`checkin_closes_at` keduanya
  /// kosong (bawaan D5: 2 jam sebelum mulai sampai selesai) atau keduanya terisi dengan closes > opens dan
  /// `checkin_closes_at <= ends_at` (jendela lain boleh dibuka lebih awal atau ditutup lebih cepat, tetapi tidak
  /// melewati akhir acara karena event menjadi `done` saat acara selesai; `field_errors.checkin_closes_at`);
  /// `location_url` https; `timezone` IANA valid (bawaan Asia/Jakarta); `category_id` kategori event aktif;
  /// `cover_file_id` berkas purpose `event_cover` berstatus ready hasil POST /admin/event-covers yang diunggah
  /// pemanggil dan belum dihapus (berkas publik; saat event disimpan `attached_at` diisi agar tidak dibersihkan
  /// job unggahan sementara). Pelanggaran: 400 VALIDATION_ERROR dengan `field_errors`. Audit `event.created`.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/events` (operationId `adminCreateEvent`).
  Future<AdminEventDetail> adminCreateEvent(
    AdminEventCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreateEvent',
        method: 'POST',
        path: '/admin/events',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminEventDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail event untuk formulir edit, penghitung kursi dan aksi yang diizinkan (izin events.manage).
  ///
  /// `GET /admin/events/{eventId}` (operationId `adminGetEvent`).
  Future<AdminEventDetail> adminGetEvent(
    String eventId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetEvent',
        method: 'GET',
        path: '/admin/events/${Uri.encodeComponent(eventId)}',
        authRequired: true,
        decode: (Object? v0) => AdminEventDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus event yang belum pernah memiliki tiket (AC F15-2, PRD 4.4).
  ///
  /// Hanya event tanpa tiket sama sekali (status apa pun, termasuk expired/cancelled). Event yang memiliki
  /// riwayat tiket ditolak 409 VALIDATION_ERROR dan harus dibatalkan lewat POST .../cancel (AC F15-2). UI meminta
  /// konfirmasi (PRD 4.5). Audit `event.deleted` berisi snapshot event.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/events/{eventId}` (operationId `adminDeleteEvent`).
  Future<void> adminDeleteEvent(
    String eventId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeleteEvent',
        method: 'DELETE',
        path: '/admin/events/${Uri.encodeComponent(eventId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah event draft/open/closed dengan If-Match; kuota tidak boleh di bawah held+paid (AC F15-2, F15-4).
  ///
  /// Field yang tidak dikirim tidak berubah; field nullable yang dikirim null dikosongkan. Aturan:
  /// - Event `done` atau `cancelled` tidak dapat diubah: 400 VALIDATION_ERROR.
  /// - `seats_total` tidak boleh di bawah `held_quantity + paid_quantity` saat ini (diperiksa dengan baris event
  ///   terkunci): 409 VALIDATION_ERROR dengan `field_errors.seats_total` dan `current` = AdminEventDetail
  ///   (AC F15-2). Bila kuota diturunkan, hold kedaluwarsa event ini lebih dahulu dilepas dalam transaksi yang
  ///   sama (sama dengan createEventReservation langkah 1; kunci event, tiket, payment), sehingga batas yang
  ///   diperiksa sama dengan `min_seats_total` yang ditampilkan.
  /// - `price` boleh diubah tetapi hanya berlaku untuk reservasi baru; tiket dan payment yang sudah dibuat
  ///   memakai total snapshot (PRD 4.4, AC F03-5).
  /// - Validasi waktu, lokasi, kategori dan cover sama dengan pembuatan. Hold yang sudah berjalan tetap memakai
  ///   `hold_expires_at` semula.
  /// - Perubahan `starts_at`, `ends_at`, `timezone` atau lokasi pada event yang memiliki tiket aktif memberi
  ///   notifikasi kategori event kepada pemegang tiket (deep link `/tickets/<ticketId>`) dan menjadwalkan ulang
  ///   pengingat H-3/H-1; jadwal lama dibatalkan (AC F13-6).
  /// Audit `event.updated` berisi before/after field yang berubah.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/events/{eventId}` (operationId `adminUpdateEvent`).
  Future<AdminEventDetail> adminUpdateEvent(
    String eventId,
    AdminEventUpdateRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateEvent',
        method: 'PATCH',
        path: '/admin/events/${Uri.encodeComponent(eventId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminEventDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Terbitkan, tutup, atau buka kembali pendaftaran event (izin events.manage, PRD 4.4).
  ///
  /// Transisi yang diizinkan (selain ini 400 VALIDATION_ERROR `field_errors.status`):
  /// - draft -> open (terbitkan): `ends_at > now` dan `registration_closes_at > now`.
  /// - open -> closed: menutup pemesanan baru lebih awal; reservasi yang sedang ditahan tetap dapat mengirim bukti
  ///   sampai `hold_expires_at`, tiket paid tetap berlaku untuk check-in.
  /// - closed -> open: hanya bila `now < registration_closes_at` dan `ends_at > now`.
  /// `done` hanya diset job `events.lifecycle` sesudah acara berakhir (open -> closed otomatis saat
  /// `registration_closes_at` lewat); `cancelled` hanya lewat POST .../cancel. Audit `event.status_changed`.
  /// Urutan pemeriksaan dengan baris event terkunci (aman untuk diulang sesudah jaringan putus, PRD 4.3, 4.5):
  /// 1. Replay dengan Idempotency-Key dan payload sama mengembalikan hasil pertama tanpa pemeriksaan ulang.
  /// 2. Bila `status` yang diminta SAMA dengan status saat ini, 200 dengan event terkini dikembalikan tanpa
  ///    perubahan dan tanpa audit, SEBELUM If-Match dibandingkan (permintaan ulang tanpa key yang sama tidak
  ///    menghasilkan VERSION_CONFLICT palsu).
  /// 3. If-Match dibandingkan; berbeda -> 409 VERSION_CONFLICT dengan `current` = AdminEventDetail.
  /// 4. Transisi divalidasi seperti di atas.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/events/{eventId}/status` (operationId `adminSetEventStatus`).
  Future<AdminEventDetail> adminSetEventStatus(
    String eventId,
    AdminEventStatusRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminSetEventStatus',
        method: 'POST',
        path: '/admin/events/${Uri.encodeComponent(eventId)}/status',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminEventDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan event; seluruh QR tidak berlaku, refund penuh dicatat, peserta diberi notifikasi (AC F09-7, D6).
  ///
  /// Hanya event `open` atau `closed` (draft dihapus, bukan dibatalkan; done/cancelled ditolak 400). Alasan wajib
  /// dan ditampilkan kepada peserta. UI meminta konfirmasi (PRD 4.5). Dalam SATU transaksi mengikuti urutan kunci
  /// global: baris event dikunci lebih dahulu (sesudahnya tidak ada reservasi, keputusan pembayaran tiket atau
  /// pembatalan tiket baru yang dapat berjalan di event ini), lalu semua tiket aktif event urut id, lalu payment
  /// tiket tersebut urut id:
  /// - event -> cancelled (`cancelled_at`, `cancel_reason`); pemesanan dan check-in tertutup.
  /// - hold kedaluwarsa yang belum dilepas menjadi expired lebih dahulu (sama dengan createEventReservation
  ///   langkah 1), sehingga status yang sudah tampil kepada anggota lewat proyeksi baca tidak berubah.
  /// - tiket awaiting_payment lainnya -> cancelled (`cancelled_by=admin`), payment pending tanpa bukti dibatalkan.
  /// - tiket paid -> cancelled (`cancelled_by=system`), QR tidak berlaku; payment tetap paid dan untuk total > 0
  ///   dibuat payment_adjustment refund pending sebesar total dengan tenggat 7 hari kerja (D6). Tiket gratis tanpa
  ///   refund.
  /// - tiket awaiting_review -> cancelled (`cancelled_by=system`, akibat pembatalan event, bukan keputusan per tiket,
  ///   sehingga persetujuan dana sesudahnya memicu refund penuh D6); payment-nya tetap pending di antrean verifikasi karena dana mungkin
  ///   sudah ditransfer. Bila pengurus kemudian menyetujui (dana terverifikasi), payment menjadi paid dan refund
  ///   penuh otomatis dibuat, tiket tetap cancelled dan penghitung kursi tidak berubah; bila ditolak, tidak ada
  ///   refund dan kursi tidak dilepas kedua kalinya (aturan payment tiket pada deskripsi tag Events dan
  ///   adminDecidePayment).
  /// - Refund di sini diwajibkan D6 ("refund penuh kepada seluruh peserta berbayar"), bukan keputusan diskresi,
  ///   sehingga cukup events.manage; transfer dan penyelesaian refund dilakukan bendahara lewat API
  ///   payment_adjustments dengan aturan konflik kepentingan PRD 2.3.
  /// - held_quantity dan paid_quantity menjadi 0; event, tiket, payment dan audit historis tidak dihapus.
  /// - audit `event.cancelled` dan outbox `event.cancelled` (dedup per event). Job `events.cancelled.fanout`
  ///   membuat notifikasi kategori event untuk setiap pemegang tiket terdampak (dedup
  ///   `event.cancelled:<eventId>:<userId>`, deep link `/tickets/<ticketId>`) dan membatalkan pengingat H-3/H-1.
  /// Ulangi dengan Idempotency-Key yang sama untuk hasil yang sama (PRD 4.3).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/events/{eventId}/cancel` (operationId `adminCancelEvent`).
  Future<AdminEventCancelResult> adminCancelEvent(
    String eventId,
    AdminEventCancelRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCancelEvent',
        method: 'POST',
        path: '/admin/events/${Uri.encodeComponent(eventId)}/cancel',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminEventCancelResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Statistik kursi, check-in dan pendapatan event (izin events.manage, PRD 1.6 pemanfaatan event).
  ///
  /// Dihitung dari tiket, payment tiket dan payment_adjustment refund event ini pada saat request. Pendapatan
  /// kotor = jumlah payment tiket berstatus paid (termasuk tiket yang kemudian dibatalkan); pendapatan bersih =
  /// kotor dikurangi refund completed. Refund pending ditampilkan terpisah.
  ///
  /// `GET /admin/events/{eventId}/stats` (operationId `adminGetEventStats`).
  Future<AdminEventStats> adminGetEventStats(
    String eventId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetEventStats',
        method: 'GET',
        path: '/admin/events/${Uri.encodeComponent(eventId)}/stats',
        authRequired: true,
        decode: (Object? v0) => AdminEventStats.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Peserta/tiket event dengan status, pembayaran dan info check-in (izin events.manage, F-09, F-15).
  ///
  /// Semua tiket event termasuk expired/cancelled. Filter status, sudah/belum check-in, dan pencarian nama atau
  /// nomor anggota. Pemegang yang akunnya sudah dihapus tampil anonim (nama null, F-14 AC F14-4). Data pemegang
  /// minimum: nama, nomor anggota, angkatan, avatar dan kelayakan tiket (tanpa kontak). Urutan bawaan
  /// `created_at_desc`.
  ///
  /// [checkedIn]: true = sudah check-in, false = belum.
  /// [q]: Nama atau nomor anggota pemegang tiket.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/events/{eventId}/tickets` (operationId `adminListEventTickets`).
  Future<AdminEventTicketPage> adminListEventTickets(
    String eventId, {
    TicketStatus? status,
    bool? checkedIn,
    String? q,
    AdminEventTicketSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListEventTickets',
        method: 'GET',
        path: '/admin/events/${Uri.encodeComponent(eventId)}/tickets',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          'checked_in': ?checkedIn,
          'q': ?q,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminEventTicketPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan satu tiket oleh pengurus, opsional dengan refund penuh (D6, PRD 2.2, PRD 4.4).
  ///
  /// Untuk kasus per peserta, mis. anggota disuspend ("tiket tidak berlaku; refund diputuskan pengurus per
  /// kasus", PRD 2.2) atau permintaan peserta yang diproses pengurus. Hanya tiket `awaiting_payment` atau `paid`
  /// yang belum check-in pada event yang tidak cancelled; tiket awaiting_review ditolak 409
  /// PAYMENT_STATE_CONFLICT (putuskan pembayarannya lebih dahulu; penolakan otomatis membatalkan tiket,
  /// AC F09-4). Efek dalam satu transaksi mengikuti urutan kunci global (event -> tiket -> payment; status dan
  /// versi diperiksa ulang sesudah kunci): tiket cancelled (`cancelled_by=admin`, alasan wajib), kursi dilepas,
  /// payment pending dibatalkan; untuk tiket paid dengan total > 0, `refund=true` membuat payment_adjustment
  /// refund pending sebesar total dengan tenggat 7 hari kerja (D6), `refund=false` mencatat tanpa refund.
  /// `refund=true` untuk tiket yang tidak berbayar ditolak 400.
  /// Refund per kasus adalah keputusan uang (PRD 2.2 "refund diputuskan pengurus per kasus", PRD 2.3), sehingga
  /// `refund=true` diperiksa SEBELUM perubahan apa pun:
  /// - pemanggil wajib juga memiliki izin `payments.decide` (dievaluasi dari DB setiap request, super_admin
  ///   memiliki semua izin); tanpa izin itu -> 403 FORBIDDEN;
  /// - konflik kepentingan: bila pemegang tiket adalah akun alumni tertaut pemanggil
  ///   (`admins.linked_alumni_user_id`, relasi identitas saat provisioning, bukan kesamaan user_id) -> 403
  ///   FORBIDDEN; pengurus lain dengan payments.decide yang memutus refund tersebut (PRD 2.3, ARCHITECTURE §3.3).
  /// Pembatalan tanpa refund (`refund=false`) cukup events.manage. `can_refund` pada AdminEventTicket
  /// menunjukkan apakah pemanggil saat ini boleh memilih refund. Audit `ticket.cancelled` memuat alasan dan
  /// keputusan refund. Pemegang diberi notifikasi kategori event (deep link `/tickets/<ticketId>`).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/events/{eventId}/tickets/{ticketId}/cancel` (operationId `adminCancelTicket`).
  Future<AdminEventTicket> adminCancelTicket(
    String eventId,
    String ticketId,
    AdminTicketCancelRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCancelTicket',
        method: 'POST',
        path: '/admin/events/${Uri.encodeComponent(eventId)}/tickets/${Uri.encodeComponent(ticketId)}/cancel',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminEventTicket.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Event yang dapat dipindai petugas check-in hari ini (izin events.checkin, D5).
  ///
  /// Event `open` atau `closed` yang jendela check-in efektifnya belum berakhir dan dibuka paling lambat 24 jam
  /// dari sekarang, urut `checkin_opens_at`. Petugas memilih event sebelum memindai agar QR event lain ditolak
  /// (AC F09-6). Maksimal 50 event.
  ///
  /// `GET /admin/checkin/events` (operationId `adminListCheckinEvents`).
  Future<AdminCheckinEventList> adminListCheckinEvents({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListCheckinEvents',
        method: 'GET',
        path: '/admin/checkin/events',
        authRequired: true,
        decode: (Object? v0) => AdminCheckinEventList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Pindai QR tiket untuk event terpilih; check-in tercatat sekali beserta petugas (AC F09-5, F09-6).
  ///
  /// `qr_code` dicari persis di tickets.qr_code; tidak dikenal -> 404 NOT_FOUND ("QR bukan tiket KAPDH").
  /// Tiket dan event dibaca tanpa kunci, lalu pemeriksaan berurutan dijalankan; penolakan pertama yang cocok
  /// dikembalikan sebagai 409 dengan body Error baku (ARCHITECTURE §4.4, tanpa field tingkat atas tambahan) yang
  /// `current`-nya bertipe AdminCheckinRejectionDetail: `rejection_reason` yang dapat ditindaklanjuti, data tiket
  /// (`ticket`) dan jendela check-in efektif. `code` per alasan:
  /// 1. `other_event`: tiket milik event lain (nama event tiket ditampilkan) — VALIDATION_ERROR.
  /// 2. `event_cancelled`: event tiket dibatalkan; seluruh QR tidak berlaku (AC F09-7) — VALIDATION_ERROR.
  /// 3. `ticket_cancelled` — VALIDATION_ERROR; `ticket_expired` (termasuk hold kedaluwarsa menurut proyeksi
  ///    baca tag Events) — RESERVATION_EXPIRED; `ticket_awaiting_payment` / `ticket_awaiting_review`: pembayaran
  ///    belum diverifikasi, selesaikan antrean sebelum check-in (PRD 4.4) — PAYMENT_STATE_CONFLICT.
  /// 4. `already_checked_in`: scan kedua menampilkan waktu dan petugas check-in sebelumnya
  ///    (`current.ticket.checked_in_at`, `current.ticket.checked_in_by`) tanpa menambah hitungan (AC F09-5,
  ///    PRD 4.5) — TICKET_ALREADY_CHECKED_IN.
  /// 5. `holder_ineligible`: akun pemegang suspended, disabled, deletion_pending atau dihapus (PRD 2.2; alasan
  ///    privat tidak dibuka) — VALIDATION_ERROR. Anggota expired tetap boleh check-in dengan tiket paid.
  /// 6. `too_early` / `too_late`: di luar jendela check-in efektif (bawaan 2 jam sebelum mulai sampai selesai,
  ///    D5) atau event sudah done — VALIDATION_ERROR.
  /// Sukses: `UPDATE tickets SET checked_in_at, checked_in_by_admin_id WHERE id AND status='paid' AND
  /// checked_in_at IS NULL RETURNING` atomik bersama audit `ticket.checked_in` (AC F09-5). Pembatalan event atau
  /// tiket selalu mengubah status tiket dengan baris tiket terkunci, sehingga UPDATE ini menunggu kunci tersebut
  /// lalu menilai ulang syaratnya. Bila UPDATE mengenai NOL baris (tiket berubah sejak dibaca: scan paralel,
  /// pembatalan tiket/event, atau penolakan pembayaran), service membaca ulang tiket dan event lalu
  /// menjalankan ulang pemeriksaan 1 sampai 6 terhadap keadaan terbaru, sehingga petugas menerima alasan yang
  /// sesuai (`event_cancelled`, `ticket_cancelled`, atau `already_checked_in` beserta waktu dan petugas
  /// sebelumnya), bukan "sudah check-in" untuk tiket yang dibatalkan. Idempotency-Key yang sama mengembalikan
  /// hasil sukses pertama.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/checkin` (operationId `adminCheckInTicket`).
  Future<AdminCheckinResult> adminCheckInTicket(
    AdminCheckinRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCheckInTicket',
        method: 'POST',
        path: '/admin/checkin',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminCheckinResult.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
