// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Iuran keanggotaan organisasi (pendaftaran dan perpanjangan), metode bayar transfer manual, bukti transfer,
/// pembatalan dan histori pembayaran milik sendiri, termasuk pembayaran tiket (F-03, F-07, F-09, D4, D13).
///
///
/// Kelas API untuk tag kontrak "Payments". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class PaymentsApi {
  const PaymentsApi(this._dio);

  final Dio _dio;

  /// Daftar rekening tujuan aktif untuk transfer manual (F-03, D13).
  ///
  /// Hanya metode `active` yang dikembalikan, urut `sort_order` lalu nama penyedia. Metode dikelola pengurus
  /// berizin settings.manage (F-15). Nomor rekening adalah rekening organisasi, bukan data pribadi anggota.
  /// Daftar ini dipakai layar instruksi bayar (prototipe screen_3) dan pilihan metode tiket (guidelines p8).
  ///
  /// `GET /payment-methods` (operationId `listPaymentMethods`).
  Future<PaymentMethodList> listPaymentMethods({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listPaymentMethods',
        method: 'GET',
        path: '/payment-methods',
        authRequired: true,
        decode: (Object? v0) => PaymentMethodList.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kutipan iuran keanggotaan dari server beserta kelayakan (F-03, F-07, AC F03-1, D4).
  ///
  /// Server menghitung baris iuran dari pengaturan terversi `fees` (ARCHITECTURE §5.4) dan kelayakan dari status
  /// efektif saat ini; klien tidak menghitung nominal sendiri (PRD 3.3). Dipakai layar Biaya KTA (prototipe
  /// screen_2) dan layar perpanjangan.
  ///
  /// - registration = register alumni baru + pembuatan KTA (nilai awal Rp50.000 + Rp10.000, D4).
  /// - renewal = perpanjangan KTA per tahun (nilai awal Rp10.000, D4).
  ///
  /// Kelayakan (PRD 2.2, AC F07-5):
  /// - registration layak hanya bila iuran pendaftaran belum pernah paid (effective_status unverified);
  ///   selain itu `already_registered`.
  /// - renewal layak bila status expiring atau expired (jendela dibuka 30 hari sebelum habis dan tetap terbuka
  ///   setelah expired); verified dengan sisa masa aktif lebih dari 30 hari mendapat `renewal_window_not_open`
  ///   beserta `renewal_opens_at`; unverified mendapat `registration_required`.
  ///
  /// Bila sudah ada pembayaran nonterminal (pending atau rejected) untuk jenis itu, `open_payment_id` terisi dan
  /// klien membuka pembayaran tersebut (nilai snapshot-nya yang berlaku, bukan kutipan ini; AC F03-5).
  /// Kutipan bukan janji harga: nominal final disnapshot saat POST /me/payments.
  ///
  /// Rencana cadangan D13 (PRD 10.1): `instructions_hidden` true bila platform pemanggil (header
  /// `X-App-Platform`) termasuk pengaturan `payment_instructions.dues_hidden_platforms`. Klien lalu tidak
  /// menampilkan alur bayar iuran (rekening tujuan, tombol bayar, unggah bukti) dan hanya menampilkan status
  /// keanggotaan serta kontak dukungan; pengurus mencatat iuran yang diverifikasi di luar aplikasi
  /// (POST /admin/payments). Klien mobile wajib mengirim `X-App-Platform` di setiap request; request tanpa
  /// header ini diperlakukan sebagai platform yang tidak menyembunyikan instruksi.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  ///
  /// `GET /me/fees` (operationId `getMyFees`).
  Future<MyFeeQuotes> getMyFees({
    DevicePlatform? appPlatform,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMyFees',
        method: 'GET',
        path: '/me/fees',
        authRequired: true,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
        },
        decode: (Object? v0) => MyFeeQuotes.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Riwayat pembayaran sendiri, termasuk tiket (F-03, F-07, PRD 2.2).
  ///
  /// Urut `created_at` terbaru lebih dahulu (keyset created_at, id). Hanya pembayaran milik pemanggil; status
  /// efektif apa pun (termasuk expired dan suspended) tetap dapat membaca riwayat sendiri (ARCHITECTURE §3.1).
  /// `actions` setiap item bergantung pada header `X-App-Platform` (rencana cadangan D13, lihat getMyPayment).
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [type]: Saring jenis pembayaran.
  /// [status]: Saring status pembayaran; kosong berarti semua status.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /me/payments` (operationId `listMyPayments`).
  Future<PaymentPage> listMyPayments({
    DevicePlatform? appPlatform,
    PaymentType? type,
    PaymentStatus? status,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listMyPayments',
        method: 'GET',
        path: '/me/payments',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (type case final v?) 'type': v.toJson(),
          if (status case final v?) 'status': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
        },
        decode: (Object? v0) => PaymentPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat instruksi iuran pendaftaran atau perpanjangan; nominal dihitung server (AC F03-1, F03-5).
  ///
  /// Server menghitung baris dan total dari pengaturan `fees` versi aktif, lalu menyimpan snapshot baris,
  /// metode (rekening tujuan) dan `settings_version` (PRD 3.3, ARCHITECTURE §3.3). Nilai dari klien tidak
  /// dipercaya; body tidak memuat nominal. Payment baru berstatus pending dengan `stage` awaiting_transfer dan
  /// `payment_id` yang tetap (AC F03-1).
  ///
  /// Satu payment nonterminal per pengguna per jenis (PRD 3.3, indeks `payments_user_id_type_open_key`): bila
  /// sudah ada payment pending atau rejected untuk jenis itu, payment tersebut dikembalikan apa adanya dengan
  /// 200 (metode tidak diubah; pakai PUT /me/payments/{paymentId}/method). Permintaan bersamaan menghasilkan
  /// satu payment.
  ///
  /// Galat:
  /// - 403 MEMBERSHIP_REQUIRED: renewal oleh akun yang iuran pendaftarannya belum paid (klien memuat ulang /me
  ///   lalu mengarahkan ke onboarding).
  /// - 403 ACCOUNT_SUSPENDED: anggota dibatasi (PRD 2.2).
  /// - 403 FORBIDDEN: instruksi iuran disembunyikan untuk platform pemanggil (`X-App-Platform`, rencana
  ///   cadangan D13); klien versi lama yang belum mengenal `instructions_hidden` menampilkan pesan server.
  ///   Request tanpa `X-App-Platform` diperlakukan sebagai platform yang tidak menyembunyikan instruksi.
  /// - 403 FORBIDDEN: nominal iuran belum ditetapkan pengurus (gagal tertutup, PRD 8.2 butir 4, 9.3): pengaturan
  ///   `fees` belum tersimpan (versi 0, nilai bawaan kode tidak pernah ditagihkan) atau total jenis iuran ini
  ///   0.00. Tidak ada payment yang dibuat; klien menampilkan pesan server.
  /// - 400 VALIDATION_ERROR: `payment_method_id` tidak ada atau tidak aktif (field_errors.payment_method_id);
  ///   renewal sebelum jendela perpanjangan dibuka (field_errors.type).
  /// - 409 PAYMENT_STATE_CONFLICT: registration padahal iuran pendaftaran sudah paid.
  /// - 409 IDEMPOTENCY_CONFLICT: Idempotency-Key sama dengan payload berbeda.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /me/payments` (operationId `createPaymentInstruction`).
  Future<PaymentDetail> createPaymentInstruction(
    CreatePaymentRequest body, {
    DevicePlatform? appPlatform,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'createPaymentInstruction',
        method: 'POST',
        path: '/me/payments',
        authRequired: true,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => PaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail pembayaran sendiri beserta histori status dan bukti (F-03, AC F03-3, F04-2).
  ///
  /// Memuat snapshot baris dan rekening tujuan, versi bukti, histori (termasuk alasan penolakan lama, AC F03-3),
  /// alasan penolakan terakhir (AC F04-2), waktu keputusan, penyesuaian/refund (D6) dan tindakan yang boleh
  /// dilakukan (`actions`). Dipakai layar instruksi bayar, menunggu verifikasi dan ditolak (prototipe screen_3,
  /// screen_4, screen_5) serta deep link notifikasi `/payments/{paymentId}` (ARCHITECTURE §4.7).
  /// Payment milik pengguna lain menghasilkan 404 (N-09).
  ///
  /// Bila tiket dibatalkan (misalnya event dibatalkan pengurus) saat bukti masih menunggu verifikasi, payment
  /// tetap pending dan pengurus tetap memverifikasi dana. Bila dana diterima, payment menjadi paid tanpa tiket
  /// aktif dan refund penuh tercatat di `adjustments` sesuai D6 (PRD 3.9, 4.4).
  ///
  /// Refund (D6, PRD 3.9): rekening tujuan diminta saat proses refund saja. Penyesuaian refund pending dengan
  /// `destination_required` true ditampilkan bersama formulir rekening tujuan
  /// (PUT /me/payments/{paymentId}/adjustments/{adjustmentId}/refund-destination); nilai rekening tidak pernah
  /// dikembalikan dalam respons (hanya `has_refund_destination`).
  ///
  /// Bukti yang dicatat pengurus (POST /admin/payments, rencana cadangan D13) tidak dibuka kepada anggota:
  /// `proof_file_id` dan `transfer_note` tidak dikirim bila bukti aktif diunggah pengurus, karena berkas pengurus
  /// (misalnya tangkapan mutasi) dapat memuat data pihak lain (N-09, PRD 5.4). Histori tetap menampilkan entri
  /// bukti beraktor admin.
  ///
  /// `instructions_hidden` true untuk payment iuran bila platform pemanggil (header `X-App-Platform`)
  /// menyembunyikan instruksi iuran (rencana cadangan D13); klien hanya menampilkan status dan kontak dukungan,
  /// tanpa rekening tujuan dan unggah bukti. Request tanpa header ini diperlakukan sebagai platform yang tidak
  /// menyembunyikan instruksi; `actions` dihitung dengan aturan yang sama.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [paymentId]: ID payment (UUID v7).
  ///
  /// `GET /me/payments/{paymentId}` (operationId `getMyPayment`).
  Future<PaymentDetail> getMyPayment(
    String paymentId, {
    DevicePlatform? appPlatform,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMyPayment',
        method: 'GET',
        path: '/me/payments/${Uri.encodeComponent(paymentId)}',
        authRequired: true,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
        },
        decode: (Object? v0) => PaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ganti rekening tujuan sebelum bukti pertama dikirim (F-03, PRD 4.3).
  ///
  /// Hanya untuk payment pending dengan `proof_version` 0 (belum ada bukti) dan metode tujuan yang aktif.
  /// Snapshot metode diganti, nominal tidak berubah, `version` naik dan histori `method_changed` dicatat
  /// (prototipe screen_3, pilihan rekening). Berlaku untuk iuran maupun tiket.
  ///
  /// Galat:
  /// - 400 VALIDATION_ERROR: metode tidak ada atau tidak aktif (field_errors.payment_method_id).
  /// - 403 ACCOUNT_SUSPENDED: anggota dibatasi; 403 FORBIDDEN: payment iuran dari platform yang instruksi
  ///   iurannya disembunyikan (header `X-App-Platform`, rencana cadangan D13; tanpa header dianggap tidak
  ///   disembunyikan).
  /// - 409 PAYMENT_STATE_CONFLICT: payment bukan pending atau bukti sudah pernah dikirim; `current` berisi
  ///   PaymentDetail terbaru.
  /// - 409 VERSION_CONFLICT: If-Match berbeda dari `version` terbaru; `current` berisi PaymentDetail.
  /// - 409 RESERVATION_EXPIRED: payment tiket yang hold-nya sudah lewat (AC F09-2); `current` berisi
  ///   PaymentDetail. Request ini tidak mengubah tiket; kedaluwarsa dijalankan job atau request kirim bukti.
  ///
  /// Kunci: baris payment (FOR UPDATE) lalu baris metode tujuan (FOR SHARE, kunci daun); lihat URUTAN KUNCI di
  /// kepala berkas. Untuk tiket, ganti metode tidak mengubah tiket maupun kursi sehingga tidak mengunci event.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [paymentId]: ID payment (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /me/payments/{paymentId}/method` (operationId `changeMyPaymentMethod`).
  Future<PaymentDetail> changeMyPaymentMethod(
    String paymentId,
    ChangePaymentMethodRequest body, {
    DevicePlatform? appPlatform,
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'changeMyPaymentMethod',
        method: 'PUT',
        path: '/me/payments/${Uri.encodeComponent(paymentId)}/method',
        authRequired: true,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => PaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kirim atau ganti bukti transfer; proof_version bertambah (AC F03-2, F03-3, F03-4, F09-2).
  ///
  /// `file_id` adalah hasil POST /files purpose `payment_proof` milik pemanggil yang belum terpakai objek lain
  /// (JPG/PNG <= 5 MB atau PDF <= 10 MB, N-10). Dalam satu transaksi: bukti aktif diganti, `proof_version` naik
  /// satu, `submitted_at` diisi waktu server, histori `proof_submitted` (bukti pertama) atau `proof_replaced`
  /// dicatat dengan berkas versi lama tetap tersimpan untuk pengurus (U-02); tidak ada payment tambahan (AC
  /// F03-2). `transfer_note` menggantikan catatan sebelumnya (kosong berarti dihapus). Tanggal transfer yang
  /// dilaporkan bukan sumber aktivasi (PRD 3.7).
  ///
  /// Kunci (URUTAN KUNCI di kepala berkas, PRD 6.4): hook pra-kunci (`lockRelated`) jenis payment dipanggil
  /// sebelum `SELECT payments … FOR UPDATE`. Iuran: baris users lalu alumni pemilik. Tiket: `ticket_id` dibaca
  /// tanpa kunci, handler tiket mengunci baris event lalu tiket. Status tiket, hold dan payment diperiksa ulang
  /// sesudah semua kunci didapat.
  ///
  /// Transisi:
  /// - pending -> pending (bukti pertama atau pengganti sebelum keputusan).
  /// - rejected -> pending hanya untuk registration/renewal; payment yang sama kembali pending dengan versi
  ///   baru dan alasan lama tetap di histori (AC F03-3).
  /// - Tiket: bukti sebelum `hold_expires_at` memindahkan tiket ke awaiting_review dan kursi tetap ditahan
  ///   (PRD 4.4); bukti pengganti selama awaiting_review diterima. Tiket rejected bersifat final (AC F09-4).
  /// - Tiket yang hold-nya sudah lewat tanpa bukti: request ini menjalankan kedaluwarsa tepat sekali bila job
  ///   belum melakukannya (tiket expired, held_quantity dikurangi, payment cancelled dengan histori beraktor
  ///   system dan alasan batas reservasi habis; UPDATE bersyarat `status='awaiting_payment'`, AC F09-2).
  ///   Kedaluwarsa itu DI-COMMIT lebih dahulu, bukan di-rollback oleh galat; sesudahnya respons 409
  ///   RESERVATION_EXPIRED dengan `current` berisi PaymentDetail berstatus cancelled. Bukti tidak pernah
  ///   menghidupkan tiket yang sudah expired (AC F09-4). Handler tiket karena itu MENGEMBALIKAN hasil
  ///   "reservasi habis" kepada modul pembayaran alih-alih melempar galat di dalam transaksi (shared change
  ///   ARCHITECTURE §4.6).
  ///
  /// Pengulangan dengan Idempotency-Key dan payload sama mengembalikan hasil pertama tanpa menaikkan versi lagi
  /// (AC F03-4). Setelah pemeriksaan global (401, 403 ACCOUNT_SUSPENDED, 426 UPGRADE_REQUIRED, 503
  /// MAINTENANCE), galat diperiksa berurutan berikut dan yang pertama cocok dikembalikan; setiap 409 membawa
  /// `current` berisi PaymentDetail terbaru kecuali IDEMPOTENCY_CONFLICT:
  /// 1. 404 NOT_FOUND: payment tidak ada atau milik pengguna lain (N-09).
  /// 2. 409 IDEMPOTENCY_CONFLICT: Idempotency-Key sama dengan payload berbeda.
  /// 3. 403 FORBIDDEN: payment iuran dari platform yang instruksi iurannya disembunyikan (header
  ///    `X-App-Platform`, rencana cadangan D13; tanpa header dianggap tidak disembunyikan).
  /// 4. 409 RESERVATION_EXPIRED: HANYA payment tiket yang tiketnya expired atau hold-nya sudah lewat, termasuk
  ///    bila payment sudah cancelled oleh sistem karena hold habis (AC F09-2). Kode ini didahulukan atas
  ///    PAYMENT_STATE_CONFLICT agar klien menampilkan layar reservasi habis. Status HTTP 409 sama dengan
  ///    RESERVATION_EXPIRED pada createEventReservation (events.yaml).
  /// 5. 409 PAYMENT_STATE_CONFLICT: payment paid; cancelled oleh pemilik, pengurus, pembatalan event atau
  ///    penghapusan akun; tiket rejected (AC F09-4); atau tiket sudah cancelled karena event dibatalkan atau
  ///    dibatalkan peserta/pengurus (bukan kedaluwarsa; bukti yang ada tetap diputus pengurus, lihat
  ///    getMyPayment) (AC F03-4).
  /// 6. 409 PROOF_VERSION_CONFLICT: `expected_proof_version` berbeda dari versi saat ini (bukti sudah diganti
  ///    dari perangkat lain).
  /// 7. 422 FILE_INVALID: berkas tidak ada, bukan milik pemanggil, bukan purpose payment_proof, belum siap,
  ///    atau sudah terpakai.
  ///
  /// [appPlatform]: Platform klien mobile; menentukan versi minimum yang diperiksa (PRD 4.5).
  /// [paymentId]: ID payment (UUID v7).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `PUT /me/payments/{paymentId}/proof` (operationId `submitPaymentProof`).
  Future<PaymentDetail> submitPaymentProof(
    String paymentId,
    SubmitPaymentProofRequest body, {
    DevicePlatform? appPlatform,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'submitPaymentProof',
        method: 'PUT',
        path: '/me/payments/${Uri.encodeComponent(paymentId)}/proof',
        authRequired: true,
        headers: <String, Object?>{
          if (appPlatform case final v?) 'X-App-Platform': v.toJson(),
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => PaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Batalkan instruksi iuran sebelum bukti dikirim (PRD 4.3).
  ///
  /// Hanya pemilik, hanya payment registration/renewal berstatus pending dengan `proof_version` 0
  /// (`actions.can_cancel`). Status menjadi cancelled, `cancelled_at`, alasan dan aktor tersimpan di histori;
  /// tidak membuka akses apa pun. Pembayaran tiket dibatalkan lewat pembatalan tiket di domain Events (F-09)
  /// agar kursi dilepas, sehingga ditolak di sini dengan PAYMENT_STATE_CONFLICT. Setelah dibatalkan anggota
  /// dapat membuat instruksi baru (nilai sesuai pengaturan terbaru).
  ///
  /// Galat: 409 PAYMENT_STATE_CONFLICT (bukan pending, bukti sudah ada, atau tiket) dan 409 VERSION_CONFLICT
  /// (If-Match usang), keduanya dengan `current` PaymentDetail; 409 IDEMPOTENCY_CONFLICT.
  ///
  /// [paymentId]: ID payment (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /me/payments/{paymentId}/cancel` (operationId `cancelMyPayment`).
  Future<PaymentDetail> cancelMyPayment(
    String paymentId,
    CancelPaymentRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'cancelMyPayment',
        method: 'POST',
        path: '/me/payments/${Uri.encodeComponent(paymentId)}/cancel',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => PaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kirim atau ganti rekening tujuan refund yang sedang diproses bendahara (D6, D2, PRD 3.9).
  ///
  /// Rekening tujuan refund diminta saat proses refund saja (D6, PRD 3.9). Pemilik payment menerima notifikasi
  /// kategori payment dengan deep link `/payments/{paymentId}` ketika refund dicatat (oleh bendahara atau oleh
  /// sistem saat event dibatalkan/pembatalan mandiri sampai H-3), lalu mengisi rekening tujuan di layar detail
  /// pembayaran (`adjustments[].destination_required`). Operasi ini juga dipakai untuk mengganti rekening yang
  /// salah selama refund masih pending.
  ///
  /// Prasyarat: pemanggil adalah pemilik payment, penyesuaian milik payment ini, kind `refund`, status pending.
  /// Nilai disimpan sementara di `payment_adjustments.refund_destination` dan dihapus saat refund selesai atau
  /// dibatalkan (D2, CHECK payment_adjustments_destination_chk) atau pada langkah akhir penghapusan akun (F-14).
  /// Nilai rekening tidak pernah dikembalikan dalam respons (hanya `has_refund_destination`), tidak dicatat di
  /// log, audit maupun ekspor (ARCHITECTURE §2 butir 3); audit `payment.refund_destination_set` hanya memuat
  /// id penyesuaian dan aktor. Bendahara melihat rekening di GET /admin/payment-adjustments/{adjustmentId}.
  ///
  /// Akses `any`: anggota expired atau suspended tetap dapat menerima refund (D6 "Anggota disuspend: refund
  /// diputuskan pengurus per kasus"), sehingga tetap dapat mengirim rekening tujuan. Satu conditional UPDATE
  /// (`status='pending' AND kind='refund' AND version=<If-Match>`); tidak ada kunci lain.
  ///
  /// Galat:
  /// - 400 VALIDATION_ERROR per field.
  /// - 404 NOT_FOUND: payment atau penyesuaian tidak ada, bukan milik pemanggil, atau penyesuaian bukan milik
  ///   payment ini (N-09).
  /// - 409 PAYMENT_STATE_CONFLICT: penyesuaian bukan refund atau sudah completed/cancelled; `current` berisi
  ///   PaymentDetail terbaru.
  /// - 409 VERSION_CONFLICT: If-Match berbeda dari `version` penyesuaian; `current` berisi PaymentDetail.
  ///
  /// [paymentId]: ID payment (UUID v7).
  /// [adjustmentId]: ID penyesuaian (UUID v7).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /me/payments/{paymentId}/adjustments/{adjustmentId}/refund-destination` (operationId `setMyRefundDestination`).
  Future<PaymentDetail> setMyRefundDestination(
    String paymentId,
    String adjustmentId,
    RefundDestinationInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'setMyRefundDestination',
        method: 'PUT',
        path: '/me/payments/${Uri.encodeComponent(paymentId)}/adjustments/${Uri.encodeComponent(adjustmentId)}/refund-destination',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => PaymentDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
