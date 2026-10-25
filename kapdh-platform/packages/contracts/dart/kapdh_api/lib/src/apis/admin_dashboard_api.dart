// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Dasbor pengurus yang hanya memuat data sesuai izin (F-15, AC F15-1, PRD 3.15).
///
/// Kelas API untuk tag kontrak "Admin Dashboard". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminDashboardApi {
  const AdminDashboardApi(this._dio);

  final Dio _dio;

  /// Dasbor pengurus sesuai izin, pekerjaan tertunda dan statistik (F-15, AC F15-1).
  ///
  /// Bagian dan izin yang dibutuhkan (super_admin menerima semua bagian):
  ///
  /// | bagian            | izin                              | isi                                                        |
  /// | ----------------- | --------------------------------- | ---------------------------------------------------------- |
  /// | `payments`        | payments.read                     | antrean bukti, lewat batas, penyesuaian, lunas, riwayat    |
  /// | `members`         | members.read                      | pengguna aktif dari total alumni, status, anggota terbaru  |
  /// | `events`          | events.manage                     | tiket terjual semua event, penjualan tiket per event       |
  /// | `upcoming_events` | events.manage atau events.checkin | event mendatang 30 hari                                    |
  /// | `moderation`      | moderation.read                   | laporan terbuka, mendesak, lewat target                    |
  /// | `jobs`            | notifications.manage              | kegagalan yang dapat ditindak, umur outbox, info deletion  |
  ///
  /// Admin tanpa izin apa pun tetap menerima `generated_at` saja. Semua hitungan dihitung server pada
  /// `generated_at` (UTC); usia antrean dihitung klien sebagai `generated_at` dikurangi waktu tertua agar tidak
  /// bergantung pada jam perangkat.
  ///
  /// Tabel dasbor hanya cuplikan (maksimal 10 baris); pencarian dan "lihat semua" memakai endpoint daftar
  /// domain pemiliknya dengan izin yang sama (PRD 3.15: pencarian/filter/paging server):
  ///
  /// - Riwayat Transaksi dan kotak "Cari nama atau nomor KTA...": GET
  ///   /admin/payments?status=paid&q=‹teks›&sort=decided_at_desc (adminListPayments, payments.read). `q`
  ///   mencari nama alumni atau awalan nomor anggota, sama dengan placeholder kotak cari; urutan decided_at_desc
  ///   sama dengan urutan `recent_transactions`, sehingga hasil tanpa `q` diawali baris yang sama dengan cuplikan.
  /// - Pengguna: GET /admin/members?sort=registered_desc (adminListMembers, members.read).
  /// - Penjualan Tiket: GET /admin/events (adminListEvents, events.manage).
  /// - Job gagal: GET /admin/notifications/deliveries?status=failed&retryable=true&from=‹jobs.failed_delivery_since›
  ///   dan GET /admin/notifications/outbox?status=dead (notifications.manage); total keduanya sama dengan
  ///   `jobs.failed_delivery_count` dan `jobs.dead_outbox_count`.
  ///
  /// Hitungan `payments` memakai definisi yang SAMA PERSIS dengan GET /admin/payments/summary
  /// (AdminPaymentSummary) dan filter GET /admin/payments (domain admin-payments), sehingga tautan "Lewat batas
  /// N" ke `/payments?stage=awaiting_review&overdue=true` menampilkan jumlah yang sama: lewat batas = waktu server
  /// melewati `review_due_at` (iuran: bukti dikirim + 1 hari kerja; tiket: yang lebih dahulu antara + 2 hari
  /// kerja (D5) dan pembukaan check-in event); hari kerja Senin sampai Jumat waktu Asia/Jakarta. Implementasi
  /// memakai satu query ringkasan bersama dengan modul payments, bukan rumus kedua.
  ///
  /// Auto-refresh dasbor oleh web admin mengirim X-Background-Request agar tidak memperpanjang idle timeout
  /// (AC F02-5); muat atau muat ulang yang dipicu pengguna tidak mengirimnya. Untuk polling lencana menu gunakan
  /// GET /admin/dashboard/badges yang lebih ringan.
  ///
  /// [backgroundRequest]: Isi `1` hanya pada request polling/refresh otomatis web admin. Request bertanda ini tidak memperbarui
  /// `sessions.last_activity_at`, sehingga idle timeout 30 menit tetap berjalan (AC F02-5, N-08). Request yang
  /// dipicu pengguna tidak boleh mengirim header ini. Nama dan bentuk sama dengan parameter
  /// AdminBackgroundRequest di domain admin-auth (C1); AuthGuard menghormatinya pada setiap operasi admin.
  ///
  /// `GET /admin/dashboard` (operationId `adminGetDashboard`).
  Future<AdminDashboard> adminGetDashboard({
    String? backgroundRequest,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetDashboard',
        method: 'GET',
        path: '/admin/dashboard',
        authRequired: true,
        headers: <String, Object?>{
          'X-Background-Request': ?backgroundRequest,
        },
        decode: (Object? v0) => AdminDashboard.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hitungan ringan untuk lencana menu laporan dan job gagal (F-15).
  ///
  /// Dipanggil berkala oleh web admin dengan header X-Background-Request sehingga tidak memperpanjang idle
  /// timeout sesi (AC F02-5). Field hanya ada bila pemanggil memiliki izinnya, sama dengan aturan bagian dasbor
  /// (AC F15-1).
  ///
  /// Pill emas menu "Verifikasi Pembayaran" (prototipe screen_8) TIDAK bersumber dari sini: sumber tunggalnya
  /// adalah `awaiting_review_count` pada GET /admin/payments/summary (domain admin-payments), yang juga
  /// di-polling dengan X-Background-Request oleh admin berizin payments.read. Endpoint ini hanya melayani
  /// lencana yang tidak dimiliki domain lain.
  ///
  /// [backgroundRequest]: Isi `1` hanya pada request polling/refresh otomatis web admin. Request bertanda ini tidak memperbarui
  /// `sessions.last_activity_at`, sehingga idle timeout 30 menit tetap berjalan (AC F02-5, N-08). Request yang
  /// dipicu pengguna tidak boleh mengirim header ini. Nama dan bentuk sama dengan parameter
  /// AdminBackgroundRequest di domain admin-auth (C1); AuthGuard menghormatinya pada setiap operasi admin.
  ///
  /// `GET /admin/dashboard/badges` (operationId `adminGetDashboardBadges`).
  Future<AdminNavBadges> adminGetDashboardBadges({
    String? backgroundRequest,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetDashboardBadges',
        method: 'GET',
        path: '/admin/dashboard/badges',
        authRequired: true,
        headers: <String, Object?>{
          'X-Background-Request': ?backgroundRequest,
        },
        decode: (Object? v0) => AdminNavBadges.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
