// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Antrean verifikasi, keputusan pembayaran, pencatatan iuran yang diverifikasi di luar aplikasi, penyesuaian
/// refund/koreksi dan metode bayar oleh pengurus (F-04, F-15, D6, D13).
///
///
/// Kelas API untuk tag kontrak "Admin Payments". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminPaymentsApi {
  const AdminPaymentsApi(this._dio);

  final Dio _dio;

  /// Antrean dan daftar pembayaran (payments.read, F-04).
  ///
  /// Tabel server-side (F-15) untuk tab Verifikasi Pembayaran (prototipe screen_8, guidelines p17). Kolom:
  /// dikirim (`submitted_at`), alumni (nama, nomor anggota, angkatan; "Akun dihapus" bila `member` null), jenis
  /// (tiket menampilkan `event_title` dan `event_starts_at`, serta penanda `ticket_status` dan `event_cancelled`
  /// agar pemutus tahu tiket/event sudah dibatalkan sebelum membuka detail, PRD 4.4), nominal, usia antrean
  /// (dihitung klien dari `submitted_at`; `overdue` dari server) dan status.
  ///
  /// Pilihan Status di UI (prototipe screen_8) dipetakan ke filter berikut:
  /// - "Menunggu" (tampilan bawaan) = `stage=awaiting_review`: pending yang sudah berbukti dan siap diputus.
  ///   `total`-nya sama dengan `awaiting_review_count` pada GET /admin/payments/summary (pill emas menu). Jangan
  ///   memakai `status=pending`, karena filter itu ikut memuat instruksi tanpa bukti (awaiting_transfer) yang
  ///   belum dapat diputus.
  /// - "Disetujui" = `status=paid`; "Ditolak" = `status=rejected`; "Semua" = tanpa `status` dan tanpa `stage`.
  ///
  /// Filter lain: `type`, `q` (nama atau nomor anggota), `overdue`, `event_id`, `user_id`, rentang
  /// `submitted_from`/`submitted_to`. Urutan bawaan `submitted_at_asc` (paling lama menunggu di atas); payment
  /// tanpa bukti diletakkan di akhir. `total` menghitung seluruh hasil filter.
  ///
  /// Batas review (`review_due_at`) berlaku untuk payment pending berbukti; hari kerja dihitung Senin sampai
  /// Jumat waktu Asia/Jakarta:
  /// - iuran: `submitted_at` + 1 hari kerja (prototipe screen_8 "Lewat 1 hari kerja", usulan PRD 1.6);
  /// - tiket: yang lebih dahulu antara `submitted_at` + `events.review_escalation_business_days` (2 hari kerja,
  ///   D5) dan pembukaan jendela check-in event (`checkin_opens_at` event, atau `starts_at` dikurangi
  ///   `events.checkin_before_hours`), karena pembayaran tiket wajib diputus sebelum check-in (PRD 4.4).
  /// `overdue` true bila waktu server sudah melewati `review_due_at`. Antrean tiket yang lewat batas dieskalasi,
  /// tidak dibatalkan otomatis (PRD 3.9). Urutan `review_due_at_asc` menaikkan tiket event yang mendekati hari H
  /// ke atas antrean.
  ///
  /// [status]: Status payment; kosong berarti semua status ("Semua").
  /// [stage]: Tahap payment; awaiting_review = antrean siap diputus (pilihan "Menunggu", bawaan UI).
  /// [type]: Jenis pembayaran; kosong berarti semua jenis.
  /// [q]: Cari nama alumni (sebagian, tanpa beda huruf besar) atau nomor anggota (awalan).
  /// [overdue]: true hanya yang lewat batas review; false hanya yang belum.
  /// [eventId]: Hanya payment tiket untuk event ini.
  /// [userId]: Hanya payment milik anggota ini (riwayat pada detail anggota).
  /// [submittedFrom]: Batas bawah inklusif `submitted_at` (UTC).
  /// [submittedTo]: Batas atas eksklusif `submitted_at` (UTC).
  /// [sort]: Urutan hasil (bawaan submitted_at_asc).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/payments` (operationId `adminListPayments`).
  Future<AdminPaymentPage> adminListPayments({
    PaymentStatus? status,
    PaymentStage? stage,
    PaymentType? type,
    String? q,
    bool? overdue,
    String? eventId,
    String? userId,
    DateTime? submittedFrom,
    DateTime? submittedTo,
    AdminPaymentSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPayments',
        method: 'GET',
        path: '/admin/payments',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          if (stage case final v?) 'stage': v.toJson(),
          if (type case final v?) 'type': v.toJson(),
          'q': ?q,
          'overdue': ?overdue,
          'event_id': ?eventId,
          'user_id': ?userId,
          if (submittedFrom case final v?) 'submitted_from': encodeDateTime(v),
          if (submittedTo case final v?) 'submitted_to': encodeDateTime(v),
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminPaymentPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Catat iuran yang dananya diverifikasi di luar aplikasi dan aktifkan keanggotaan (payments.decide, D13).
  ///
  /// Rencana cadangan D13 (PRD 10.1, 10.2): bila instruksi bayar iuran disembunyikan di suatu platform
  /// (pengaturan `payment_instructions`, PUT /admin/settings/payment-instructions; misalnya iOS bila review
  /// Apple menolak), anggota membayar iuran keanggotaan organisasi langsung kepada pengurus, lalu pengurus
  /// mencatatnya di sini setelah dana dicocokkan dengan mutasi rekening tujuan. Operasi yang sama dipakai bila
  /// anggota tidak dapat memakai alur aplikasi. Hanya untuk iuran (registration/renewal); tiket tetap melalui
  /// reservasi event (F-09).
  ///
  /// Prasyarat:
  /// - `funds_verified` true (PRD 3.4) dan `reason` berisi catatan verifikasi (misalnya tanggal dan rekening
  ///   mutasi).
  /// - `user_id` adalah akun alumni yang tidak dihapus dan tidak disuspend. Kelayakannya sama dengan instruksi
  ///   anggota (GET /me/fees): registration hanya bila iuran pendaftaran belum pernah paid; renewal hanya bila
  ///   status efektif expiring atau expired (AC F07-5).
  /// - `payment_method_id` adalah rekening organisasi tempat dana diterima (aktif atau nonaktif); disnapshot.
  /// - `proof_file_id` adalah berkas purpose payment_proof yang diunggah pengurus pemanggil sebagai bukti
  ///   verifikasi (tangkapan mutasi atau bukti transfer yang dikirim anggota lewat kanal dukungan). Berkas
  ///   privat dan dibuka lewat GET /files/{fileId}/access oleh pengurus berizin payments.read; TIDAK pernah
  ///   dibuka kepada anggota (`proof_file_id` dan `transfer_note` tidak dikirim pada respons anggota, N-09).
  ///   Unggah potongan yang hanya memuat transaksi anggota ini; transaksi pihak lain pada mutasi ditutup.
  /// - Pemanggil tidak berkonflik kepentingan (PRD 2.3).
  ///
  /// Semua langkah berikut terjadi dalam SATU transaksi. Urutan kunci (payments.yaml): baris users lalu alumni
  /// pemilik, kemudian payment terbuka jenis yang sama (FOR UPDATE) bila ada; lock akun mencegah suspend atau
  /// penghapusan akun bersamaan di tengah proses. Hasilnya bergantung pada payment terbuka jenis yang sama
  /// (indeks `payments_user_id_type_open_key`):
  /// - Tidak ada: payment baru dihitung dari pengaturan `fees` versi aktif (snapshot baris, metode dan
  ///   `settings_version`, AC F03-5; nominal tidak pernah dikirim klien), bukti versi 1, lalu langsung paid
  ///   dengan histori created, proof_submitted dan approved beraktor admin. Respons 201.
  /// - Ada dengan stage awaiting_transfer (pending tanpa bukti) atau needs_fix (iuran rejected): payment itu
  ///   DISELESAIKAN DI TEMPAT agar anggota yang tidak dapat memakai alur aplikasi (misalnya instruksi iuran
  ///   disembunyikan di iOS) tidak terkunci oleh payment lamanya. Snapshot baris dan nominal tetap (AC F03-5);
  ///   snapshot metode diganti ke `payment_method_id` bila berbeda (histori method_changed beraktor admin);
  ///   bukti pengurus menjadi versi berikutnya (proof_submitted, atau proof_replaced dengan alasan penolakan
  ///   lama tetap di histori, AC F03-3); lalu paid dengan histori approved beraktor admin. Untuk iuran rejected
  ///   ini adalah transisi rejected -> pending -> paid oleh pengurus dalam satu transaksi, perluasan PRD 4.3
  ///   yang hanya tersedia lewat operasi ini (rencana cadangan D13; diajukan sebagai change request PRD 4.3
  ///   kepada pemilik produk) dan diaudit. Respons 200.
  /// - Ada dengan stage awaiting_review (pending berbukti dari anggota): 409 PAYMENT_STATE_CONFLICT dengan
  ///   `current`; pengurus memutus bukti anggota itu lewat adminDecidePayment.
  /// Setelah paid: handler keanggotaan menghitung periode seperti keputusan biasa (registration dari
  /// approved_at, renewal dari max(expires_at lama, approved_at)); audit, notifikasi in-app kategori payment
  /// dengan deep link `/payments/{paymentId}`, dan outbox (AC F04-1, F13-1). Kegagalan email/push tidak
  /// membatalkan pencatatan (AC F04-5).
  ///
  /// Galat:
  /// - 400 VALIDATION_ERROR: `funds_verified` bukan true; metode tidak ada (field_errors.payment_method_id);
  ///   akun tidak ada, bukan alumni, sudah dihapus atau deletion_pending, atau disuspend
  ///   (field_errors.user_id); renewal di luar jendela perpanjangan atau sebelum iuran pendaftaran paid
  ///   (field_errors.type).
  /// - 403 FORBIDDEN: tanpa izin payments.decide atau berkonflik kepentingan; atau (payment baru) nominal iuran
  ///   belum ditetapkan: pengaturan `fees` belum tersimpan (versi 0) atau total jenis iuran itu 0.00 (gagal
  ///   tertutup, PRD 8.2 butir 4, 9.3). Tidak ada payment yang dibuat dan bukti pengurus tidak terlampir.
  /// - 409 PAYMENT_STATE_CONFLICT: registration padahal iuran pendaftaran sudah paid; atau payment terbuka jenis
  ///   yang sama sudah berbukti dari anggota (awaiting_review), dengan `current` berisi AdminPaymentDetail
  ///   payment itu untuk diputus lewat adminDecidePayment.
  /// - 409 IDEMPOTENCY_CONFLICT: Idempotency-Key sama dengan payload berbeda. Pengulangan dengan key dan payload
  ///   sama mengembalikan hasil pertama tanpa membuat atau menyelesaikan payment kedua kali.
  /// - 422 FILE_INVALID: berkas tidak ada, bukan purpose payment_proof, bukan unggahan pemanggil, belum siap,
  ///   atau sudah terpakai.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payments` (operationId `adminRecordPayment`).
  Future<AdminPaymentDetail> adminRecordPayment(
    AdminRecordPaymentRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminRecordPayment',
        method: 'POST',
        path: '/admin/payments',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ringkasan antrean untuk badge menu dan dasbor (payments.read, F-04, F-15).
  ///
  /// Hitungan saat ini: antrean siap diputus (pill emas menu "Verifikasi Pembayaran", prototipe screen_8),
  /// yang lewat batas review, menunggu transfer, per jenis, serta penyesuaian pending dan lewat tenggat (D6).
  ///
  /// `GET /admin/payments/summary` (operationId `adminGetPaymentSummary`).
  Future<AdminPaymentSummary> adminGetPaymentSummary({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPaymentSummary',
        method: 'GET',
        path: '/admin/payments/summary',
        authRequired: true,
        decode: (Object? v0) => AdminPaymentSummary.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail pembayaran untuk keputusan pengurus (payments.read, F-04, AC F04-4).
  ///
  /// Memuat bukti versi aktif (berkas privat dibuka lewat GET /files/{fileId}/access, URL <= 10 menit),
  /// versi bukti dan `version` untuk keputusan, snapshot baris dan rekening tujuan, catatan transfer, histori
  /// lengkap termasuk alasan penolakan sebelumnya dan berkas bukti versi lama (U-02), penyesuaian, serta flag
  /// `conflict_of_interest`. Isi bukti tidak pernah dicatat di log atau audit (ARCHITECTURE §2 butir 3).
  ///
  /// [paymentId]: ID payment (UUID v7).
  ///
  /// `GET /admin/payments/{paymentId}` (operationId `adminGetPayment`).
  Future<AdminPaymentDetail> adminGetPayment(
    String paymentId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPayment',
        method: 'GET',
        path: '/admin/payments/${Uri.encodeComponent(paymentId)}',
        authRequired: true,
        decode: (Object? v0) => AdminPaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Setujui atau tolak payment; satu keputusan berlaku (payments.decide, AC F04-1 sampai F04-5).
  ///
  /// Prasyarat: payment pending dengan bukti (proof_version >= 1), `expected_proof_version` dan
  /// `expected_version` sama dengan nilai terbaru, dan pemanggil tidak berkonflik kepentingan (PRD 2.3).
  /// Dari dua keputusan bersamaan hanya satu berlaku (AC F04-3).
  ///
  /// Kunci (URUTAN KUNCI di kepala payments.yaml, PRD 6.4): `type`, `user_id` dan `ticket_id` dibaca tanpa
  /// kunci; hook pra-kunci handler jenis mengunci baris terkait LEBIH DAHULU (tiket: event lalu tiket;
  /// iuran: users lalu alumni pemilik bila masih ada); baru kemudian `SELECT payments … FOR UPDATE`, lalu status,
  /// versi, `ticket_id` dan `user_id` diperiksa ulang. onApproved/onRejected tidak mengunci event, tiket, users
  /// atau alumni setelah payment terkunci, sehingga keputusan tidak deadlock dengan adminCancelEvent,
  /// cancelMyTicket, job expiry, suspend maupun penghapusan akun.
  ///
  /// - approve: wajib `funds_verified` true, artinya dana sudah dicocokkan dengan mutasi rekening tujuan, bukan
  ///   sekadar bukti terlihat meyakinkan (PRD 3.4). Dalam SATU transaksi: payment paid, payment_event approved,
  ///   handler jenis (periode keanggotaan registration/renewal dari approved_at atau max(expires_at lama,
  ///   approved_at), atau tiket paid + QR), audit, notifikasi in-app dan outbox (AC F04-1, F13-1). Persetujuan
  ///   untuk anggota suspended memperbarui periode tetapi status efektif tetap suspended (AC F07-4). Kegagalan
  ///   email/push tidak membatalkan keputusan; worker mengulang tanpa memperpanjang dua kali (AC F04-5).
  /// - reject: wajib `reason` tidak kosong dan tidak hanya spasi (AC F04-2); alasan terlihat oleh pemilik dan
  ///   pengurus berizin. Iuran dapat diperbaiki pemilik pada payment yang sama (AC F03-3); tiket menjadi
  ///   cancelled dan hold dilepas (AC F09-4).
  ///
  /// Tiket yang sudah cancelled sebelum keputusan (misalnya event dibatalkan pengurus atau peserta membatalkan
  /// sendiri, PRD 3.9 dan 4.4; terlihat dari `ticket.ticket_status`): payment pending berbukti tetap wajib
  /// diputus, karena dana mungkin sudah ditransfer dan pembatalan tidak berarti dana sudah dikembalikan.
  /// - approve berarti dana diterima. Payment menjadi paid, tetapi tiket tidak dihidupkan kembali dan QR tidak
  ///   diterbitkan; handler tiket tidak menolak keputusan ini. Bila tabel D6 mewajibkan refund penuh (event
  ///   dibatalkan, atau pembatalan mandiri sampai H-3; ditampilkan lebih dahulu sebagai `refund_on_approve`),
  ///   penyesuaian refund sistem dibuat dalam transaksi yang sama: `created_by` null, nominal penuh, `due_at`
  ///   7 hari kerja sejak pembatalan tiket, dan pemilik diberi notifikasi permintaan rekening tujuan (lihat
  ///   adminCreatePaymentAdjustment). Penyesuaian ini tampil di `adjustments` respons. Kasus lain (pemegang
  ///   tiket disuspend, tiket dibatalkan pengurus, tiket hangus karena akun dihapus) diputuskan pengurus per
  ///   kasus lewat POST /admin/payments/{paymentId}/adjustments.
  /// - reject berarti dana tidak ditemukan di rekening tujuan; tiket tetap cancelled, kursi tidak dilepas kedua
  ///   kalinya, dan tidak ada refund.
  ///
  /// Akun pemilik sudah dihapus (`member` null; F-14, PRD 4.4, D2): payment pending berbukti tidak dibatalkan
  /// job penghapusan dan tetap wajib diputus. Berkas bukti dan `transfer_note` sudah dihapus (AC F14-4), sehingga
  /// `proof` null walaupun proof_version >= 1; pengurus mencocokkan nominal, tanggal dan referensi payment dengan
  /// mutasi rekening tujuan (`funds_verified`).
  /// - approve: payment paid tanpa efek keanggotaan (tidak ada membership_event; akun tidak dapat diaktifkan)
  ///   dan tanpa efek tiket (tiket sudah hangus, D6 "Akun dihapus"). Penghapusan akun tidak berarti dana sudah
  ///   dikembalikan, dan tidak ada refund otomatis: bendahara mencatat penyelesaian keuangan tersendiri
  ///   (PRD 4.4) lewat POST /admin/payments/{paymentId}/adjustments, yaitu refund ke rekening pengirim yang
  ///   terlihat di mutasi atau koreksi yang mencatat dana tidak dikembalikan beserta alasannya
  ///   (`actions.can_adjust` true).
  /// - reject: payment rejected; iuran rejected tanpa pemilik tidak dapat dikirim ulang dan tidak menghalangi
  ///   apa pun.
  /// Tidak ada notifikasi karena pemilik sudah tidak ada.
  ///
  /// Notifikasi kategori payment ke pemilik dengan deep link `/payments/{paymentId}` (ARCHITECTURE §4.7).
  /// Galat 409 membawa `current` berisi AdminPaymentDetail terbaru dan diperiksa berurutan:
  /// PAYMENT_STATE_CONFLICT (bukan pending atau belum ada bukti), PROOF_VERSION_CONFLICT (bukti diganti
  /// setelah layar dibuka, AC F04-4), VERSION_CONFLICT. 403 FORBIDDEN bila tanpa izin atau berkonflik
  /// kepentingan. Pengulangan dengan Idempotency-Key dan payload sama mengembalikan hasil pertama.
  ///
  /// [paymentId]: ID payment (UUID v7).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payments/{paymentId}/decision` (operationId `adminDecidePayment`).
  Future<AdminPaymentDetail> adminDecidePayment(
    String paymentId,
    PaymentDecision body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDecidePayment',
        method: 'POST',
        path: '/admin/payments/${Uri.encodeComponent(paymentId)}/decision',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan payment pending yang belum berbukti atas kebijakan pengurus (payments.decide, PRD 4.3).
  ///
  /// Hanya untuk payment pending dengan proof_version 0, sesuai transisi PRD 4.3 "pending ke cancelled:
  /// pemilik membatalkan sebelum bukti atau kebijakan admin" (ARCHITECTURE §3.3). Contohnya instruksi yang
  /// ditinggalkan anggota, sehingga anggota dapat membuat instruksi baru. Batasannya:
  /// - Payment pending yang sudah berbukti wajib diputus (setujui/tolak), bukan dibatalkan, karena dana mungkin
  ///   sudah ditransfer (PRD 3.4, 3.9, 4.4).
  /// - Payment rejected tidak dapat dibatalkan. Iuran rejected hanya kembali pending bila pemiliknya mengirim
  ///   ulang bukti (AC F03-3), dan tiket rejected sudah final (AC F09-4).
  /// Dalam satu transaksi: status cancelled, `cancelled_at` dan `cancel_reason` tersimpan, histori cancelled
  /// dengan aktor admin, handler jenis (tiket: tiket dibatalkan dan hold dilepas), audit, notifikasi kategori
  /// payment ke pemilik dengan deep link `/payments/{paymentId}`. Tidak membuka akses apa pun.
  ///
  /// Kunci (URUTAN KUNCI di kepala payments.yaml, PRD 6.4): untuk tiket, hook pra-kunci handler tiket mengunci
  /// event lalu tiket SEBELUM `SELECT payments … FOR UPDATE`, karena pelepasan hold mengubah held_quantity;
  /// onCancelled tidak mengunci event/tiket lagi. Untuk iuran, hook pra-kunci keanggotaan mengunci baris users
  /// lalu alumni pemilik sebelum payment.
  ///
  /// Galat 409 (dengan `current` AdminPaymentDetail): PAYMENT_STATE_CONFLICT bila payment bukan pending atau
  /// sudah berbukti, VERSION_CONFLICT bila If-Match usang, IDEMPOTENCY_CONFLICT. 403 FORBIDDEN bila tanpa izin
  /// atau berkonflik kepentingan.
  ///
  /// [paymentId]: ID payment (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payments/{paymentId}/cancel` (operationId `adminCancelPayment`).
  Future<AdminPaymentDetail> adminCancelPayment(
    String paymentId,
    AdminCancelPaymentRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCancelPayment',
        method: 'POST',
        path: '/admin/payments/${Uri.encodeComponent(paymentId)}/cancel',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Catat refund atau koreksi atas payment paid tanpa mengubah payment asal (payments.decide, D6).
  ///
  /// Payment paid tidak pernah diubah menjadi status lain; koreksi keuangan dan refund dicatat sebagai
  /// penyesuaian terpisah (PRD 3.4, 4.3, ARCHITECTURE §2 butir 13). Prasyarat: payment paid dan pemanggil tidak
  /// berkonflik kepentingan. Termasuk payment tiket yang disetujui setelah tiketnya dibatalkan (dana diterima,
  /// lihat adminDecidePayment) bila refund tidak dibuat otomatis oleh sistem.
  ///
  /// - refund: `amount` > 0 dan total refund pending + completed tidak melebihi nominal payment. `due_at` = 7
  ///   hari kerja sejak pembatalan tiket/event terkait, atau sejak dicatat bila tidak ada pembatalan (PRD 3.9).
  /// - correction: `amount` >= 0 dengan alasan; tanpa rekening tujuan dan tanpa tenggat.
  ///
  /// Rekening tujuan refund diminta saat proses refund saja (D6) dan hanya disimpan selama proses, lalu dihapus
  /// saat selesai atau dibatalkan (D2). Kanal pengumpulannya:
  /// - Utama, di aplikasi: dalam transaksi yang sama pemilik menerima notifikasi kategori payment dengan deep
  ///   link `/payments/{paymentId}` ("Refund sedang diproses bendahara; kirim rekening tujuan"), lalu mengisi
  ///   rekening lewat PUT /me/payments/{paymentId}/adjustments/{adjustmentId}/refund-destination. Ringkasan
  ///   penyesuaian anggota menampilkan `destination_required` dan `has_refund_destination`.
  /// - Cadangan: rekening yang diterima bendahara lewat kontak dukungan resmi (pengaturan `support`) dicatat
  ///   lewat `refund_destination` di sini atau lewat PATCH. AdminPaymentMember sengaja tanpa kontak (N-09).
  /// - Akun pemilik sudah dihapus: tidak ada notifikasi; bendahara memakai rekening pengirim pada mutasi dan
  ///   mencatatnya lewat PATCH.
  /// Pembuatan koreksi tidak mengirim notifikasi.
  ///
  /// Refund otomatis juga dibuat sistem (created_by null) saat event dibatalkan atau peserta membatalkan sampai
  /// H-3 atas tiket paid, dan saat payment tiket yang tiketnya sudah dibatalkan dengan alasan yang sama disetujui
  /// (F-09, D6); notifikasi permintaan rekening yang sama dikirim. Untuk refund yang lahir dari persetujuan
  /// payment, permintaan rekening itu menjadi isi notifikasi keputusan sendiri (satu notification_id per
  /// keputusan, AC F13-1), bukan notifikasi kedua. Audit dicatat dalam transaksi yang sama tanpa
  /// rekening tujuan (ARCHITECTURE §2 butir 3). Kunci: baris payment (FOR UPDATE) lebih dahulu agar pemeriksaan
  /// total refund berurutan dengan PATCH nominal dan penyesuaian lain atas payment yang sama.
  ///
  /// Pengulangan dengan Idempotency-Key dan payload sama mengembalikan hasil pertama dengan satu pengecualian:
  /// `refund_destination` bernilai null pada respons ulangan (`has_refund_destination` tetap true), karena
  /// rekening tujuan refund tidak pernah disalin ke penyimpanan idempotensi (D2, ARCHITECTURE §2.3). Pemutus
  /// membacanya lewat GET /admin/payment-adjustments/{adjustmentId}.
  ///
  /// [paymentId]: ID payment (UUID v7).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payments/{paymentId}/adjustments` (operationId `adminCreatePaymentAdjustment`).
  Future<AdminPaymentAdjustment> adminCreatePaymentAdjustment(
    String paymentId,
    CreatePaymentAdjustmentRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreatePaymentAdjustment',
        method: 'POST',
        path: '/admin/payments/${Uri.encodeComponent(paymentId)}/adjustments',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentAdjustment.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar penyesuaian refund dan koreksi (payments.read, D6).
  ///
  /// Tab Penyesuaian. Urutan bawaan `due_at_asc` (tenggat terdekat dahulu, tanpa tenggat di akhir). `overdue`
  /// true bila pending dan sudah melewati `due_at` (7 hari kerja, D6). Rekening tujuan refund tidak pernah
  /// dikirim di daftar; `has_refund_destination` menandai refund yang siap ditransfer, dan filter
  /// `has_refund_destination=false` menampilkan refund yang masih menunggu rekening dari pemilik.
  ///
  /// [status]: Status penyesuaian; kosong berarti semua.
  /// [hasRefundDestination]: true hanya penyesuaian yang rekening tujuannya sudah ada; false hanya yang belum ada.
  /// [q]: Cari nama alumni atau nomor anggota pemilik payment.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/payment-adjustments` (operationId `adminListPaymentAdjustments`).
  Future<AdminPaymentAdjustmentPage> adminListPaymentAdjustments({
    PaymentAdjustmentStatus? status,
    PaymentAdjustmentKind? kind,
    bool? overdue,
    bool? hasRefundDestination,
    String? paymentId,
    String? q,
    AdminPaymentAdjustmentSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPaymentAdjustments',
        method: 'GET',
        path: '/admin/payment-adjustments',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          if (kind case final v?) 'kind': v.toJson(),
          'overdue': ?overdue,
          'has_refund_destination': ?hasRefundDestination,
          'payment_id': ?paymentId,
          'q': ?q,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminPaymentAdjustmentPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail penyesuaian (payments.read, D6).
  ///
  /// `refund_destination` hanya dikirim kepada pemegang payments.decide selama status pending dan tidak
  /// berkonflik kepentingan; selain itu null dengan `has_refund_destination` sebagai penanda (D2).
  ///
  /// [adjustmentId]: ID penyesuaian (UUID v7).
  ///
  /// `GET /admin/payment-adjustments/{adjustmentId}` (operationId `adminGetPaymentAdjustment`).
  Future<AdminPaymentAdjustment> adminGetPaymentAdjustment(
    String adjustmentId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPaymentAdjustment',
        method: 'GET',
        path: '/admin/payment-adjustments/${Uri.encodeComponent(adjustmentId)}',
        authRequired: true,
        decode: (Object? v0) => AdminPaymentAdjustment.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah nominal, alasan, rekening tujuan atau bukti penyesuaian pending (payments.decide, D6).
  ///
  /// Hanya untuk status pending. Field yang tidak dikirim tidak berubah; `refund_destination` null menghapus
  /// rekening tujuan, dan hanya boleh untuk kind refund. Aturan nominal sama dengan pembuatan. Audit mencatat
  /// perubahan tanpa isi rekening tujuan. Kunci: baris payment asal (FOR UPDATE) lalu baris penyesuaian, agar
  /// pemeriksaan total refund berurutan dengan pembuatan penyesuaian lain. Galat 409 PAYMENT_STATE_CONFLICT bila
  /// bukan pending dan VERSION_CONFLICT bila If-Match usang (termasuk bila pemilik baru saja mengirim rekening
  /// tujuan), dengan `current` AdminPaymentAdjustment.
  ///
  /// [adjustmentId]: ID penyesuaian (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /admin/payment-adjustments/{adjustmentId}` (operationId `adminUpdatePaymentAdjustment`).
  Future<AdminPaymentAdjustment> adminUpdatePaymentAdjustment(
    String adjustmentId,
    UpdatePaymentAdjustmentRequest body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdatePaymentAdjustment',
        method: 'PATCH',
        path: '/admin/payment-adjustments/${Uri.encodeComponent(adjustmentId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentAdjustment.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tandai penyesuaian selesai; rekening tujuan refund dihapus (payments.decide, D2, D6).
  ///
  /// Hanya untuk status pending. Refund wajib melampirkan bukti penyelesaian `evidence_file_id` (berkas purpose
  /// adjustment_evidence; boleh sudah tersimpan lewat PATCH). Dalam satu conditional UPDATE status menjadi
  /// completed, `completed_at`/`completed_by` diisi dan `refund_destination` dikosongkan (D2); payment_event
  /// `adjusted` dicatat pada payment asal, audit tanpa rekening tujuan, dan notifikasi kategori payment ke
  /// pemilik dengan deep link `/payments/{paymentId}` (PRD 10.2: adjustment, notifikasi dan bukti
  /// penyelesaian; tanpa notifikasi bila akun pemilik sudah dihapus). Bila akun pemilik sudah dihapus atau
  /// sedang deletion_pending (F-14, AC F14-4, D2), bukti tetap wajib dilampirkan sebagai syarat penyelesaian
  /// tetapi tidak disimpan: respons memuat `evidence_file_id` null, berkasnya dihapus setelah commit, dan audit
  /// hanya mencatat id, sha256 dan ukuran berkas (`evidence_erased`). Kunci: baris users pemilik (FOR SHARE),
  /// baris payment asal, lalu baris penyesuaian (URUTAN KUNCI payments.yaml). Galat 409
  /// PAYMENT_STATE_CONFLICT/VERSION_CONFLICT dengan `current`.
  ///
  /// [adjustmentId]: ID penyesuaian (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payment-adjustments/{adjustmentId}/complete` (operationId `adminCompletePaymentAdjustment`).
  Future<AdminPaymentAdjustment> adminCompletePaymentAdjustment(
    String adjustmentId,
    CompletePaymentAdjustmentRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCompletePaymentAdjustment',
        method: 'POST',
        path: '/admin/payment-adjustments/${Uri.encodeComponent(adjustmentId)}/complete',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentAdjustment.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan penyesuaian pending dengan alasan; rekening tujuan dihapus (payments.decide, D2).
  ///
  /// Hanya untuk status pending. Dalam satu conditional UPDATE status menjadi cancelled; `cancel_reason`,
  /// `cancelled_by` dan `cancelled_at` disimpan di kolom penyesuaian (PRD 6.3: alasan dan aktor), dan
  /// `refund_destination` dikosongkan (D2). Nilai ini tidak pernah dibaca kembali dari audit_logs; audit hanya
  /// jejak akuntabilitas (F-17) dan dicatat dalam transaksi yang sama. Untuk refund, pemilik menerima notifikasi
  /// kategori payment dengan deep link `/payments/{paymentId}` berisi teks baku bahwa refund dibatalkan dan
  /// arahan ke kontak dukungan; `cancel_reason` internal tidak dikirim kepada anggota (tanpa notifikasi bila
  /// akun pemilik sudah dihapus). Bukti yang sempat dilampirkan atas payment yang pemiliknya sudah dihapus atau
  /// sedang deletion_pending ikut dihapus setelah commit (`evidence_file_id` null, D2). Kunci: baris users
  /// pemilik (FOR SHARE), baris payment asal, lalu baris penyesuaian. Galat 409
  /// PAYMENT_STATE_CONFLICT/VERSION_CONFLICT dengan `current`.
  ///
  /// [adjustmentId]: ID penyesuaian (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payment-adjustments/{adjustmentId}/cancel` (operationId `adminCancelPaymentAdjustment`).
  Future<AdminPaymentAdjustment> adminCancelPaymentAdjustment(
    String adjustmentId,
    CancelPaymentAdjustmentRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCancelPaymentAdjustment',
        method: 'POST',
        path: '/admin/payment-adjustments/${Uri.encodeComponent(adjustmentId)}/cancel',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentAdjustment.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Unggah gambar QRIS statis organisasi untuk metode bayar qris (settings.manage, ADR-026, N-10).
  ///
  /// Membuat berkas purpose `payment_qr` milik akun login pemanggil (`files.owner_user_id`) untuk dirujuk
  /// `qr_image_file_id` pada adminCreatePaymentMethod/adminUpdatePaymentMethod. Unggahan berkas umum POST /files
  /// tidak menerima purpose ini; gambar QRIS selalu lewat operasi ini agar izin settings.manage yang diperiksa.
  /// Gunakan QRIS statis resmi organisasi tanpa nominal: anggota memasukkan nominal sendiri saat membayar.
  /// - Hanya PNG atau JPG <= 5 MB (WebP, SVG, PDF dan tipe lain -> 415); magic bytes diperiksa, ekstensi atau
  ///   Content-Type yang menyamarkan isi -> 415, gambar rusak atau dimensi/piksel berlebihan (decompression bomb)
  ///   -> 422. Sisi terpendek minimal 512 piksel agar mudah dipindai -> 422 bila kurang. EXIF dibuang dan gambar
  ///   di-encode ulang dengan format yang sama; gambar yang lebih besar dari 2048 piksel diperkecil tanpa
  ///   pembesaran (N-10). Pelanggaran -> 413/415/422 FILE_INVALID.
  /// - Berkas bervisibilitas publik (files_private_purpose_chk mengizinkan payment_qr) karena ditampilkan ke
  ///   anggota pada instruksi bayar; URL publik tetap dengan cache publik + ETag.
  /// - Status `ready` sesudah diproses. Berkas yang tidak dilampirkan ke metode dalam 24 jam (`attached_at` null)
  ///   dihapus job `files.cleanup-temp` (PRD 2.5). Hanya pengunggah yang dapat melampirkan berkasnya.
  /// - Batas 10 unggahan berhasil per purpose per akun per 24 jam bergulir (N-10) -> 429 RATE_LIMITED dengan
  ///   `retry_after_seconds`.
  /// Tanpa reautentikasi dan tanpa Idempotency-Key (setiap unggahan membuat berkas baru yang belum terlampir).
  /// Pemasangan gambar tercatat pada audit `payment_method.created`/`payment_method.updated` beserta id dan
  /// sha256 berkas (F-17), bukan saat unggah.
  ///
  /// `POST /admin/payment-qr-images` (operationId `adminUploadPaymentQrImage`).
  Future<AdminPaymentQrImage> adminUploadPaymentQrImage(
    AdminPaymentQrImageUploadRequest body, {
    CancelToken? cancelToken,
    Options? options,
    ProgressCallback? onSendProgress,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUploadPaymentQrImage',
        method: 'POST',
        path: '/admin/payment-qr-images',
        authRequired: true,
        data: body.toFormData(),
        decode: (Object? v0) => AdminPaymentQrImage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
        onSendProgress: onSendProgress,
      );

  /// Semua metode bayar, aktif maupun nonaktif (settings.manage, F-15).
  ///
  /// Tab Kelola Metode (guidelines p17). Tabel server-side seperti tabel admin lain (ARCHITECTURE §4.10):
  /// `cursor` + `limit` dan `total`. Urutan tetap mengikuti urutan tampil yang diatur pengurus: `sort_order`,
  /// lalu nama penyedia, lalu id (keyset).
  ///
  /// [active]: Saring status aktif; kosong berarti semua.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/payment-methods` (operationId `adminListPaymentMethods`).
  Future<AdminPaymentMethodPage> adminListPaymentMethods({
    bool? active,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListPaymentMethods',
        method: 'GET',
        path: '/admin/payment-methods',
        authRequired: true,
        queryParameters: <String, Object?>{
          'active': ?active,
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminPaymentMethodPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tambah rekening tujuan (settings.manage, AC F15-3).
  ///
  /// Rekening tujuan menentukan ke mana anggota mentransfer dana, sehingga setiap perubahan diaudit dalam
  /// transaksi yang sama (AC F17-1). Tidak meminta reautentikasi sejak keputusan PO 2026-10-15 (ADR-025).
  ///
  /// Metode `qris` (ADR-026) wajib `qr_image_file_id`: berkas `payment_qr` berstatus ready hasil
  /// adminUploadPaymentQrImage yang diunggah pemanggil sendiri dan belum dipakai metode lain. Berkas dilampirkan
  /// dalam transaksi yang sama; selain itu 400 VALIDATION_ERROR pada `qr_image_file_id` ("Gambar QRIS wajib
  /// diunggah." bila kosong). Jenis lain tidak boleh membawa gambar ("Gambar QR hanya untuk metode QRIS.").
  /// Audit `payment_method.created` mencatat id dan sha256 gambar.
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/payment-methods` (operationId `adminCreatePaymentMethod`).
  Future<AdminPaymentMethod> adminCreatePaymentMethod(
    PaymentMethodInput body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminCreatePaymentMethod',
        method: 'POST',
        path: '/admin/payment-methods',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentMethod.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail metode bayar untuk formulir ubah (settings.manage).
  ///
  /// [methodId]: ID metode bayar (UUID v7).
  ///
  /// `GET /admin/payment-methods/{methodId}` (operationId `adminGetPaymentMethod`).
  Future<AdminPaymentMethod> adminGetPaymentMethod(
    String methodId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetPaymentMethod',
        method: 'GET',
        path: '/admin/payment-methods/${Uri.encodeComponent(methodId)}',
        authRequired: true,
        decode: (Object? v0) => AdminPaymentMethod.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah atau nonaktifkan metode bayar (settings.manage, AC F15-3, F15-4).
  ///
  /// Penggantian penuh. Payment yang sudah dibuat tetap memakai snapshot lamanya (AC F15-3); metode nonaktif
  /// tidak muncul di GET /payment-methods dan tidak dapat dipilih untuk payment baru atau ganti metode.
  ///
  /// Identitas rekening metode yang sudah dipakai payment (`in_use` true) tidak dapat diubah. Untuk metode
  /// seperti ini hanya `instructions`, `active` dan `sort_order` yang boleh berubah. Perubahan `kind`,
  /// `provider`, `account_number`, `account_holder` atau gambar QRIS (`qr_image_file_id`) ditolak 400
  /// VALIDATION_ERROR (field_errors per field); pengurus menonaktifkan metode lama lalu membuat metode baru.
  /// Dengan aturan ini, snapshot pada instruksi yang belum dibayar tidak pernah diam-diam berbeda dari rekening
  /// yang berlaku. Anggota yang instruksinya belum berbukti melihat `method_active` false dan diarahkan mengganti
  /// rekening tujuan sebelum transfer.
  ///
  /// Gambar QRIS (ADR-026): `qr_image_file_id` tidak dikirim = gambar tetap; null = tanpa gambar; UUID = ganti
  /// dengan berkas `payment_qr` baru (aturan sama dengan adminCreatePaymentMethod). Hasil akhirnya wajib
  /// konsisten dengan `kind`: qris wajib bergambar, jenis lain tanpa gambar (ganti qris ke bank berarti mengirim
  /// `qr_image_file_id` null). Gambar lama yang diganti atau dihapus dibuang (status deleted) setelah commit.
  ///
  /// Pemeriksaan `in_use` dan pembaruan berjalan dalam satu transaksi dengan lock baris metode (FOR UPDATE).
  /// Pembuatan payment dan ganti metode mengunci baris metode yang sama (FOR SHARE), sehingga tidak ada payment
  /// baru yang menyalin isi lama setelah perubahan tersimpan. Audit before/after dalam transaksi yang sama.
  /// If-Match usang menghasilkan 409 VERSION_CONFLICT dengan `current` AdminPaymentMethod (AC F15-4).
  ///
  /// [methodId]: ID metode bayar (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/payment-methods/{methodId}` (operationId `adminUpdatePaymentMethod`).
  Future<AdminPaymentMethod> adminUpdatePaymentMethod(
    String methodId,
    PaymentMethodInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdatePaymentMethod',
        method: 'PUT',
        path: '/admin/payment-methods/${Uri.encodeComponent(methodId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentMethod.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus metode yang belum pernah dipakai (settings.manage, F-15).
  ///
  /// Hanya metode dengan `in_use` false (tidak pernah dirujuk payment mana pun) yang dapat dihapus. Metode yang
  /// sudah dipakai ditolak 400 VALIDATION_ERROR (field_errors._ "metode sudah dipakai, nonaktifkan saja") dan
  /// harus dinonaktifkan lewat PUT (`active` false) agar histori dan snapshot tetap utuh. Pemeriksaan dan
  /// penghapusan berjalan dalam satu transaksi dengan lock baris metode. If-Match usang menghasilkan 409
  /// VERSION_CONFLICT. Audit dicatat dalam transaksi yang sama. Gambar QRIS metode yang dihapus ikut dibuang
  /// (ADR-026).
  ///
  /// [methodId]: ID metode bayar (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `DELETE /admin/payment-methods/{methodId}` (operationId `adminDeletePaymentMethod`).
  Future<void> adminDeletePaymentMethod(
    String methodId, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminDeletePaymentMethod',
        method: 'DELETE',
        path: '/admin/payment-methods/${Uri.encodeComponent(methodId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );
}
