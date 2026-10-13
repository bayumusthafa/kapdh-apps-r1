import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/idempotency_store.dart';

/// Repositori portal status (PRD 2.2): banding dari portal pembatasan (kontrak C6 moderation, PRD 3.12) dan
/// pemeriksaan status penghapusan tanpa sesi lewat challenge email (kontrak C1 account, F-14).
class StatusRepository {
  StatusRepository(this._api, this._idempotency);

  final KapdhApi _api;
  final IdempotencyStore _idempotency;

  /// Banding terbaru milik sendiri (laporan berkategori `appeal`, terbaru lebih dulu); null bila belum pernah.
  /// Anggota suspended tidak dapat membuat laporan lain, sehingga banding selalu berada di halaman pertama.
  Future<ModerationReport?> latestAppeal() async {
    final page = await _api.moderation.listMyReports(limit: 30);
    for (final report in page.items) {
      if (report.category == ModerationReportCategory.appeal) return report;
    }
    return null;
  }

  /// POST /appeals; Idempotency-Key disimpan sampai hasil diketahui sehingga pengulangan tidak membuat banding ganda.
  Future<ModerationReport> createAppeal(String description) {
    final body = CreateAppealRequest(description: description);
    return _idempotency.run(
      'moderation.appeal',
      body.toJson(),
      (key) => _api.moderation.createAppeal(body, idempotencyKey: key),
    );
  }

  /// Challenge `deletion` ke email akun (non-enumerasi: respons sama untuk email apa pun, PRD 2.5).
  Future<OtpChallenge> startDeletionCheck(String email) =>
      _api.account.startWebDeletion(WebDeletionStartRequest(email: email.trim()));

  Future<OtpChallenge> resendCode(String challengeId) =>
      _api.auth.resendOtp(OtpResendRequest(challengeId: challengeId));

  /// Verifikasi kode; hasilnya status permintaan terbuka tanpa sesi (challenge terbatas, PRD 2.2). Token
  /// penghapusan web yang mungkin ikut terbit tidak dipakai aplikasi dan tidak disimpan.
  Future<WebDeletionVerification> verifyDeletionCheck({required String challengeId, required String code}) =>
      _api.account.verifyWebDeletion(WebDeletionVerifyRequest(challengeId: challengeId, code: code));
}

final statusRepositoryProvider = Provider<StatusRepository>(
  (ref) => StatusRepository(ref.watch(kapdhApiProvider), ref.watch(idempotencyStoreProvider)),
);
