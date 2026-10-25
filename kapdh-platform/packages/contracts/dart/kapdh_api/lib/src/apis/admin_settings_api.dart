// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Pengaturan terversi dan teraudit: biaya iuran, versi aplikasi minimum, maintenance, tautan toko, kontak
/// dukungan, instruksi iuran per platform dan nilai kebijakan baca-saja (F-15, AC F15-3, F15-4, D4, D13,
/// PRD 4.5).
///
///
/// Kelas API untuk tag kontrak "Admin Settings". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminSettingsApi {
  const AdminSettingsApi(this._dio);

  final Dio _dio;

  /// Seluruh pengaturan aplikasi beserta versinya (settings.manage, F-15).
  ///
  /// Halaman Pengaturan web admin. Kunci `membership`, `events` dan `chat` adalah nilai kebijakan yang
  /// disahkan PRD (D4, D5, D6, v3.2) dan hanya dapat dibaca; perubahannya melalui change request dan migrasi,
  /// bukan endpoint. Kunci `legal` dikelola penerbitan halaman (F-08) dan tidak ditampilkan di sini.
  ///
  /// `GET /admin/settings` (operationId `adminGetAppSettings`).
  Future<AdminAppSettings> adminGetAppSettings({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetAppSettings',
        method: 'GET',
        path: '/admin/settings',
        authRequired: true,
        decode: (Object? v0) => AdminAppSettings.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Komponen biaya iuran versi aktif (settings.manage, D4).
  ///
  /// Tab Biaya Pembayaran (guidelines p17). Nilai awal go-live: register alumni baru Rp50.000, pembuatan KTA
  /// Rp10.000, perpanjangan Rp10.000 per tahun (D4).
  ///
  /// `GET /admin/settings/fees` (operationId `adminGetFees`).
  Future<FeeSettings> adminGetFees({
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetFees',
        method: 'GET',
        path: '/admin/settings/fees',
        authRequired: true,
        decode: (Object? v0) => FeeSettings.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah nominal iuran; hanya berlaku untuk payment baru (settings.manage, AC F15-3).
  ///
  /// Nominal baru menjadi versi `fees` berikutnya dan hanya dipakai instruksi yang dibuat sesudahnya; payment
  /// yang sudah dibuat tetap memakai snapshot baris dan `settings_version` lamanya, termasuk saat diputus
  /// (AC F03-5, F15-3). Setiap nominal >= 0 dan <= 999999999999.99 (numeric(14,2)). Audit before/after dalam
  /// transaksi yang sama. If-Match usang menghasilkan 409 VERSION_CONFLICT dengan `current` FeeSettings
  /// (AC F15-4).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/settings/fees` (operationId `adminUpdateFees`).
  Future<FeeSettings> adminUpdateFees(
    FeeSettingsInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateFees',
        method: 'PUT',
        path: '/admin/settings/fees',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => FeeSettings.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah versi aplikasi minimum per platform (settings.manage, AC F15-3, PRD 4.5).
  ///
  /// Mutasi dari aplikasi di bawah versi ini ditolak 426 UPGRADE_REQUIRED dan klien menampilkan layar wajib
  /// update dengan tautan toko (PRD 4.5). Naikkan versi minimum hanya setelah versi baru dapat diunduh
  /// (PRD 8.4): server menolak (400 VALIDATION_ERROR) menaikkan versi platform yang tautan tokonya masih kosong.
  /// Nilai tampil di GET /public/config. Audit before/after; If-Match usang menghasilkan 409 VERSION_CONFLICT.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/settings/min-app-version` (operationId `adminUpdateMinAppVersion`).
  Future<AdminMinAppVersionSetting> adminUpdateMinAppVersion(
    AdminMinAppVersionInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateMinAppVersion',
        method: 'PUT',
        path: '/admin/settings/min-app-version',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMinAppVersionSetting.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Aktifkan atau akhiri mode maintenance (settings.manage, PRD 4.5, 8.4).
  ///
  /// Selama `active` true, mutasi anggota ditolak 503 MAINTENANCE kecuali refresh/logout dan pencabutan sesi; baca
  /// tetap terkendali dan API admin tetap berjalan (ARCHITECTURE §4.3), sehingga maintenance dapat diakhiri lewat
  /// endpoint ini cukup dengan If-Match. POST /auth/reauth dan POST /files dengan access token admin tetap
  /// dikecualikan agar tindakan kredensial admin dan unggahan pengurus tetap berjalan. Saat mengaktifkan,
  /// `message` wajib diisi (rentang estimasi dan kanal dukungan, PRD 4.5) dan `until` (perkiraan selesai) bila
  /// diisi harus di masa depan.
  /// Status tampil di GET /public/config. Audit before/after; If-Match usang menghasilkan 409 VERSION_CONFLICT.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/settings/maintenance` (operationId `adminUpdateMaintenance`).
  Future<AdminMaintenanceSetting> adminUpdateMaintenance(
    AdminMaintenanceInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateMaintenance',
        method: 'PUT',
        path: '/admin/settings/maintenance',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminMaintenanceSetting.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah tautan aplikasi di toko (settings.manage, PRD 4.5, 5.2).
  ///
  /// Tautan dipakai layar wajib update dan situs publik (unduh aplikasi). Hanya https ke Google Play
  /// (play.google.com) dan App Store (apps.apple.com) agar tautan aman (PRD 5.2); null mengosongkan.
  /// Audit before/after; If-Match usang menghasilkan 409 VERSION_CONFLICT.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/settings/store-links` (operationId `adminUpdateStoreLinks`).
  Future<AdminStoreLinksSetting> adminUpdateStoreLinks(
    AdminStoreLinksInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateStoreLinks',
        method: 'PUT',
        path: '/admin/settings/store-links',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminStoreLinksSetting.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Sembunyikan atau tampilkan instruksi bayar iuran per platform (settings.manage, D13).
  ///
  /// Rencana cadangan D13 (PRD 10.1, 10.2): bila review toko menolak alur iuran (misalnya Apple 3.1.1), platform
  /// tersebut dimasukkan ke `dues_hidden_platforms`. Untuk request dengan header `X-App-Platform` platform itu:
  /// - GET /me/fees dan detail payment iuran mengembalikan `instructions_hidden` true, sehingga aplikasi tidak
  ///   menampilkan rekening tujuan, ajakan transfer maupun unggah bukti iuran, dan mengarahkan anggota ke kontak
  ///   dukungan;
  /// - server menolak pembuatan instruksi, ganti metode dan kirim bukti iuran dengan 403 FORBIDDEN;
  /// - pengurus mencatat iuran yang dananya diverifikasi di luar aplikasi lewat POST /admin/payments.
  /// Pembayaran tiket tidak terpengaruh, karena tiket adalah layanan yang dinikmati di luar aplikasi (D13).
  /// Nilai awal go-live: kosong (semua platform menampilkan instruksi).
  ///
  /// Header platform dikirim klien dan bukan batas keamanan. Aplikasi versi lama yang belum mengenal pengaturan
  /// ini dipaksa memperbarui lewat versi aplikasi minimum (PUT /admin/settings/min-app-version). Audit
  /// before/after dalam transaksi yang sama; If-Match usang menghasilkan 409 VERSION_CONFLICT dengan `current`
  /// AdminPaymentInstructionsSetting terbaru (AC F15-4).
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/settings/payment-instructions` (operationId `adminUpdatePaymentInstructions`).
  Future<AdminPaymentInstructionsSetting> adminUpdatePaymentInstructions(
    AdminPaymentInstructionsInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdatePaymentInstructions',
        method: 'PUT',
        path: '/admin/settings/payment-instructions',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminPaymentInstructionsSetting.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah kontak dukungan anggota (settings.manage, PRD 8.3).
  ///
  /// Kontak tampil di aplikasi ("Hubungi pengurus", prototipe screen_5), portal pembatasan dan situs publik.
  /// Karena anggota dapat diarahkan ke kontak ini untuk urusan iuran, setiap perubahan diaudit. Awal go-live:
  /// bantuan@kapdh.or.id dan satu nomor WhatsApp admin (PRD 8.3). Audit before/after; If-Match usang menghasilkan
  /// 409 VERSION_CONFLICT.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PUT /admin/settings/support` (operationId `adminUpdateSupportContact`).
  Future<AdminSupportSetting> adminUpdateSupportContact(
    AdminSupportInput body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminUpdateSupportContact',
        method: 'PUT',
        path: '/admin/settings/support',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminSupportSetting.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
