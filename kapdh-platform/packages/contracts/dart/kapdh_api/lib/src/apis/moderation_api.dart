// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Blokir pengguna, pelaporan penyalahgunaan dan banding oleh anggota (F-12).
///
/// Kelas API untuk tag kontrak "Moderation". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class ModerationApi {
  const ModerationApi(this._dio);

  final Dio _dio;

  /// Daftar anggota yang saya blokir (F-12, layar Akun > Diblokir).
  ///
  /// Hanya blokir yang dibuat pemanggil (blocker = pemanggil), terbaru dulu. Pemanggil tidak pernah diberi tahu
  /// siapa yang memblokir dirinya.
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /blocks` (operationId `listBlocks`).
  Future<BlockedMemberPage> listBlocks({
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listBlocks',
        method: 'GET',
        path: '/blocks',
        authRequired: true,
        queryParameters: <String, Object?>{
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => BlockedMemberPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Blokir anggota; berlaku dua arah untuk pesan direct dan undangan grup (AC F12-1).
  ///
  /// Idempoten: blokir yang sudah ada dikembalikan apa adanya. Memblokir diri sendiri -> 400 VALIDATION_ERROR
  /// (blocks_self_chk); akun alumni yang tidak ada -> 404. Efek setelah commit:
  /// - pengiriman pesan dan reaksi di room direct antara keduanya ditolak dari pihak mana pun (AC F12-1), walaupun
  ///   room/socket sudah ada; riwayat lama tetap dapat dibaca kedua pemilik room;
  /// - undangan grup antara keduanya ditolak, dan undangan tertunda dari salah satu pihak kepada yang lain
  ///   dibatalkan (event `room.member_changed` change=invitation_cancelled dengan actor_user_id null hanya ke
  ///   kanal user calon anggota dan admin grup, sehingga pembatalan tidak dapat dibedakan dari tindakan sistem
  ///   lain);
  /// - di grup yang sama, blokir tidak mengubah aturan room atau menghapus pesan orang lain; gunakan mute atau
  ///   laporan (PRD 3.12);
  /// - anggota yang diblokir tidak diberi tahu; perangkat pemanggil menerima `room.updated` untuk room direct
  ///   (changes berisi send_permission) bila room itu ada.
  ///
  /// [userId]: user_id akun alumni yang diblokir.
  ///
  /// `PUT /blocks/{userId}` (operationId `blockMember`).
  Future<BlockedMember> blockMember(
    String userId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'blockMember',
        method: 'PUT',
        path: '/blocks/${Uri.encodeComponent(userId)}',
        authRequired: true,
        decode: (Object? v0) => BlockedMember.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buka blokir; idempoten (F-12).
  ///
  /// Menghapus blokir yang dibuat pemanggil saja; blokir dari pihak lain tetap berlaku sehingga pesan direct
  /// tetap ditolak selama blokir pihak lain ada (AC F12-1). Blokir yang tidak ada tetap 204 (idempoten); user_id
  /// bukan UUID atau diri sendiri -> 400 VALIDATION_ERROR. Undangan yang sudah dibatalkan tidak dipulihkan.
  /// Perangkat pemanggil menerima `room.updated` (changes berisi send_permission) untuk room direct bila ada.
  ///
  /// [userId]: user_id akun alumni yang diblokir.
  ///
  /// `DELETE /blocks/{userId}` (operationId `unblockMember`).
  Future<void> unblockMember(
    String userId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'unblockMember',
        method: 'DELETE',
        path: '/blocks/${Uri.encodeComponent(userId)}',
        authRequired: true,
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Laporan dan banding yang saya kirim beserta statusnya (AC F12-2).
  ///
  /// Hanya laporan dengan reporter = pemanggil, terbaru dulu. Status dan hasil hanya terlihat oleh pelapor
  /// (AC F12-2); bukti dan identitas pengurus tidak dikirim. Tersedia untuk semua status anggota (riwayat sendiri).
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /reports` (operationId `listMyReports`).
  Future<ModerationReportPage> listMyReports({
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listMyReports',
        method: 'GET',
        path: '/reports',
        authRequired: true,
        queryParameters: <String, Object?>{
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => ModerationReportPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Laporkan pengguna, pesan, atau grup yang dapat diakses pelapor (AC F12-2, PRD 3.12).
  ///
  /// Hanya anggota aktif. `target_type` menentukan field wajib (field lain tidak boleh diisi, 400):
  /// - user: `target_user_id`, anggota lain yang terlihat di direktori bagi pelapor atau pernah berada di room yang
  ///   sama (keduanya pernah bergabung; undangan yang dibatalkan sebelum diterima tidak dihitung); selain itu 404.
  ///   Bukti: snapshot profil publik minimum (nama, bio, avatar).
  /// - message: `message_id`, pesan orang lain di room tempat pelapor anggota joined dan terlihat baginya; selain
  ///   itu 404. `context_message_ids` (maksimal 5, room sama, terlihat bagi pelapor) boleh ditambahkan sebagai
  ///   konteks. Bukti: snapshot pesan (isi, gambar, pengirim, waktu) sehingga tetap tersedia walaupun pesan
  ///   kemudian dihapus. Pengirim pesan menjadi pihak terlapor.
  /// - room: `room_id`, grup tempat pelapor anggota joined; room direct -> 400 (laporkan pengguna/pesannya).
  ///   Bukti: nama, avatar (rujukan berkas avatar saat itu) dan jumlah anggota grup.
  /// Berkas yang dirujuk bukti (gambar pesan, avatar profil/grup) ditahan selama laporan disimpan walaupun pesan
  /// dihapus atau avatar diganti; hanya dihapus sesuai retensi D2.
  /// Melaporkan diri sendiri -> 400 (gunakan POST /appeals untuk banding).
  ///
  /// Prioritas dan target penanganan dihitung server (v3.2, keputusan PP K5): violence_threat dan sexual = urgent,
  /// due_at 24 jam; kategori lain normal, due_at 2 hari kerja (Senin-Jumat WIB). Bila pelapor masih memiliki
  /// laporan aktif (open/in_review) atas target yang sama, laporan itu dikembalikan (200) tanpa membuat laporan
  /// baru. Pihak terlapor tidak diberi tahu (AC F12-2). Idempotency-Key mengembalikan hasil pertama saat diulang;
  /// laju pelaporan dibatasi (429).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /reports` (operationId `createReport`).
  Future<ModerationReport> createReport(
    CreateModerationReportRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'createReport',
        method: 'POST',
        path: '/reports',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => ModerationReport.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail status laporan atau banding milik sendiri (AC F12-2).
  ///
  /// Hanya pelapor; laporan milik orang lain -> 404 tanpa membedakan alasan (N-09). Tanpa bukti dan tanpa
  /// identitas pengurus. `decision_message` hanya terisi untuk banding (pesan pengurus kepada pemohon).
  ///
  /// `GET /reports/{reportId}` (operationId `getMyReport`).
  Future<ModerationReport> getMyReport(
    String reportId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getMyReport',
        method: 'GET',
        path: '/reports/${Uri.encodeComponent(reportId)}',
        authRequired: true,
        decode: (Object? v0) => ModerationReport.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ajukan banding atas suspend yang sedang berlaku dari portal pembatasan (PRD 3.12 mekanisme banding).
  ///
  /// Banding dicatat sebagai laporan berkategori `appeal` dengan target_type user dan target = pemohon sendiri,
  /// sehingga masuk antrean moderasi yang sama (prioritas normal, due_at 2 hari kerja). Dipanggil dari portal
  /// pembatasan aplikasi (PRD 2.2), sehingga tersedia walaupun pemohon suspended (member_access: any).
  ///
  /// Yang dapat dibanding di R1.0 hanya suspend yang SEDANG berlaku (alumni.suspended_at terisi, dari jalur
  /// mana pun: keputusan laporan atau menu anggota admin); selain itu 403 FORBIDDEN. Warn tidak dapat dibanding
  /// lewat endpoint ini karena tidak membatasi akses maupun mengubah tanggal keanggotaan (AC F12-3); keberatan
  /// atas peringatan disampaikan lewat kontak dukungan. Keputusan yang dibanding tidak dipilih klien: server
  /// menyimpan snapshot suspend yang berlaku (membership_events suspend terbaru, suspended_at, suspension_message)
  /// di bukti banding sehingga pengurus tahu persis keputusan mana yang dibanding.
  ///
  /// Satu banding aktif per pemohon. Transaksi mengunci baris alumni pemohon lebih dulu (SELECT ... FOR UPDATE,
  /// kunci yang sama dengan jalur suspend/unsuspend) sehingga pengajuan paralel dan pencabutan suspend
  /// berurutan. Bila masih ada banding open/in_review atas suspend yang SAMA (snapshot suspended_at = suspended_at
  /// yang berlaku), banding itu dikembalikan (200) tanpa membuat yang baru. Banding hanya dapat diputus dismiss
  /// (ditolak, outcome no_action) atau unsuspend (dikabulkan, outcome action_taken).
  ///
  /// Setiap jalur unsuspend menutup banding aktif pemohon sebagai dikabulkan dalam transaksi pencabutan itu
  /// (ketergantungan lintas domain, lihat POST /admin/reports/{reportId}/resolve). Jaring pengaman bila jalur itu
  /// terlewat: banding aktif yang usang (suspend yang dibandingnya sudah dicabut, lalu pemohon disuspend lagi
  /// dengan suspended_at berbeda) tidak pernah dikembalikan; dalam transaksi yang sama banding usang ditutup
  /// sebagai dikabulkan (status resolved, action unsuspend, outcome action_taken, tanpa perubahan keanggotaan)
  /// dan banding baru untuk suspend yang berlaku dibuat (201). Setelah banding ditolak, banding baru boleh
  /// diajukan (dibatasi laju). Hasil dikirim lewat notifikasi kategori account dan tampil di
  /// GET /reports/{reportId} (`outcome`, `decision_message`). Idempotency-Key mengembalikan hasil pertama saat
  /// diulang; laju dibatasi (429).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /appeals` (operationId `createAppeal`).
  Future<ModerationReport> createAppeal(
    CreateAppealRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'createAppeal',
        method: 'POST',
        path: '/appeals',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => ModerationReport.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
