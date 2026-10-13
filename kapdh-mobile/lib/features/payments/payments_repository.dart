import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/idempotency_store.dart';
import 'proof_file.dart';

/// Repositori pembayaran anggota di atas SDK terbangkit (kontrak C3 `payments.yaml`, `files.yaml`; F-03, F-07).
///
/// Klien tidak pernah menghitung nominal (PRD 3.3): semua nilai uang berasal dari server. Mutasi yang dapat diulang
/// setelah jaringan putus (buat instruksi, kirim bukti, batal) memakai Idempotency-Key yang disimpan lokal sampai
/// hasilnya diketahui (PRD 4.3, AC F03-4) lewat [IdempotencyStore]. Header `X-App-Platform` (rencana cadangan D13)
/// dan `X-App-Version` dipasang interceptor aplikasi pada setiap request.
class PaymentsRepository {
  PaymentsRepository({
    required PaymentsApi payments,
    required FilesApi files,
    required MeApi me,
    required IdempotencyStore idempotency,
  }) : _payments = payments,
       _files = files,
       _me = me,
       _idempotency = idempotency;

  final PaymentsApi _payments;
  final FilesApi _files;
  final MeApi _me;
  final IdempotencyStore _idempotency;

  /// Niat idempotensi pembuatan instruksi iuran per jenis (satu payment nonterminal per jenis, PRD 3.3).
  static String createIntent(MembershipPaymentType type) => 'payment.create.${type.value}';

  /// Niat idempotensi kirim/ganti bukti per payment (AC F03-2, F03-4).
  static String proofIntent(String paymentId) => 'payment.proof.$paymentId';

  /// Niat idempotensi pembatalan instruksi per payment (PRD 4.3).
  static String cancelIntent(String paymentId) => 'payment.cancel.$paymentId';

  /// Kutipan iuran pendaftaran/perpanjangan beserta kelayakan dan `instructions_hidden` (AC F03-1, F07-5, D13).
  Future<MyFeeQuotes> getFees() => _payments.getMyFees();

  /// Rekening tujuan aktif (urut server).
  Future<List<PaymentMethod>> listMethods() async => (await _payments.listPaymentMethods()).items;

  Future<PaymentDetail> getPayment(String paymentId) => _payments.getMyPayment(paymentId);

  /// Riwayat pembayaran sendiri (keyset, terbaru dahulu).
  Future<PaymentPage> listPayments({String? cursor, int limit = 30}) =>
      _payments.listMyPayments(cursor: cursor, limit: limit);

  /// Periode keanggotaan dan kelayakan perpanjangan (F-07).
  Future<Membership> getMembership() => _me.getMyMembership();

  /// Membuat instruksi iuran; nominal dihitung server (AC F03-1). Payment nonterminal yang sudah ada dikembalikan
  /// server apa adanya (200), sehingga pengulangan tidak pernah membuat payment kedua.
  ///
  /// Server menyimpan respons per Idempotency-Key selama 24 jam. Bila respons yang kembali adalah instruksi yang
  /// sudah dibatalkan (key lama yang tertinggal, mis. dari permintaan yang terputus lalu dibatalkan), key itu sudah
  /// dilepas oleh [IdempotencyStore.run] dan permintaan diulang SEKALI dengan key baru agar anggota mendapat
  /// instruksi yang berlaku, bukan instruksi batal yang sama berulang-ulang (PRD 4.3, 4.5; AC F03-1, F03-4).
  Future<PaymentDetail> createInstruction(MembershipPaymentType type, String paymentMethodId) async {
    final body = CreatePaymentRequest(type: type, paymentMethodId: paymentMethodId);
    Future<PaymentDetail> attempt() => _idempotency.run(
      createIntent(type),
      body.toJson(),
      (key) => _payments.createPaymentInstruction(body, idempotencyKey: key),
    );
    final payment = await attempt();
    if (!_isClosedInstruction(payment)) return payment;
    return attempt();
  }

  /// Hasil pembuatan instruksi [type] sudah diketahui tanpa respons POST (Memeriksa status menemukan payment
  /// terbuka): key yang tersimpan dilepas agar instruksi berikutnya memakai key baru (PRD 4.3 "disimpan sampai
  /// hasilnya diketahui").
  Future<void> resolveCreate(MembershipPaymentType type) => _idempotency.complete(createIntent(type));

  /// Instruksi yang tidak dapat dibayar lagi (dibatalkan atau ditolak final): tidak pernah dikembalikan server untuk
  /// permintaan baru, hanya untuk replay key lama.
  static bool _isClosedInstruction(PaymentDetail payment) =>
      payment.stage == PaymentStage.cancelled || payment.stage == PaymentStage.rejectedFinal;

  /// Mengganti rekening tujuan sebelum bukti pertama (If-Match `version`, PRD 4.3).
  Future<PaymentDetail> changeMethod(PaymentDetail payment, String paymentMethodId) => _payments.changeMyPaymentMethod(
    payment.id,
    ChangePaymentMethodRequest(paymentMethodId: paymentMethodId),
    ifMatch: payment.version,
  );

  /// Mengunggah berkas bukti (purpose `payment_proof`, N-10). Server menentukan tipe dari magic bytes, membuang EXIF
  /// dan menolak berkas tidak sah dengan FILE_INVALID.
  Future<FileRef> uploadProof(PickedProof proof, {ProgressCallback? onProgress, CancelToken? cancelToken}) async {
    final file = await proof.toMultipartFile();
    return _files.uploadFile(
      FileUploadRequest(purpose: FileUploadPurpose.paymentProof, file: file),
      onSendProgress: onProgress,
      cancelToken: cancelToken,
    );
  }

  /// Kirim/ganti bukti dengan `expected_proof_version` (AC F03-2, F03-3, F04-4). Key yang sama dipakai ulang selama
  /// payload sama dan hasil belum diketahui (AC F03-4).
  Future<PaymentDetail> submitProof(String paymentId, SubmitPaymentProofRequest body) => _idempotency.run(
    proofIntent(paymentId),
    body.toJson(),
    (key) => _payments.submitPaymentProof(paymentId, body, idempotencyKey: key),
  );

  /// Membatalkan instruksi iuran yang belum berbukti (`actions.can_cancel`). Setelah batal, key pembuatan instruksi
  /// jenis yang sama yang mungkin masih tersimpan dilepas: instruksi baru harus memakai key baru, bukan me-replay
  /// respons instruksi yang baru dibatalkan (PRD 4.3).
  Future<PaymentDetail> cancel(PaymentDetail payment, {String? reason}) async {
    final trimmed = reason?.trim();
    final body = CancelPaymentRequest(reason: trimmed == null || trimmed.isEmpty ? null : trimmed);
    final result = await _idempotency.run(cancelIntent(payment.id), {
      ...body.toJson(),
      'version': payment.version,
    }, (key) => _payments.cancelMyPayment(payment.id, body, ifMatch: payment.version, idempotencyKey: key));
    final type = switch (payment.type) {
      PaymentType.registration => MembershipPaymentType.registration,
      PaymentType.renewal => MembershipPaymentType.renewal,
      _ => null,
    };
    if (type != null) {
      try {
        await resolveCreate(type);
      } on Object catch (error) {
        // Pembatalan sudah tercatat server; replay instruksi batal tetap ditangani [createInstruction].
        debugPrint('pembayaran: key pembuatan instruksi gagal dilepas (${error.runtimeType})');
      }
    }
    return result;
  }

  /// Rekening tujuan refund (D6). Nilai rekening tidak pernah dicatat atau disimpan klien (ARCHITECTURE §2 butir 3).
  Future<PaymentDetail> setRefundDestination(
    String paymentId,
    PaymentAdjustmentSummary adjustment,
    RefundDestinationInput input,
  ) => _payments.setMyRefundDestination(paymentId, adjustment.id, input, ifMatch: adjustment.version);
}

final paymentsRepositoryProvider = Provider<PaymentsRepository>((ref) {
  final api = ref.watch(kapdhApiProvider);
  return PaymentsRepository(
    payments: api.payments,
    files: api.files,
    me: api.me,
    idempotency: ref.watch(idempotencyStoreProvider),
  );
});
