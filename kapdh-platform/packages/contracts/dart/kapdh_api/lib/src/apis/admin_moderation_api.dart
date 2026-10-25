// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Antrean laporan, bukti terminimalkan dan penyelesaian moderasi oleh pengurus (F-12, F-15).
///
/// Kelas API untuk tag kontrak "Admin Moderation". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class AdminModerationApi {
  const AdminModerationApi(this._dio);

  final Dio _dio;

  /// Antrean laporan dengan filter status, prioritas, kategori dan SLA (izin moderation.read, F-12).
  ///
  /// Bawaan `status=active` (open + in_review) urut `due` (due_at naik, lalu created_at) sehingga laporan urgent
  /// dan yang lewat target tampil lebih dulu. `overdue=true` hanya laporan aktif yang melewati due_at. `q`
  /// mencari nama atau nomor anggota pihak terlapor/pemohon. Paging keyset dengan `total` sesuai filter dan
  /// `counts` ringkas untuk badge menu (tidak terpengaruh filter). Item antrean tidak memuat bukti, deskripsi
  /// pelapor maupun identitas pelapor (minimisasi, PRD 3.12); buka detail untuk menilai.
  ///
  /// Konflik kepentingan (aturan domain butir a): laporan yang pihak terlapornya adalah akun alumni tertaut
  /// pemanggil dikecualikan dari `items`, `total`, `counts` dan hasil `q`, termasuk laporan grup yang pemanggilnya
  /// anggota joined grup itu dan laporan yang subjeknya kemudian ditetapkan lewat subject_user_id. Pemanggil tidak
  /// melihat baris, kategori, maupun jumlahnya. Hitungan laporan di dasbor dan lencana menu memakai aturan yang
  /// sama (aturan domain butir c) sehingga selalu sama dengan `counts` di sini.
  ///
  /// [status]: Saringan status; bawaan active (open + in_review).
  /// [overdue]: true = hanya laporan aktif yang melewati target penanganan.
  /// [q]: Nama atau nomor anggota pihak terlapor/pemohon.
  /// [sort]: Urutan; bawaan due.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/reports` (operationId `adminListReports`).
  Future<AdminModerationReportPage> adminListReports({
    AdminModerationStatusFilter? status,
    ModerationReportPriority? priority,
    ModerationReportCategory? category,
    ModerationTargetType? targetType,
    bool? overdue,
    String? q,
    AdminModerationSort? sort,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListReports',
        method: 'GET',
        path: '/admin/reports',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          if (priority case final v?) 'priority': v.toJson(),
          if (category case final v?) 'category': v.toJson(),
          if (targetType case final v?) 'target_type': v.toJson(),
          'overdue': ?overdue,
          'q': ?q,
          if (sort case final v?) 'sort': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminModerationReportPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail laporan beserta bukti terminimalkan; setiap akses diaudit (izin moderation.read, PRD 3.12).
  ///
  /// Memuat bukti snapshot saat laporan dibuat (pesan dilaporkan dan konteks, profil, atau grup), pelapor,
  /// pihak terlapor dengan status keanggotaan terkini, riwayat moderasi pihak terlapor, dan keputusan bila sudah
  /// ada. Pengurus tidak dapat menjelajah chat lain di luar bukti (PRD 3.12). Setiap pembacaan menulis audit
  /// `moderation.report_viewed` (aktor, laporan, request_id) sebelum respons dikirim; kegagalan audit membatalkan
  /// respons (AC F17-1). URL gambar bukti bertanda tangan maksimal 10 menit. Data pihak yang akunnya sudah dihapus
  /// tampil anonim (null) sesuai D2. Konflik kepentingan: pemanggil yang tertaut ke pihak terlapor mendapat 404
  /// NOT_FOUND (sama dengan laporan yang tidak ada, tanpa audit pembacaan bukti); pemanggil yang tertaut ke pelapor
  /// boleh membaca dengan `conflict_of_interest` true.
  ///
  /// `GET /admin/reports/{reportId}` (operationId `adminGetReport`).
  Future<AdminModerationReportDetail> adminGetReport(
    String reportId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminGetReport',
        method: 'GET',
        path: '/admin/reports/${Uri.encodeComponent(reportId)}',
        authRequired: true,
        decode: (Object? v0) => AdminModerationReportDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Klaim laporan untuk ditinjau (status in_review) atau ambil alih klaim (moderation.resolve, F-12).
  ///
  /// Mengubah open -> in_review dan mencatat pengurus peninjau (claimed_by, claimed_at) dengan UPDATE bersyarat
  /// versi. Laporan in_review milik pengurus lain dapat diambil alih bila If-Match sama dengan versi yang dibaca
  /// (pengurus sudah melihat klaim sebelumnya); klaim ulang oleh pengurus yang sama idempoten. Versi berbeda atau
  /// laporan sudah diputus -> 409 VERSION_CONFLICT dengan `current` = AdminModerationReportDetail terbaru.
  /// Konflik kepentingan: tertaut ke pihak terlapor -> 404 NOT_FOUND; tertaut ke pelapor -> 403 FORBIDDEN.
  /// Audit `moderation.report_claimed` dalam transaksi yang sama. Respons memuat bukti sehingga setiap klaim,
  /// termasuk klaim ulang idempoten, juga menulis audit `moderation.report_viewed` sebelum respons dikirim.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/reports/{reportId}/claim` (operationId `adminClaimReport`).
  Future<AdminModerationReportDetail> adminClaimReport(
    String reportId, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminClaimReport',
        method: 'POST',
        path: '/admin/reports/${Uri.encodeComponent(reportId)}/claim',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (Object? v0) => AdminModerationReportDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Putus laporan dengan dismiss, warn, suspend atau unsuspend (moderation.resolve, AC F12-3..F12-5).
  ///
  /// Satu keputusan per laporan: laporan wajib open/in_review dan versinya sama dengan If-Match; selain itu 409
  /// VERSION_CONFLICT dengan `current` = AdminModerationReportDetail terbaru (keputusan pengurus lain menang).
  /// Klaim lebih dulu tidak wajib. Konflik kepentingan: tertaut ke pihak terlapor -> 404 NOT_FOUND; tertaut ke
  /// pelapor -> 403 FORBIDDEN; `subject_user_id` = akun tertaut pemanggil -> 403 FORBIDDEN (pengurus tidak
  /// memutus perkara dirinya sendiri). Semuanya atomik dalam satu transaksi: status laporan, efek keanggotaan,
  /// membership_events, audit (alasan, aktor, waktu, rujukan bukti; AC F12-3, F17-1) dan outbox notifikasi.
  ///
  /// Pihak yang dikenai tindakan (subjek) = target_user_id laporan; untuk laporan grup subjek wajib dipilih lewat
  /// `subject_user_id` (anggota atau mantan anggota grup itu yang pernah bergabung; undangan yang dibatalkan
  /// sebelum diterima tidak dihitung) dan disimpan sebagai pihak terlapor laporan
  /// (sejak itu laporan tunduk pada aturan konflik butir a untuk akun subjek tersebut).
  /// - dismiss: tidak ada perubahan pada anggota; status dismissed. Untuk banding berarti banding ditolak.
  /// - warn: membership_events kind warn tanpa mengubah starts_at/expires_at (AC F12-3); subjek menerima
  ///   notifikasi kategori account berisi `member_message`; status resolved.
  /// - suspend (wajib `confirm: true`, PRD 4.5): subjek belum suspended (selain itu 400). Mengisi suspended_at,
  ///   suspension_reason = `note` (internal), suspension_message = `member_message` (ditampilkan ke anggota),
  ///   membership_events suspend; tanggal periode tidak dibuang (PRD 4.2). Setelah commit seluruh sesi umum
  ///   dicabut (`session.revoked` reason account_suspended) dan socket diputus, akses komunitas ditolak, profil
  ///   hilang dari direktori, verifikasi KTA menjadi Tidak aktif, dan tiket tidak berlaku (AC F12-4, PRD 2.2).
  /// - unsuspend (wajib `confirm: true`): subjek sedang suspended (selain itu 400, kecuali banding usang di
  ///   bawah). Menghapus suspend dan membership_events unsuspend; effective_status dihitung ulang dari expires_at
  ///   sehingga anggota yang masa aktifnya habis menjadi expired, bukan otomatis verified (AC F12-5). Dalam
  ///   transaksi yang sama (di bawah kunci baris alumni subjek), banding aktif lain milik subjek ditutup sebagai
  ///   dikabulkan (status resolved, action unsuspend, catatan merujuk laporan ini) dan pemohonnya menerima
  ///   hasilnya (notifikasi kategori account, outcome action_taken).
  /// Banding (kategori appeal) hanya boleh dismiss (banding ditolak; suspend tetap berlaku) atau unsuspend
  /// (banding dikabulkan); tindakan lain -> 400 VALIDATION_ERROR. Banding usang =
  /// `evidence.contested_suspension.in_force` false, yaitu suspend yang dibanding sudah dicabut lewat jalur yang
  /// tidak menutup bandingnya (lihat ketergantungan di bawah). Untuk banding usang hanya `unsuspend` yang
  /// diterima: banding ditutup sebagai dikabulkan TANPA mengubah keanggotaan (tidak ada membership_events, tidak
  /// ada pencabutan sesi, suspend baru yang mungkin berlaku tidak dicabut; audit mencatat keanggotaan tidak
  /// berubah). `dismiss` atas banding usang -> 400 VALIDATION_ERROR pada field action, karena pemohon tidak boleh
  /// menerima "banding ditolak" untuk suspend yang sudah dicabut.
  ///
  /// Ketergantungan lintas domain (MEMBLOKIR rilis modul moderasi; belum tercantum di admin-members.yaml):
  /// adminUnsuspendMember dan setiap jalur unsuspend lain wajib memakai fungsi kernel keanggotaan yang sama
  /// dengan keputusan ini (mis. MembershipKernel.unsuspend) yang, dalam transaksi pencabutan itu, juga menutup
  /// banding aktif subjek sebagai dikabulkan dan menjadwalkan notifikasi hasilnya. Aturan banding usang di atas
  /// dan di POST /appeals hanya jaring pengaman bila ketergantungan itu terlewat.
  ///
  /// `remove_message=true` (hanya laporan pesan) menjadikan pesan terlapor placeholder dan mengirim
  /// `message.deleted`; snapshot bukti tetap tersimpan.
  /// Pelapor menerima notifikasi kategori account bahwa laporannya selesai ditinjau (tanpa rincian tindakan,
  /// AC F12-2); pemohon banding menerima `member_message`.
  ///
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /admin/reports/{reportId}/resolve` (operationId `adminResolveReport`).
  Future<AdminModerationReportDetail> adminResolveReport(
    String reportId,
    AdminModerationResolveRequest body, {
    required String ifMatch,
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminResolveReport',
        method: 'POST',
        path: '/admin/reports/${Uri.encodeComponent(reportId)}/resolve',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => AdminModerationReportDetail.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Calon subjek laporan grup, yaitu anggota dan mantan anggota grup (moderation.resolve, AC F12-3, F12-4).
  ///
  /// Sumber pilihan `subject_user_id` pada adminResolveReport untuk laporan grup (`target_type` room). Bukti
  /// laporan grup hanya memuat nama, avatar dan jumlah anggota (createReport, PRD 3.12), sehingga daftar ini
  /// satu-satunya cara pengurus memilih anggota yang dikenai warn/suspend tanpa menjelajah chat. Isinya memakai
  /// aturan yang SAMA dengan validasi `subject_user_id`: anggota grup yang pernah bergabung (status joined, atau
  /// left/removed setelah pernah bergabung; undangan yang dibatalkan sebelum diterima tidak dihitung). Akun yang
  /// sudah dihapus (D2) dan akun alumni tertaut pemanggil (pengurus tidak memutus perkara dirinya sendiri) tidak
  /// dicantumkan. Setiap butir hanya identitas minimum tanpa kontak dan tanpa isi chat, ditambah status
  /// keanggotaan terkini agar UI menawarkan suspend hanya untuk anggota yang belum disuspend. Urutan: anggota
  /// joined berperan admin grup, anggota joined lain, lalu mantan anggota; dalam kelompok nama naik. `q` mencari
  /// nama atau awalan nomor anggota. Paging keyset dengan cursor terikat `q` yang sama.
  ///
  /// Hanya laporan grup yang masih aktif (open/in_review); laporan selain grup atau yang sudah diputus -> 400
  /// VALIDATION_ERROR. Konflik kepentingan sama dengan adminGetReport (aturan domain butir a dan b): tertaut ke
  /// pihak terlapor (termasuk anggota joined grup itu) -> 404 NOT_FOUND; tertaut ke pelapor -> 403 FORBIDDEN.
  /// Pembacaan dicatat di audit seperti pembacaan bukti (`moderation.report_viewed`, aktor, laporan, request_id;
  /// daftar anggota tidak disalin ke audit) dalam transaksi yang sama sebelum respons dikirim (PRD 3.12, AC F17-1).
  ///
  /// [q]: Nama atau awalan nomor anggota.
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /admin/reports/{reportId}/subject-candidates` (operationId `adminListReportSubjectCandidates`).
  Future<AdminModerationSubjectCandidatePage> adminListReportSubjectCandidates(
    String reportId, {
    String? q,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'adminListReportSubjectCandidates',
        method: 'GET',
        path: '/admin/reports/${Uri.encodeComponent(reportId)}/subject-candidates',
        authRequired: true,
        queryParameters: <String, Object?>{
          'q': ?q,
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => AdminModerationSubjectCandidatePage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
