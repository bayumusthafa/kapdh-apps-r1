import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/idempotency_store.dart';

/// Repositori fitur Akun di atas SDK terbangkit (kontrak C1 auth/account, C2 me, C3 files; PRD 5.2). Klien tidak
/// menghitung status atau aturan bisnis; semua keputusan dari server (PRD 2.1).
class AccountRepository {
  AccountRepository(this._api, this._idempotency);

  final KapdhApi _api;
  final IdempotencyStore _idempotency;

  // Profil (F-10, PRD 4.6).

  /// GET /me terbaru; `version` dipakai sebagai If-Match (AC F15-4).
  Future<Me> getMe() => _api.me.getMe();

  /// PATCH /me/profile dengan If-Match; hanya field yang berubah dikirim (AC F10-5: hanya profil sendiri).
  Future<Me> updateProfile(ProfileUpdate update, {required String version}) =>
      _api.me.updateMyProfile(update, ifMatch: version);

  /// Master AKTIF untuk pemilihan baru (AC F10-4).
  Future<List<MasterItem>> listMasters(MasterKind kind) async => (await _api.me.listMasters(kind)).items;

  /// Unggah foto profil (purpose `avatar`, JPG/PNG/WebP <= 5 MB; N-10). Berkas baru dilampirkan lewat
  /// `avatar_file_id` pada PATCH /me/profile.
  Future<FileRef> uploadAvatar(MultipartFile file, {ProgressCallback? onProgress}) => _api.files.uploadFile(
    FileUploadRequest(purpose: FileUploadPurpose.avatar, file: file),
    onSendProgress: onProgress,
  );

  // Sesi perangkat dan sandi (F-02).

  Future<SessionPage> listSessions({String? cursor}) => _api.auth.listSessions(cursor: cursor, limit: 50);

  /// Mencabut satu keluarga sesi milik sendiri (404 bila sudah dicabut atau bukan milik sendiri).
  Future<void> revokeSession(String sessionId) => _api.auth.revokeSession(sessionId);

  /// Ganti sandi dengan sandi lama (AC F02-4); sesi perangkat lain dicabut server.
  Future<void> changePassword({required String currentPassword, required String newPassword}) =>
      _api.auth.changePassword(ChangePasswordRequest(currentPassword: currentPassword, newPassword: newPassword));

  // Penghapusan akun (F-14).

  /// Pengungkapan retensi D2 dan peringatan pribadi sebelum konfirmasi (N-15).
  Future<AccountDeletionDisclosure> getDeletionDisclosure() => _api.account.getAccountDeletionDisclosure();

  /// POST /me/deletion dengan X-Reauth-Token (<= 10 menit) dan Idempotency-Key yang disimpan sampai hasil diketahui
  /// (PRD 4.3): pengulangan setelah jaringan putus tidak membuat permintaan kedua.
  Future<AccountDeletion> requestDeletion({required String disclosureVersion, required String reauthToken}) {
    final body = AccountDeletionRequest(confirm: true, acknowledgedDisclosureVersion: disclosureVersion);
    return _idempotency.run(
      'account.deletion',
      body.toJson(),
      (key) => _api.account.requestAccountDeletion(body, reauthToken: reauthToken, idempotencyKey: key),
    );
  }
}

final accountRepositoryProvider = Provider<AccountRepository>(
  (ref) => AccountRepository(ref.watch(kapdhApiProvider), ref.watch(idempotencyStoreProvider)),
);
