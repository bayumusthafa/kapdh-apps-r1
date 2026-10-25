// DIBANGKITKAN oleh packages/contracts/scripts/gen-dart.mjs dari kontrak KAPDH (PRD 5.2, N-13).
// JANGAN DISUNTING. Ubah openapi/root.yaml, openapi/domains/*.yaml atau packages/shared lalu jalankan
// `pnpm contracts:gen` di kapdh-platform.

import 'package:dio/dio.dart';

import '../models.dart';
import '../runtime/json.dart';
import '../runtime/request.dart';

/// Chat langsung dan grup, undangan, pesan keyset, status baca dan reaksi (F-11, PRD 5.2).
///
/// Kelas API untuk tag kontrak "Chat". Berikan [Dio] aplikasi (baseUrl berakhiran `/api/v1`, interceptor auth/refresh); setiap kegagalan dilempar sebagai [ApiException].
class ChatApi {
  const ChatApi(this._dio);

  final Dio _dio;

  /// Daftar room milik sendiri (tab Pesan dan Pesan Grup) dengan unread dan pratinjau terakhir (F-11).
  ///
  /// Hanya room dengan keanggotaan joined milik pemanggil. Room direct yang belum memiliki pesan tidak
  /// ditampilkan. Urutan: aktivitas terakhir (last_message_at, lalu created_at) menurun, keyset stabil.
  /// `unread_count` = pesan dari anggota lain sesudah read cursor pemanggil dan sesudah history_visible_from,
  /// tanpa pesan yang sudah dihapus (dibatasi 999). Halaman juga membawa jumlah undangan grup tertunda dan jumlah
  /// room yang memiliki pesan belum dibaca untuk badge navigasi.
  ///
  /// [kind]: Saring jenis room (direct untuk tab Pesan, group untuk tab Pesan Grup).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /chat/rooms` (operationId `listChatRooms`).
  Future<ChatRoomPage> listChatRooms({
    ChatRoomKind? kind,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listChatRooms',
        method: 'GET',
        path: '/chat/rooms',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (kind case final v?) 'kind': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => ChatRoomPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buat grup; pembuat menjadi admin dan calon anggota menerima undangan (F-11, PRD 3.11).
  ///
  /// Pembuat langsung joined dengan peran admin. Setiap `invitee_user_ids` diproses seperti
  /// POST /chat/rooms/{roomId}/invitations: calon anggota berstatus invited dan harus menerima sendiri; yang tidak
  /// dapat diundang (bukan anggota aktif, blokir dua arah dengan pembuat, tersembunyi dari direktori tanpa pernah
  /// satu grup dengan pembuat, kapasitas 100) dilewati dengan alasan di
  /// `invitations.skipped`, tanpa membatalkan pembuatan grup. Undangan masuk kotak masuk penerima (kategori chat,
  /// deep link `/chat/invitations`) dan event realtime `room.member_changed` (change=invited) hanya ke kanal
  /// user:‹id› penerima dan admin grup (bukan kanal room).
  /// Berkas avatar wajib purpose chat_image milik pemanggil yang sudah diunggah lewat POST /files.
  /// Idempotency-Key mengembalikan hasil pertama saat diulang (PRD 4.3); laju pembuatan grup dibatasi (429).
  ///
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /chat/rooms` (operationId `createChatGroup`).
  Future<ChatGroupCreated> createChatGroup(
    ChatGroupCreateRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'createChatGroup',
        method: 'POST',
        path: '/chat/rooms',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => ChatGroupCreated.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Buka atau buat room direct kanonik dengan anggota lain; idempoten (AC F11-1, F12-1).
  ///
  /// Mengembalikan room direct yang sudah ada (200) atau membuat room baru (201) dengan direct_key kanonik
  /// `min(a,b):max(a,b)`. Pembuatan bersamaan dari dua perangkat/pihak menghasilkan satu room (unique
  /// rooms_direct_key_key + ON CONFLICT, AC F11-1); pemanggil yang kalah balapan menerima room yang sama.
  ///
  /// Diri sendiri -> 400 VALIDATION_ERROR. Pemanggil memblokir lawan bicara -> 403 FORBIDDEN tanpa membuat room
  /// baru (AC F12-1; pemanggil sudah mengetahui blokirnya sendiri dan UI menawarkan "Buka blokir"); room lama
  /// tetap dapat dibuka lewat GET /chat/rooms/{roomId} untuk membaca riwayat.
  ///
  /// Blokir oleh lawan bicara TIDAK diungkap (N-09, AC F12-1): diperlakukan persis seperti lawan bicara yang tidak
  /// tersedia. Room direct yang sudah ada selalu dikembalikan (200) bila pemanggil tidak memblokir, walaupun lawan
  /// bicara tidak lagi aktif atau memblokir pemanggil (`can_send` false, `send_restriction` peer_unavailable).
  /// Room baru hanya dibuat bila lawan bicara akun aktif dengan effective_status verified/expiring yang tidak
  /// suspended, tidak memblokir pemanggil, dan terlihat di direktori bagi pemanggil atau pernah menjadi anggota
  /// grup yang sama; selain itu 404 NOT_FOUND dengan kode dan pesan yang sama untuk semua alasan (konsisten dengan
  /// GET /directory/{userId} yang juga 404 bila lawan bicara memblokir pemanggil).
  ///
  /// `POST /chat/direct` (operationId `openDirectRoom`).
  Future<ChatRoom> openDirectRoom(
    ChatDirectRoomRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'openDirectRoom',
        method: 'POST',
        path: '/chat/direct',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => ChatRoom.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Detail room untuk anggota joined, termasuk izin kirim dan read cursor (F-11, AC F11-4).
  ///
  /// Hanya anggota joined; selain itu 404 NOT_FOUND (AC F11-4). `can_send` false beserta `send_restriction`
  /// bila pengiriman ditolak server: blokir dua arah di room direct (AC F12-1), lawan bicara tidak lagi aktif,
  /// atau grup ditutup; blokir oleh lawan bicara dilaporkan sebagai peer_unavailable (lihat ChatSendRestriction).
  /// `peer_last_read_message_id` (room direct) dipakai untuk status "terbaca". Riwayat lama tetap dapat dibaca
  /// walaupun ada blokir (PRD 3.12).
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  ///
  /// `GET /chat/rooms/{roomId}` (operationId `getChatRoom`).
  Future<ChatRoom> getChatRoom(
    String roomId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'getChatRoom',
        method: 'GET',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}',
        authRequired: true,
        decode: (Object? v0) => ChatRoom.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Ubah nama atau avatar grup; hanya admin grup (F-11).
  ///
  /// Hanya room group dan hanya anggota joined berperan admin (`can_manage` true); anggota biasa atau grup yang
  /// sudah ditutup -> 403 FORBIDDEN, room direct -> 400 VALIDATION_ERROR. Versi room wajib dikirim di If-Match;
  /// versi berbeda -> 409 VERSION_CONFLICT dengan `current` = ChatRoom terbaru (pola konflik AC F15-4). Nama
  /// dipangkas server dan tidak boleh kosong (rooms_name_chk). Avatar memakai berkas purpose chat_image milik
  /// pemanggil yang siap (status ready); `avatar_file_id: null` menghapus avatar. Perubahan dikirim ke anggota
  /// lewat event `room.updated` (changes group_name/group_avatar) dan pesan sistem.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [ifMatch]: Versi objek yang dibaca klien (`version`). Versi berbeda menghasilkan 409 VERSION_CONFLICT dengan
  /// `current` berisi keadaan terbaru (AC F15-4).
  ///
  /// `PATCH /chat/rooms/{roomId}` (operationId `updateChatRoom`).
  Future<ChatRoom> updateChatRoom(
    String roomId,
    ChatRoomUpdate body, {
    required String ifMatch,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'updateChatRoom',
        method: 'PATCH',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}',
        authRequired: true,
        headers: <String, Object?>{
          'If-Match': ifMatch,
        },
        data: body.toJson(),
        decode: (Object? v0) => ChatRoom.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Daftar anggota room (info grup); undangan tertunda hanya untuk admin grup (F-11).
  ///
  /// Hanya anggota joined. Bawaan `status=joined`. `status=invited` (undangan tertunda) hanya untuk admin grup;
  /// anggota biasa -> 403 FORBIDDEN. Anggota yang sudah keluar/dikeluarkan/menolak tidak ditampilkan. Urutan:
  /// admin dulu, lalu nama. Yang ditampilkan hanya nama dan avatar (tanpa kontak) walaupun anggota menyembunyikan
  /// diri dari direktori. `last_read_message_id` per anggota dipakai untuk status "terbaca" di grup.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [status]: joined (bawaan) atau invited (khusus admin grup).
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /chat/rooms/{roomId}/members` (operationId `listChatRoomMembers`).
  Future<ChatRoomMemberPage> listChatRoomMembers(
    String roomId, {
    ChatMemberListStatus? status,
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listChatRoomMembers',
        method: 'GET',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/members',
        authRequired: true,
        queryParameters: <String, Object?>{
          if (status case final v?) 'status': v.toJson(),
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => ChatRoomMemberPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Keluarkan anggota atau batalkan undangan tertunda; hanya admin grup (F-11, AC F11-4).
  ///
  /// Hanya admin grup pada room group. Target joined menjadi removed (history dan subscription socket-nya dicabut
  /// seketika, AC F11-4; event `room.member_changed` change=removed ke kanal room dan kanal user target); target
  /// invited menjadi removed (undangan dibatalkan; event change=invitation_cancelled hanya ke kanal user calon
  /// anggota dan admin grup). Diri sendiri -> 400 VALIDATION_ERROR (pakai POST /chat/rooms/{roomId}/leave).
  /// Target yang tidak joined/invited -> 404. Mengulang permintaan dengan Idempotency-Key yang sama mengembalikan
  /// hasil pertama.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [userId]: user_id anggota room.
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `DELETE /chat/rooms/{roomId}/members/{userId}` (operationId `removeChatRoomMember`).
  Future<void> removeChatRoomMember(
    String roomId,
    String userId, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'removeChatRoomMember',
        method: 'DELETE',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/members/${Uri.encodeComponent(userId)}',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Promosikan atau turunkan peran anggota grup; hanya admin grup (F-11, AC F11-5).
  ///
  /// Hanya admin grup pada room group; target wajib anggota joined (selain itu 404). Menurunkan admin terakhir
  /// (termasuk diri sendiri) ditolak 400 VALIDATION_ERROR agar grup selalu memiliki admin (AC F11-5). Perubahan
  /// dikirim lewat event `room.member_changed` (change=role_changed) dan pesan sistem.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [userId]: user_id anggota room.
  ///
  /// `PATCH /chat/rooms/{roomId}/members/{userId}` (operationId `updateChatRoomMember`).
  Future<ChatRoomMember> updateChatRoomMember(
    String roomId,
    String userId,
    ChatMemberUpdate body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'updateChatRoomMember',
        method: 'PATCH',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/members/${Uri.encodeComponent(userId)}',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => ChatRoomMember.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Undang anggota ke grup; hanya admin grup, calon anggota wajib menerima (F-11, F-12).
  ///
  /// Hanya admin grup pada room group yang belum ditutup (anggota biasa -> 403 FORBIDDEN). Per pengguna:
  /// - diundang (status invited, invited_by = pemanggil) bila anggota aktif (verified/expiring, tidak suspended),
  ///   tidak ada blokir dua arah antara pemanggil dan calon anggota (F-12), dan calon anggota terlihat di
  ///   direktori bagi pemanggil atau pernah menjadi anggota joined grup yang sama dengannya (syarat yang sama
  ///   dengan POST /chat/direct; PRD 3.10, N-09);
  /// - dilewati dengan alasan: already_member, already_invited, room_full (joined + invited sudah 100), atau
  ///   not_invitable (bukan anggota aktif, akun tidak ada, diri sendiri, blokir, atau tersembunyi dari direktori
  ///   tanpa pernah satu grup; alasan tidak dibedakan).
  /// Undangan ulang setelah left/declined/removed diperbolehkan. Kapasitas dihitung di bawah kunci baris room
  /// sehingga undangan paralel tidak melampaui 100. Penerima mendapat notifikasi inbox (kategori chat) dan event
  /// `room.member_changed` (change=invited) yang hanya dikirim ke kanal user:‹id› penerima dan admin grup, tidak
  /// ke kanal room, karena undangan tertunda hanya terlihat oleh admin grup. Idempotency-Key mengembalikan hasil
  /// pertama saat diulang.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /chat/rooms/{roomId}/invitations` (operationId `inviteChatMembers`).
  Future<ChatInviteOutcome> inviteChatMembers(
    String roomId,
    ChatInviteRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'inviteChatMembers',
        method: 'POST',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/invitations',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (Object? v0) => ChatInviteOutcome.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Undangan grup tertunda milik sendiri (F-11).
  ///
  /// Hanya undangan berstatus invited untuk pemanggil pada grup yang belum ditutup, terbaru dulu. Pengguna tidak
  /// dipaksa masuk: undangan tetap tertunda sampai diterima, ditolak, atau dibatalkan admin grup.
  ///
  /// [cursor]: Cursor opaque dari `next_cursor` halaman sebelumnya. Kosongkan untuk halaman pertama.
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /chat/invitations` (operationId `listChatInvitations`).
  Future<ChatInvitationPage> listChatInvitations({
    String? cursor,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listChatInvitations',
        method: 'GET',
        path: '/chat/invitations',
        authRequired: true,
        queryParameters: <String, Object?>{
          'cursor': ?cursor,
          'limit': ?limit,
        },
        decode: (Object? v0) => ChatInvitationPage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Terima undangan grup; riwayat terlihat sejak bergabung (F-11, PRD 3.11).
  ///
  /// Mengubah keanggotaan invited milik pemanggil menjadi joined (joined_at = history_visible_from = waktu
  /// server) di bawah kunci baris room; kapasitas 100 tetap diperiksa. Pesan sistem "bergabung" ditulis (aturan
  /// urutan created_at domain ini) dan event `room.member_changed` (change=joined) dikirim ke kanal room dan kanal
  /// user pemanggil; socket pemanggil bergabung ke room. Bila sudah joined,
  /// room dikembalikan apa adanya (idempoten). Tidak ada undangan tertunda -> 404; grup ditutup -> 404.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /chat/invitations/{roomId}/accept` (operationId `acceptChatInvitation`).
  Future<ChatRoom> acceptChatInvitation(
    String roomId, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'acceptChatInvitation',
        method: 'POST',
        path: '/chat/invitations/${Uri.encodeComponent(roomId)}/accept',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (Object? v0) => ChatRoom.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tolak undangan grup (F-11).
  ///
  /// Mengubah keanggotaan invited milik pemanggil menjadi declined. Sudah declined -> 204 (idempoten); tidak ada
  /// undangan -> 404. Event `room.member_changed` (change=declined) hanya dikirim ke kanal user:‹id› admin grup
  /// dan perangkat lain pemanggil, tidak ke kanal room; anggota biasa tidak mengetahui siapa yang menolak.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /chat/invitations/{roomId}/decline` (operationId `declineChatInvitation`).
  Future<void> declineChatInvitation(
    String roomId, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'declineChatInvitation',
        method: 'POST',
        path: '/chat/invitations/${Uri.encodeComponent(roomId)}/decline',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Keluar dari grup; admin terakhir wajib menunjuk pengganti (AC F11-5, F11-4).
  ///
  /// Hanya room group (room direct -> 400 VALIDATION_ERROR; gunakan mute atau blokir). Bila pemanggil admin
  /// terakhir dan masih ada anggota joined lain, `successor_user_id` (anggota joined lain) wajib; tanpa itu 400
  /// VALIDATION_ERROR pada field successor_user_id (AC F11-5). Pengganti dipromosikan dan pemanggil keluar dalam
  /// satu transaksi. Bila pemanggil anggota terakhir, grup ditutup (closed_at) dan undangan tertunda dibatalkan
  /// (event change=invitation_cancelled dengan actor_user_id null ke kanal user:‹id› setiap calon anggota).
  /// Setelah commit keanggotaan menjadi left (event change=left ke kanal room dan kanal user pemanggil),
  /// subscription socket room dicabut dan riwayat tidak lagi dapat dibaca (AC F11-4). Penghapusan akun memakai
  /// aturan pengalihan sistem, bukan endpoint ini (AC F14-5).
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [idempotencyKey]: UUID dari klien; disimpan lokal sampai hasil diketahui (PRD 4.3). Permintaan ulang dengan key dan payload
  /// sama mengembalikan hasil pertama; payload berbeda dengan key sama menghasilkan 409 IDEMPOTENCY_CONFLICT.
  /// Retensi 24 jam.
  ///
  /// `POST /chat/rooms/{roomId}/leave` (operationId `leaveChatRoom`).
  Future<void> leaveChatRoom(
    String roomId,
    ChatLeaveRequest body, {
    String? idempotencyKey,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'leaveChatRoom',
        method: 'POST',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/leave',
        authRequired: true,
        headers: <String, Object?>{
          'Idempotency-Key': ?idempotencyKey,
        },
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Bisukan atau aktifkan notifikasi push room untuk diri sendiri (F-11, F-12).
  ///
  /// Hanya anggota joined. Mute hanya menahan push kategori chat dari room ini; pesan, unread dan inbox tetap
  /// tersedia (notifikasi kotak masuk "Pesan baru" tetap ditulis, hanya push yang tidak dijadwalkan, AC F13-2).
  /// Idempoten. Perangkat lain milik pemanggil menerima `room.updated` (changes berisi muted).
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  ///
  /// `PUT /chat/rooms/{roomId}/mute` (operationId `setChatRoomMute`).
  Future<void> setChatRoomMute(
    String roomId,
    ChatMuteRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'setChatRoomMute',
        method: 'PUT',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/mute',
        authRequired: true,
        data: body.toJson(),
        decode: (_) {},
        cancelToken: cancelToken,
        options: options,
      );

  /// Riwayat pesan keyset (created_at, id); sinkronisasi setelah reconnect (AC F11-3, F11-4).
  ///
  /// Hanya anggota joined; hanya pesan dengan created_at >= history_visible_from milik pemanggil (anggota baru
  /// melihat pesan sejak bergabung). Item selalu urut naik (created_at, id).
  /// - Tanpa `before`/`after`: `limit` pesan terbaru; `next_cursor` = ID pesan tertua halaman ini bila masih ada
  ///   pesan lebih lama (lanjutkan dengan `before`).
  /// - `before=<message_id>`: pesan sebelum jangkar; `next_cursor` = ID pesan tertua bila masih ada yang lebih lama.
  /// - `after=<message_id>`: pesan sesudah jangkar untuk sinkron setelah reconnect (AC F11-3); `next_cursor` = ID
  ///   pesan terbaru halaman bila masih ada yang lebih baru (lanjutkan dengan `after`).
  /// `before` dan `after` tidak boleh bersamaan; jangkar wajib pesan di room ini yang terlihat bagi pemanggil
  /// (selain itu 400 VALIDATION_ERROR). Pesan terhapus tampil sebagai placeholder (deleted_at terisi, body/gambar
  /// null). URL gambar bertanda tangan maksimal 10 menit dan hanya diterbitkan untuk anggota yang berhak (PRD 5.4).
  ///
  /// Sinkron tanpa kehilangan pesan (AC F11-3, N-02):
  /// - Server menjamin urutan commit = urutan (created_at, id) per room (kunci baris room saat insert, lihat aturan
  ///   domain), sehingga pesan yang commit sesudah sebuah respons halaman selalu berada sesudah pesan terbaru
  ///   halaman itu.
  /// - Klien menyimpan "jangkar sinkron" = ID pesan terbaru yang diperoleh dari respons HTTP endpoint ini (halaman
  ///   HTTP selalu berurutan tanpa celah). Event `message.created` TIDAK memajukan jangkar karena event dari
  ///   transaksi berbeda dapat tiba tidak berurutan atau hilang saat koneksi putus. Setelah reconnect klien
  ///   memanggil `after=<jangkar>` sampai next_cursor null, menggabungkan hasil berdasarkan `id`, lalu memajukan
  ///   jangkar. Klien boleh memajukan jangkar lebih sering dengan sinkron `after` berkala.
  /// - Penghapusan dan reaksi pada pesan lama tidak membuat pesan baru, sehingga tidak ikut sinkron `after`.
  ///   Setelah reconnect, dan setiap kali room dibuka, klien memuat ulang jendela pesan yang ditampilkan (halaman
  ///   terbaru tanpa cursor; halaman lama lewat `before` saat digulir) dan MENGGANTI salinan lokal (body, image,
  ///   reactions, deleted_at). Salinan lokal hanya boleh tampil sementara sampai halaman HTTP tiba, sehingga pesan
  ///   yang dihapus pengirim, moderator, atau karena penghapusan akun (AC F14-3) tidak terus tampil.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [before]: ID pesan jangkar; ambil pesan yang lebih lama dari jangkar.
  /// [after]: ID pesan jangkar; ambil pesan yang lebih baru dari jangkar (sinkron, AC F11-3).
  /// [limit]: Jumlah item per halaman (bawaan 30, maksimum 100).
  ///
  /// `GET /chat/rooms/{roomId}/messages` (operationId `listChatMessages`).
  Future<ChatMessagePage> listChatMessages(
    String roomId, {
    String? before,
    String? after,
    int? limit,
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'listChatMessages',
        method: 'GET',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/messages',
        authRequired: true,
        queryParameters: <String, Object?>{
          'before': ?before,
          'after': ?after,
          'limit': ?limit,
        },
        decode: (Object? v0) => ChatMessagePage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Kirim pesan; ack sesudah commit, client_message_id mencegah duplikasi (AC F11-2, F12-1, F11-6).
  ///
  /// Hanya anggota joined pada room yang belum ditutup; status pengirim diperiksa ulang setiap request sehingga
  /// anggota yang menjadi expired/suspended saat tersambung ditolak (AC F11-6).
  /// - Teks: `body` 1..4000 karakter dan tidak hanya spasi (D5 v3.2). Gambar: `image_file_id` berkas purpose
  ///   chat_image milik pengirim yang siap (status ready) dan belum terpakai; `body` opsional sebagai keterangan.
  /// - `reply_to_id` wajib pesan di room yang sama dan terlihat bagi pengirim.
  /// - Room direct: blokir aktif dari salah satu pihak -> 403 FORBIDDEN walaupun room/socket sudah ada (AC F12-1);
  ///   lawan bicara tidak lagi aktif -> 403 FORBIDDEN. Blokir oleh lawan bicara dan lawan bicara tidak tersedia
  ///   memakai pesan galat yang sama sehingga pihak yang diblokir tidak mengetahuinya (N-09). Grup ditutup -> 403
  ///   FORBIDDEN.
  /// - Filter dasar konten berbahaya (PRD 3.12) dapat menolak isi dengan 400 VALIDATION_ERROR pada field body.
  /// Urutan: transaksi mengunci baris room lebih dulu (SELECT ... FOR UPDATE), memeriksa ulang keanggotaan, blokir
  /// dan status room di bawah kunci itu, mengisi created_at = greatest(clock_timestamp(), last_message_at + 1
  /// mikrodetik), menyisipkan pesan, memajukan read cursor pengirim dan memperbarui rooms.last_message_at dalam
  /// transaksi yang SAMA, sehingga urutan commit per room sama dengan urutan keyset (AC F11-3).
  /// Respons dikirim sesudah commit (201). Mengulang dengan client_message_id yang sama dari pengirim yang sama
  /// mengembalikan pesan yang sama (200) tanpa pesan baru (AC F11-2, unique messages_sender_id_client_message_id_key);
  /// client_message_id sama dengan room/isi berbeda -> 409 IDEMPOTENCY_CONFLICT. Sesudah commit server mengirim
  /// `message.created` ke kanal room (hanya socket anggota aktif yang masih berlangganan, lihat aturan domain
  /// langganan realtime; pesan yang memuat URL berkas privat dikirim per keluarga sesi penerima yang sama dengan
  /// URL terikat sesi itu) dan menjadwalkan push kategori chat (tanpa isi pesan) HANYA untuk anggota joined selain
  /// pengirim yang effective_status-nya verified/expiring dan tidak suspended saat penjadwalan, tidak mute room,
  /// dan preferensi push chat-nya aktif. Notifikasi kotak masuk (tanpa isi pesan, satu per episode belum dibaca)
  /// tetap ditulis untuk anggota aktif yang mute room atau mematikan push chat (riwayat resmi, AC F13-2). Teks
  /// notifikasi room direct tidak memuat nama pengirim ("Ada pesan baru di percakapan langsung."), karena kotak
  /// masuk penerima bertahan setelah akun pengirim dihapus (D2, AC F14-3); room grup memuat nama grup. Anggota
  /// expired/suspended tidak menerima notifikasi chat karena deep link `/chat/<roomId>` akan menjawab 403 dan
  /// mereka tidak dapat mute/keluar grup (PRD 2.2). Laju pengiriman dibatasi (429).
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  ///
  /// `POST /chat/rooms/{roomId}/messages` (operationId `sendChatMessage`).
  Future<ChatMessage> sendChatMessage(
    String roomId,
    ChatSendMessageRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'sendChatMessage',
        method: 'POST',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/messages',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => ChatMessage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus pesan sendiri menjadi placeholder (F-11, AC F14-3 pola placeholder).
  ///
  /// Hanya pengirim pesan (pesan orang lain atau pesan sistem -> 403 FORBIDDEN). Isi teks dan gambar dikosongkan,
  /// deleted_at diisi; pesan tetap ada sebagai placeholder agar urutan keyset stabil. Bukti laporan yang sudah
  /// tercatat tidak ikut terhapus (PRD 3.12). Idempoten: pesan yang sudah dihapus dikembalikan apa adanya.
  /// Anggota room menerima `message.deleted`.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  ///
  /// `DELETE /chat/rooms/{roomId}/messages/{messageId}` (operationId `deleteChatMessage`).
  Future<ChatMessage> deleteChatMessage(
    String roomId,
    String messageId, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'deleteChatMessage',
        method: 'DELETE',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/messages/${Uri.encodeComponent(messageId)}',
        authRequired: true,
        decode: (Object? v0) => ChatMessage.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Tambah reaksi emoji pada pesan; idempoten (F-11, PRD 6.4).
  ///
  /// Hanya anggota joined untuk pesan yang terlihat baginya; pesan terhapus atau pesan sistem -> 400
  /// VALIDATION_ERROR. Satu baris per (pesan, pengguna, emoji) sehingga pengulangan tidak menambah hitungan.
  /// Maksimal 10 emoji berbeda per pengguna per pesan. Di room direct, blokir aktif dari salah satu pihak atau
  /// lawan bicara tidak tersedia -> 403 FORBIDDEN dengan pesan galat yang sama (AC F12-1, N-09). Anggota room
  /// menerima `reaction.updated`.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [emoji]: Satu emoji (grapheme Unicode), dikodekan persen di URL; maksimal 16 karakter.
  ///
  /// `PUT /chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}` (operationId `addChatReaction`).
  Future<ChatMessageReactions> addChatReaction(
    String roomId,
    String messageId,
    String emoji, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'addChatReaction',
        method: 'PUT',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/messages/${Uri.encodeComponent(messageId)}/reactions/${Uri.encodeComponent(emoji)}',
        authRequired: true,
        decode: (Object? v0) => ChatMessageReactions.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Hapus reaksi emoji sendiri; idempoten (F-11).
  ///
  /// Hanya anggota joined untuk pesan yang terlihat baginya. Reaksi yang tidak ada tetap 200 dengan ringkasan
  /// terbaru. Anggota room menerima `reaction.updated` bila ada perubahan.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  /// [emoji]: Satu emoji (grapheme Unicode), dikodekan persen di URL; maksimal 16 karakter.
  ///
  /// `DELETE /chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}` (operationId `removeChatReaction`).
  Future<ChatMessageReactions> removeChatReaction(
    String roomId,
    String messageId,
    String emoji, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'removeChatReaction',
        method: 'DELETE',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/messages/${Uri.encodeComponent(messageId)}/reactions/${Uri.encodeComponent(emoji)}',
        authRequired: true,
        decode: (Object? v0) => ChatMessageReactions.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );

  /// Majukan read cursor secara monoton (F-11, PRD 3.11).
  ///
  /// Hanya anggota joined; `message_id` wajib pesan di room ini yang terlihat bagi pemanggil (selain itu 400).
  /// Pembaruan memakai syarat (created_at, id) jangkar > cursor saat ini sehingga paket terlambat tidak membuat
  /// cursor mundur; bila tidak maju, keadaan saat ini dikembalikan tanpa perubahan. Bila maju, anggota room dan
  /// perangkat lain pemanggil menerima `read.updated` (status "terbaca"). Presence/typing bukan bukti baca.
  ///
  /// [roomId]: ID room; bukan izin akses, keanggotaan selalu diperiksa (AC F11-4).
  ///
  /// `PUT /chat/rooms/{roomId}/read` (operationId `markChatRoomRead`).
  Future<ChatReadState> markChatRoomRead(
    String roomId,
    ChatReadRequest body, {
    CancelToken? cancelToken,
    Options? options,
  }) =>
      sendRequest(
        _dio,
        operationId: 'markChatRoomRead',
        method: 'PUT',
        path: '/chat/rooms/${Uri.encodeComponent(roomId)}/read',
        authRequired: true,
        data: body.toJson(),
        decode: (Object? v0) => ChatReadState.fromJson(decodeObject(v0)),
        cancelToken: cancelToken,
        options: options,
      );
}
