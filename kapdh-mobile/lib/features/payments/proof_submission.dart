import 'package:flutter/foundation.dart';
import 'package:kapdh_api/kapdh_api.dart';

import 'payments_repository.dart';
import 'proof_file.dart';

/// Tahap pengiriman bukti yang ditampilkan tombol dan tile unggah.
enum ProofSubmitPhase {
  idle,

  /// POST /files sedang berjalan (dengan persentase).
  uploading,

  /// PUT /me/payments/{id}/proof sedang berjalan.
  submitting,

  /// Hasil belum diketahui karena jaringan putus: status payment dibaca ulang sebelum mutasi diulang (PRD 4.5
  /// "Memeriksa status").
  checking,
}

/// Hasil pengiriman bukti.
@immutable
sealed class ProofSubmitOutcome {
  const ProofSubmitOutcome();
}

/// Bukti diterima server (langsung, lewat pengulangan dengan key yang sama, atau dipastikan saat memeriksa status).
final class ProofSubmitted extends ProofSubmitOutcome {
  const ProofSubmitted(this.payment);

  final PaymentDetail payment;
}

/// Unggahan berkas gagal; payment tidak berubah. [error] FILE_INVALID, RATE_LIMITED, jaringan, dsb.
final class ProofUploadFailed extends ProofSubmitOutcome {
  const ProofUploadFailed(this.error);

  final ApiException error;
}

/// Server menolak bukti dengan pasti (FILE_INVALID, PROOF_VERSION_CONFLICT, PAYMENT_STATE_CONFLICT,
/// RESERVATION_EXPIRED, FORBIDDEN, ...). [current] = PaymentDetail terbaru dari `current` galat 409 atau dari
/// pemeriksaan status.
final class ProofSubmitRejected extends ProofSubmitOutcome {
  const ProofSubmitRejected(this.error, {this.current});

  final ApiException error;
  final PaymentDetail? current;
}

/// Hasil belum diketahui (jaringan masih putus). Key idempotensi dan berkas yang sudah terunggah dipertahankan;
/// pengguna tidak diminta transfer ulang dan dapat memeriksa status lagi (PRD 4.3, 4.5).
final class ProofSubmitUnknown extends ProofSubmitOutcome {
  const ProofSubmitUnknown(this.error);

  final ApiException error;
}

/// Hasil mutasi tidak diketahui: tidak ada respons (jaringan, respons rusak), 5xx selain MAINTENANCE, 408, atau
/// IDEMPOTENCY_CONFLICT dengan payload sama (permintaan pertama masih diproses server).
bool isOutcomeUnknown(ApiException error) {
  switch (error.kind) {
    case ApiFailureKind.network:
    case ApiFailureKind.invalidResponse:
    case ApiFailureKind.unexpected:
    case ApiFailureKind.cancelled:
      return true;
    case ApiFailureKind.api:
      if (error.code == ErrorCode.idempotencyConflict) return true;
      if (error.code == ErrorCode.maintenance) return false;
      final status = error.statusCode ?? 0;
      return status == 408 || status >= 500;
  }
}

/// PaymentDetail dari `current` galat 409 (kontrak C3: setiap 409 selain IDEMPOTENCY_CONFLICT membawa
/// PaymentDetail terbaru); null bila tidak ada atau bentuknya tidak sesuai.
PaymentDetail? currentPaymentOf(ApiException error) {
  final current = error.current;
  if (current is! Map<String, Object?>) return null;
  try {
    return PaymentDetail.fromJson(current);
  } on Object {
    return null;
  }
}

/// Alur unggah lalu kirim bukti untuk satu payment (AC F03-2, F03-3, F03-4; PRD 4.3, 4.5).
///
/// 1. Berkas diunggah sekali (POST /files). Berkas yang sudah terunggah dipakai ulang untuk pengulangan pilihan
///    yang sama, sehingga kuota unggah (N-10) tidak terbuang.
/// 2. PUT bukti dengan `expected_proof_version` dan Idempotency-Key tersimpan.
/// 3. Bila hasilnya tidak diketahui: baca ulang payment (Memeriksa status). Versi bukti sudah naik dengan berkas ini
///    → berhasil; belum naik → PUT diulang dengan key yang SAMA (server mengembalikan hasil pertama bila ternyata
///    sudah diproses); versi naik dengan berkas lain → bukti sudah diganti dari perangkat lain (konflik).
class ProofSubmitter {
  ProofSubmitter(this._repository);

  final PaymentsRepository _repository;

  PickedProof? _uploadedFor;
  FileRef? _uploaded;
  _PendingSubmission? _pending;

  /// Ada pengiriman yang hasilnya belum diketahui (tampilkan "Memeriksa status").
  bool get hasUnknownOutcome => _pending != null;

  /// Mengirim [proof] untuk payment [paymentId] yang dilihat pengguna pada versi bukti [expectedProofVersion].
  Future<ProofSubmitOutcome> submit({
    required String paymentId,
    required int expectedProofVersion,
    required PickedProof proof,
    String? transferNote,
    required void Function(ProofSubmitPhase phase, double? progress) onPhase,
  }) async {
    FileRef file;
    if (_uploaded != null && identical(_uploadedFor, proof)) {
      file = _uploaded!;
    } else {
      onPhase(ProofSubmitPhase.uploading, 0);
      try {
        file = await _repository.uploadProof(
          proof,
          onProgress: (sent, total) => onPhase(ProofSubmitPhase.uploading, total > 0 ? sent / total : null),
        );
      } on ApiException catch (error) {
        onPhase(ProofSubmitPhase.idle, null);
        return ProofUploadFailed(error);
      }
      _uploaded = file;
      _uploadedFor = proof;
    }

    final note = transferNote?.trim();
    final request = SubmitPaymentProofRequest(
      fileId: file.id,
      transferNote: note == null || note.isEmpty ? null : note,
      expectedProofVersion: expectedProofVersion,
    );
    _pending = _PendingSubmission(paymentId: paymentId, request: request);
    return _put(onPhase);
  }

  /// Memeriksa status payment sebelum mengulang PUT yang hasilnya belum diketahui (PRD 4.5).
  Future<ProofSubmitOutcome> checkStatus({
    required void Function(ProofSubmitPhase phase, double? progress) onPhase,
  }) async {
    final pending = _pending;
    if (pending == null) {
      throw StateError('Tidak ada pengiriman bukti yang menunggu pemeriksaan status.');
    }
    onPhase(ProofSubmitPhase.checking, null);
    final PaymentDetail latest;
    try {
      latest = await _repository.getPayment(pending.paymentId);
    } on ApiException catch (error) {
      onPhase(ProofSubmitPhase.idle, null);
      if (isOutcomeUnknown(error)) return ProofSubmitUnknown(error);
      _pending = null;
      return ProofSubmitRejected(error);
    }
    final expected = pending.request.expectedProofVersion;
    if (latest.proofVersion > expected) {
      _pending = null;
      onPhase(ProofSubmitPhase.idle, null);
      if (latest.proofFileId == null || latest.proofFileId == pending.request.fileId) {
        _reset();
        return ProofSubmitted(latest);
      }
      // Bukti sudah diganti dari perangkat lain: tampilkan versi terbaru, bukan menimpanya (AC F04-4).
      return ProofSubmitRejected(
        const ApiException(
          kind: ApiFailureKind.api,
          statusCode: 409,
          operationId: 'submitPaymentProof',
          error: ApiError(
            code: ErrorCode.proofVersionConflict,
            message: 'Bukti pembayaran sudah diganti dari perangkat lain. Periksa bukti terbaru.',
            requestId: '',
          ),
        ),
        current: latest,
      );
    }
    // Belum diproses: ulangi dengan key yang sama.
    return _put(onPhase);
  }

  Future<ProofSubmitOutcome> _put(void Function(ProofSubmitPhase phase, double? progress) onPhase) async {
    final pending = _pending!;
    onPhase(ProofSubmitPhase.submitting, null);
    try {
      final result = await _repository.submitProof(pending.paymentId, pending.request);
      _pending = null;
      _reset();
      onPhase(ProofSubmitPhase.idle, null);
      return ProofSubmitted(result);
    } on ApiException catch (error) {
      if (isOutcomeUnknown(error)) {
        if (!pending.checked) {
          pending.checked = true;
          return checkStatus(onPhase: onPhase);
        }
        onPhase(ProofSubmitPhase.idle, null);
        return ProofSubmitUnknown(error);
      }
      _pending = null;
      onPhase(ProofSubmitPhase.idle, null);
      if (error.code == ErrorCode.fileInvalid) {
        // Berkas tidak dapat dipakai lagi (tidak sah atau sudah terpakai): pilih berkas baru.
        _reset();
      }
      return ProofSubmitRejected(error, current: currentPaymentOf(error));
    }
  }

  /// Pengguna memilih berkas lain atau hasil sudah pasti.
  void _reset() {
    _uploaded = null;
    _uploadedFor = null;
  }

  /// Melupakan pengiriman yang belum pasti (mis. pengguna memilih berkas baru setelah status dipastikan belum
  /// berubah). Key idempotensi tetap dikelola IdempotencyStore: payload baru memakai key baru.
  void forgetPending() {
    _pending = null;
  }
}

class _PendingSubmission {
  _PendingSubmission({required this.paymentId, required this.request});

  final String paymentId;
  final SubmitPaymentProofRequest request;

  /// Status sudah diperiksa sekali secara otomatis untuk percobaan ini.
  bool checked = false;
}
