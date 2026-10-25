// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Event, peserta, reservasi satu kursi, tiket QR dan pembatalan oleh anggota (F-09, PRD 3.9, PRD 4.4, D5, D6).
/// Aturan di bawah mengikat modul events, payments, account dan job; operasi merujuknya sebagai "aturan tag
/// Events".
///
/// Model (ARCHITECTURE §3.4):
/// - Status event draft, open, closed, done, cancelled; status tiket awaiting_payment, awaiting_review, paid,
///   expired, cancelled. Satu tiket aktif (awaiting_payment, awaiting_review, paid) per anggota per event, satu
///   kursi, hanya untuk dirinya sendiri; tidak ada jumlah tiket, tipe tiket, rombongan atau tamu (disahkan v3.2).
/// - Penghitung tersimpan `events.held_quantity` dan `events.paid_quantity` hanya diubah dalam transaksi yang
///   mengunci baris event; CHECK menjamin held + paid <= seats_total (AC F09-1).
/// - Draft tidak pernah terlihat oleh anggota (404 NOT_FOUND).
///
/// Proyeksi baca kursi dan hold (AC F09-1, F09-2):
/// - Hold kedaluwarsa adalah tiket `awaiting_payment` dengan `hold_expires_at <= now` yang belum dilepas secara
///   fisik oleh job expiry (tiap menit) atau oleh transaksi tulis berikutnya pada event itu.
/// - Semua respons BACA (anggota dan pengurus) memperlakukan hold kedaluwarsa sebagai sudah lepas: tiketnya
///   tampil `expired`, dan `seats_available = seats_total - paid_quantity - held_aktif`, dengan
///   `held_aktif = held_quantity - jumlah hold kedaluwarsa event itu`. `registration_state`, `can_reserve`,
///   `reservation_blocked_reason`, `held_quantity` dan `min_seats_total` pada respons pengurus memakai nilai yang
///   sama. Akibatnya tombol daftar tidak pernah tersembunyi oleh hold yang sudah habis, dan reservasi
///   berikutnya melepas hold tersebut secara fisik sebelum memeriksa kuota (createEventReservation langkah 1).
/// - Operasi baca tidak pernah menulis; pelepasan fisik selalu dalam transaksi tulis yang mengunci event.
///
/// Urutan kunci global (PRD 6.4 "mengunci tiket/event dalam urutan konsisten"), berlaku bagi setiap transaksi
/// yang menyentuh event, tiket atau payment tiket:
/// - Urutan: (1) baris events, (2) baris tickets urut id naik, (3) baris payments urut id naik;
///   payment_adjustments hanya disisipkan sesudahnya.
/// - Transaksi boleh melewati tingkat yang tidak dibutuhkan, tetapi tidak pernah mengunci tingkat yang lebih awal
///   sesudah memegang kunci tingkat yang lebih akhir.
/// - Id yang diperoleh dari baris lain (`tickets.event_id`, `payments.ticket_id`; keduanya tidak pernah berubah)
///   dibaca TANPA kunci lebih dahulu, lalu baris dikunci menurut urutan ini dan statusnya diperiksa ulang
///   sesudah kunci didapat.
/// - Penerapan: createEventReservation dan job expiry hold mengunci event, tiket hold kedaluwarsa (urut id), lalu
///   payment-nya. cancelMyTicket dan adminCancelTicket mengunci event, tiket, lalu payment tiket.
///   adminCancelEvent mengunci event, semua tiket aktif event termasuk hold kedaluwarsa (satu langkah, urut id),
///   lalu payment tiket tersebut (urut id).
///   adminUpdateEvent dan adminSetEventStatus mengunci event (adminUpdateEvent yang menurunkan kuota juga
///   melepas hold kedaluwarsa: event, tiket, payment). adminCheckInTicket hanya memakai UPDATE bersyarat pada
///   satu tiket. Penghapusan akun (F-14, "tiket hangus") mengunci per event: event, tiket, payment. Job
///   pengingat H-3/H-1 mengunci event `FOR SHARE` (tanpa mengunci tiket) lalu membaca ulang status, jadwal dan
///   pemegang paid, sehingga pengingat tidak pernah ditulis untuk jadwal usang atau event/tiket yang baru
///   dibatalkan (AC F13-6).
/// - Modul pembayaran untuk payment `type=ticket` (kirim bukti, approve, reject, batal): handler tiket mengunci
///   event lalu tiket SEBELUM modul pembayaran menjalankan `SELECT payments ... FOR UPDATE` (kirim bukti cukup
///   mengunci tiket karena penghitung kursi tidak berubah). Ini memerlukan hook PaymentTypeHandler yang dipanggil
///   sebelum kunci payment (ARCHITECTURE §4.6, perubahan bersama C5); onApproved dan onRejected tidak boleh
///   mengunci event atau tiket sesudah payment terkunci.
///
/// Payment tiket di modul pembayaran (pemilik C3; aturan galat persis mengikuti submitPaymentProof dan
/// adminDecidePayment, ringkasannya di sini):
/// - Bukti dikirim lewat PUT /me/payments/{paymentId}/proof memakai `payment.id` dari tiket. Bukti sebelum
///   `hold_expires_at` memindahkan tiket ke awaiting_review dan kursi tetap ditahan sampai keputusan.
/// - Tiket expired atau hold sudah lewat (termasuk payment yang sudah dibatalkan sistem karena hold habis):
///   409 RESERVATION_EXPIRED dengan `current` = PaymentDetail (status HTTP sama dengan submitPaymentProof dan
///   createEventReservation). Tiket cancelled atau payment tiket rejected: 409 PAYMENT_STATE_CONFLICT dengan
///   `current` = PaymentDetail (AC F09-2, F09-4).
/// - Keputusan pengurus: approve membuat tiket paid, held menjadi paid dan QR diterbitkan (AC F04-1); reject
///   bersifat final, tiket cancelled dan hold dilepas (AC F09-4).
/// - Payment berbukti yang tiketnya sudah dibatalkan (event dibatalkan): approve membuat payment paid dan refund
///   penuh otomatis (payment_adjustment pending, tenggat 7 hari kerja, D6), tiket tetap cancelled dan penghitung
///   kursi tidak berubah; reject tidak membuat refund dan tidak melepas kursi kedua kalinya.
///
/// Akses dan tautan:
/// - Akses anggota (PRD 2.2, ARCHITECTURE §3.1): daftar event dan kategori hanya untuk anggota aktif
///   (verified/expiring); anggota expired tetap membuka tiketnya (/me/tickets) dan detail event yang pernah ia
///   pesan.
/// - Deep link notifikasi kategori `event` (ARCHITECTURE §4.7): `/events/<eventId>` dan `/tickets/<ticketId>`.
///
///
/// Kelas API untuk tag kontrak "Events". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class EventsApi {
  const EventsApi(this._dio);

  final Dio _dio;

  /// Kategori event aktif untuk tab daftar event (F-09, guideline p8).
  ///
  /// Kategori `kind=event` yang aktif, urut `sort_order` lalu label. Tab "Semua" dibuat klien (tanpa filter).
  /// Pengelolaan kategori ada di web admin (Manajemen Kategori). Hanya anggota aktif, sama dengan daftar event
  /// (PRD 2.2).
  ///
  /// `GET /event-categories` (operationId `listEventCategories`).
  Future<EventCategoryList> listEventCategories({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listEventCategories',
        method: 'GET',
        path: '/event-categories',
        authRequired: true,
        decode: (Object? v0) => EventCategoryList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar event untuk anggota, per kategori, mendatang/lampau dan pencarian (F-09, guideline p8).
  ///
  /// Hanya event berstatus open, closed, done atau cancelled (draft tidak pernah tampil).
  /// - `period=upcoming` (bawaan): `ends_at > now` dan status bukan done; urut `starts_at` naik lalu `id`.
  ///   Event yang dibatalkan tetap tampil dengan `registration_state=cancelled` agar peserta mengetahuinya.
  /// - `period=past`: `ends_at <= now` atau status done; urut `starts_at` turun lalu `id`.
  /// - `q` mencari judul atau nama lokasi (tanpa membedakan huruf besar/kecil).
  /// Kartu memuat cover, kategori, judul, tanggal dan label pendaftaran (`registration_state`) yang dihitung
  /// server (PRD 2.1: tampilkan dalam `timezone` event). Hanya anggota aktif (verified/expiring): daftar akses
  /// unverified dan expired pada PRD 2.2 tidak memuat informasi event, dan klien mengarahkan keduanya ke
  /// onboarding/perpanjangan (routeForStatus). Anggota expired tetap melihat tiketnya lewat GET /me/tickets dan
  /// detail event yang pernah ia pesan lewat GET /events/{eventId}.
  ///
  /// [categoryId]: Filter kategori (id dari GET /event-categories). Kosong = semua kategori.
  /// [period]: Mendatang (bawaan) atau lampau.
  /// [q]: Kata kunci judul atau nama lokasi.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /events` (operationId `listEvents`).
  Future<EventPage> listEvents({
    String? categoryId,
    EventListPeriod? period,
    String? q,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listEvents',
        method: 'GET',
        path: '/events',
        authRequired: true,
        queryParameters: <String, Object?>{
          'category_id': ?categoryId,
          if (period case final v?) 'period': v.toJson(),
          'q': ?q,
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => EventPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail event, kuota, jendela pendaftaran/check-in, aturan pembatalan dan tiket saya (F-09, PRD 3.9).
  ///
  /// Memuat deskripsi, lokasi, zona waktu, jadwal, harga, kuota (`seats_available`/`seats_total`, mis.
  /// "20/36 Kuota Peserta"), jendela pendaftaran, jendela check-in efektif (D5: 2 jam sebelum mulai sampai
  /// selesai kecuali event menetapkan jendela lain), aturan pembatalan dan refund (D6), serta ringkasan tiket
  /// terbaru milik pemanggil (`my_ticket`). `can_reserve` dan `reservation_blocked_reason` dihitung server untuk
  /// pemanggil; klien tidak menghitung sendiri. Event cancelled tetap dapat dibuka (deep link notifikasi,
  /// AC F09-7) beserta alasan pembatalan. Draft atau id tidak dikenal menghasilkan 404.
  /// Akses: anggota aktif (verified/expiring) membuka event apa pun yang terbit. Anggota nonaktif yang tidak
  /// suspended (unverified/expired) hanya membuka event yang ia punya tiketnya (status apa pun), karena tiket
  /// paid tetap berlaku untuk check-in dan riwayat sendiri tetap boleh dilihat (PRD 2.2); untuk event lain
  /// server menjawab 403 MEMBERSHIP_REQUIRED tanpa membedakan event ada atau tidak (N-09). Pada respons untuk
  /// anggota nonaktif, `can_reserve=false` dan `reservation_blocked_reason=membership_required`. Pemeriksaan ini
  /// dilakukan di service; dekorator memakai `nonsuspended` agar pengecualian tersebut dapat dijalankan.
  ///
  /// `GET /events/{eventId}` (operationId `getEvent`).
  Future<EventDetail> getEvent(
    String eventId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getEvent',
        method: 'GET',
        path: '/events/${Uri.encodeComponent(eventId)}',
        authRequired: true,
        decode: (Object? v0) => EventDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Peserta terkonfirmasi yang terlihat di direktori (F-09, F-10 privasi, guideline p8).
  ///
  /// Hanya pemegang tiket `paid` yang juga tampil di direktori: effective_status verified/expiring, tidak
  /// suspended, `show_in_directory=true`, dan tidak saling memblokir dengan pemanggil (PRD 3.10, AC F10-2).
  /// Peserta lain dihilangkan dari payload (bukan disamarkan). Hanya nama, angkatan dan avatar; email, telepon dan
  /// tautan sosial tidak pernah dikirim. Urut nama lalu `user_id`. Akses sama dengan direktori: hanya anggota
  /// aktif (AC F10-3).
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /events/{eventId}/participants` (operationId `listEventParticipants`).
  Future<EventParticipantPage> listEventParticipants(
    String eventId, {
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listEventParticipants',
        method: 'GET',
        path: '/events/${Uri.encodeComponent(eventId)}/participants',
        authRequired: true,
        queryParameters: <String, Object?>{
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => EventParticipantPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar event, satu kursi untuk diri sendiri; event gratis langsung paid (AC F09-1, F09-3, D5).
  ///
  /// Hanya anggota aktif (verified/expiring). Dijalankan dalam SATU transaksi yang lebih dahulu mengunci baris
  /// event (`SELECT ... FOR UPDATE`), mengikuti urutan kunci global event -> tiket -> payment (aturan tag Events):
  /// 1. Hold yang sudah lewat `hold_expires_at` pada event ini dilepas lebih dahulu (AC F09-2, "request
  ///    berikutnya"): tiket tersebut dikunci urut id lalu payment pending-nya; tiket -> expired, payment ->
  ///    cancelled, held_quantity dikurangi tepat sekali (UPDATE bersyarat `status='awaiting_payment'`). Sesudah
  ///    langkah ini penghitung tersimpan sama dengan proyeksi baca (aturan tag Events), sehingga kuota yang
  ///    ditampilkan GET /events/{eventId} juga yang dipakai langkah 4.
  /// 2. Event wajib `open` dan `registration_opens_at <= now < registration_closes_at`; selain itu
  ///    409 RESERVATION_EXPIRED (`registration_state` pada `current` menjelaskan sebabnya).
  /// 3. Pemanggil sudah punya tiket aktif (awaiting_payment, awaiting_review, paid) di event ini, misalnya
  ///    ketukan ganda dengan Idempotency-Key berbeda (PRD 9.2): 409 VERSION_CONFLICT. `current.my_ticket` menunjuk
  ///    tiket aktif itu dan `current.reservation_blocked_reason = has_active_ticket`, sehingga klien yang memuat
  ///    ulang detail event langsung menampilkan tombol buka tiket. Indeks unik parsial
  ///    tickets_user_id_event_id_active_key menjadi penjaga terakhir untuk request paralel.
  /// 4. `seats_available = 0`: 409 EVENT_SOLD_OUT. Request paralel tidak pernah membuat held + paid melebihi
  ///    seats_total; transaksi gagal tidak meninggalkan hold (AC F09-1).
  /// 5. `expected_price` wajib sama dengan `price` event saat ini (harga yang dikonfirmasi anggota pada layar
  ///    Detail Tiket, guideline p8). Bila pengurus mengubah harga di antara tampilan dan kirim: 409
  ///    VERSION_CONFLICT dan tidak ada hold yang dibuat; klien menampilkan harga baru dari `current` dan meminta
  ///    konfirmasi ulang (PRD 4.4, PRD 4.5).
  /// 6. Event berbayar (`price > 0`): `payment_method_id` wajib dan harus metode aktif; event gratis: field ini
  ///    wajib kosong. Pelanggaran: 400 VALIDATION_ERROR (`field_errors.payment_method_id`).
  /// Setiap 409 bisnis operasi ini (langkah 2 sampai 5) membawa `current` dengan SATU bentuk: EventDetail
  /// terbaru untuk pemanggil, dihitung sesudah langkah 1 (PRD 4.5 "muat ulang data terbaru").
  /// Hasil event berbayar: tiket `awaiting_payment`, `total = price` saat ini (snapshot; perubahan harga tidak
  /// mengubah tiket ini, PRD 4.4), `hold_expires_at = min(now + hold_hours, registration_closes_at)` (D5),
  /// held_quantity +1, dan payment `type=ticket` pending (nominal dan metode disnapshot) yang dirujuk
  /// `payment.id`. Klien lalu mengunggah bukti (POST /files purpose payment_proof, kemudian
  /// PUT /me/payments/{paymentId}/proof) sebelum `hold_expires_at`; bukti tepat waktu memindahkan tiket ke
  /// awaiting_review dan kursi tetap ditahan sampai keputusan. Bukti sesudah hold lewat ditolak submitPaymentProof
  /// dengan 409 RESERVATION_EXPIRED (AC F09-2; aturan lengkap payment tiket di tag Events). Keputusan pengurus di
  /// antrean pembayaran: approve -> tiket paid, held menjadi paid, QR diterbitkan (AC F04-1); reject -> payment
  /// rejected final, tiket cancelled dan hold dilepas (AC F09-4).
  /// Hasil event gratis: tiket langsung `paid` dengan total 0.00, QR diterbitkan, paid_quantity +1, tanpa
  /// payment (AC F09-3).
  /// Tiket expired/cancelled sebelumnya tidak menghalangi: pendaftaran ulang selalu membuat tiket dan payment
  /// baru; bukti tidak menghidupkan tiket lama (AC F09-4, PRD 6.4).
  /// Audit `ticket.reserved` ditulis dalam transaksi yang sama (F-17). Ulangi dengan Idempotency-Key yang sama
  /// setelah jaringan putus; hasil pertama dikembalikan (PRD 4.3).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /events/{eventId}/reservations` (operationId `createEventReservation`).
  Future<TicketDetail> createEventReservation(
    String eventId,
    EventReservationRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'createEventReservation',
        method: 'POST',
        path: '/events/${Uri.encodeComponent(eventId)}/reservations',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => TicketDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tiket milik sendiri, aktif atau riwayat (F-09, PRD 2.2, PRD 4.4).
  ///
  /// - `view=active` (bawaan): tiket awaiting_payment, awaiting_review atau paid untuk event yang belum berakhir
  ///   dan tidak dibatalkan; urut `starts_at` event naik lalu id tiket.
  /// - `view=history`: tiket lainnya (expired, cancelled, event selesai/dibatalkan); urut `created_at` turun.
  /// Anggota expired tetap melihat dan memakai tiket paid (PRD 2.2). Tiket awaiting_payment yang hold-nya sudah
  /// lewat dikembalikan sebagai expired (masuk `view=history`) walaupun job expiry belum berjalan; ini proyeksi
  /// baca tanpa penulisan, pelepasan fisik tetap tepat sekali oleh job atau transaksi tulis berikutnya (aturan tag
  /// Events, AC F09-2).
  ///
  /// [view]: Tiket aktif (bawaan) atau riwayat.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /me/tickets` (operationId `listMyTickets`).
  Future<TicketPage> listMyTickets({
    TicketListView? view,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listMyTickets',
        method: 'GET',
        path: '/me/tickets',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (view case final v?) 'view': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => TicketPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail tiket sendiri, hitung mundur hold, pembayaran, QR dan kelayakan pembatalan (F-09, PRD 4.4).
  ///
  /// `qr_code` hanya terisi bila tiket `paid` dan event tidak cancelled (AC F09-7); selain itu null. Anggota
  /// expired tetap memperoleh QR tiket paid (PRD 2.2); anggota suspended tidak dapat membuka endpoint ini dan
  /// tiketnya ditolak saat check-in. `hold_expires_at` dipakai untuk hitung mundur awaiting_payment; hold yang
  /// sudah lewat tampil expired (proyeksi baca, aturan tag Events). `payment` menunjuk payment tiket untuk unggah
  /// bukti lewat API pembayaran. `refunds` memuat refund yang tercatat atas payment tiket (D6). Tiket milik
  /// pengguna lain menghasilkan 404 (N-09).
  ///
  /// `GET /me/tickets/{ticketId}` (operationId `getMyTicket`).
  Future<TicketDetail> getMyTicket(
    String ticketId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMyTicket',
        method: 'GET',
        path: '/me/tickets/${Uri.encodeComponent(ticketId)}',
        authRequired: true,
        decode: (Object? v0) => TicketDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan tiket sendiri; refund penuh bila tiket berbayar dibatalkan sampai H-3 (D6, PRD 3.9).
  ///
  /// Boleh untuk tiket `awaiting_payment` atau `paid` yang belum check-in, selama event belum dimulai
  /// (`now < starts_at`) dan tidak cancelled. Dalam satu transaksi mengikuti urutan kunci global: `event_id` tiket
  /// dibaca tanpa kunci, lalu baris event dikunci, kemudian tiket dan payment-nya; kepemilikan, status, versi dan
  /// kelayakan refund diperiksa ulang sesudah kunci didapat:
  /// - awaiting_payment: tiket cancelled (`cancelled_by=self`), hold dilepas, payment pending dibatalkan.
  /// - paid: tiket cancelled, QR tidak berlaku, paid_quantity -1. Payment tetap `paid` (tidak pernah diubah).
  ///   Bila `total > 0` dan `now < full_refund_until` (starts_at dikurangi `self_cancel_days` = 3 hari kalender
  ///   dalam zona waktu event, "H-3"), dibuat payment_adjustment refund pending sebesar total dengan tenggat
  ///   7 hari kerja (D6); sesudah batas itu pembatalan tetap boleh tetapi tanpa refund. Event gratis tidak
  ///   memiliki refund; pembatalan melepas kursi.
  /// - awaiting_review: ditolak 409 PAYMENT_STATE_CONFLICT karena bukti sedang ditinjau dan dana mungkin sudah
  ///   ditransfer (PRD 4.3: pemilik hanya membatalkan sebelum bukti); tunggu keputusan atau hubungi pengurus.
  /// `expected_refund_eligible` wajib sama dengan `refund_eligible` yang ditampilkan; bila batas H-3 terlewati
  /// di antara tampilan dan kirim, server menolak 409 VERSION_CONFLICT dengan `current` = TicketDetail terbaru
  /// sehingga anggota tidak kehilangan refund tanpa sadar. Versi tiket (If-Match) yang berubah atau tiket yang
  /// tidak lagi dapat dibatalkan juga menghasilkan 409 VERSION_CONFLICT dengan `current`. Audit
  /// `ticket.cancelled` ditulis dalam transaksi yang sama (F-17). Rekening tujuan refund diminta saat proses
  /// refund oleh bendahara, bukan di sini (D6, D2).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /me/tickets/{ticketId}/cancel` (operationId `cancelMyTicket`).
  Future<TicketDetail> cancelMyTicket(
    String ticketId,
    TicketCancelRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'cancelMyTicket',
        method: 'POST',
        path: '/me/tickets/${Uri.encodeComponent(ticketId)}/cancel',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => TicketDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
