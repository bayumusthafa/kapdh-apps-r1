import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/core/api/api_providers.dart';
import 'package:kapdh_mobile/features/payments/payments_repository.dart';
import 'package:kapdh_mobile/features/payments/proof_submission.dart';

import '../../support/fakes.dart';
import 'payments_fixtures.dart';

void main() {
  late FakeHttpAdapter adapter;
  late ProviderContainer container;
  late ProofSubmitter submitter;
  final phases = <ProofSubmitPhase>[];

  void onPhase(ProofSubmitPhase phase, double? _) => phases.add(phase);

  void setUpWith(FakeHandler handler) {
    adapter = FakeHttpAdapter(handler);
    container = makeContainer(adapter: adapter);
    addTearDown(container.dispose);
    submitter = ProofSubmitter(container.read(paymentsRepositoryProvider));
    phases.clear();
  }

  Future<ProofSubmitOutcome> submitJpeg({int expected = 0}) =>
      submitter.submit(paymentId: 'pay-1', expectedProofVersion: expected, proof: jpegProof(), onPhase: onPhase);

  List<RequestOptions> puts() => adapter.requestsTo('/me/payments/pay-1/proof');

  test('AC F03-2: berkas diunggah sebagai payment_proof lalu bukti dikirim dengan expected_proof_version dan '
      'Idempotency-Key', () async {
    setUpWith((options) {
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (options.path == '/me/payments/pay-1/proof') return FakeResponse.json(200, awaitingReviewJson());
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final outcome = await submitter.submit(
      paymentId: 'pay-1',
      expectedProofVersion: 0,
      proof: jpegProof(),
      transferNote: '  dari BSI a.n. Ahmad  ',
      onPhase: onPhase,
    );

    expect(outcome, isA<ProofSubmitted>());
    expect((outcome as ProofSubmitted).payment.stage, PaymentStage.awaitingReview);
    final upload = adapter.requestsTo('/files').single;
    final form = upload.data as FormData;
    expect([for (final f in form.fields) '${f.key}=${f.value}'], ['purpose=payment_proof']);
    expect(form.files.single.value.filename, 'bukti-transfer.jpg');
    expect(form.files.single.value.contentType.toString(), 'image/jpeg');
    final put = puts().single;
    expect(put.method, 'PUT');
    expect(bodyOf(put), {'file_id': 'file-2', 'transfer_note': 'dari BSI a.n. Ahmad', 'expected_proof_version': 0});
    expect(idempotencyKeyOf(put), isNotEmpty);
    expect(phases, containsAllInOrder([ProofSubmitPhase.uploading, ProofSubmitPhase.submitting, ProofSubmitPhase.idle]));
    expect(submitter.hasUnknownOutcome, isFalse);
    // Hasil pasti: niat berikutnya memakai key baru.
    final next = await container
        .read(idempotencyStoreProvider)
        .keyFor(PaymentsRepository.proofIntent('pay-1'), bodyOf(put));
    expect(next, isNot(idempotencyKeyOf(put)));
  });

  test('AC F03-4, PRD 4.5: jaringan putus saat kirim bukti: status diperiksa dahulu, lalu PUT diulang dengan '
      'Idempotency-Key yang sama tanpa unggah ulang', () async {
    var putCount = 0;
    final order = <String>[];
    setUpWith((options) {
      order.add('${options.method} ${options.path}');
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (options.path == '/me/payments/pay-1/proof') {
        putCount++;
        return putCount == 1 ? FakeResponse.network() : FakeResponse.json(200, awaitingReviewJson(proofFileId: 'file-2'));
      }
      if (options.path == '/me/payments/pay-1') return FakeResponse.json(200, awaitingTransferJson());
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final outcome = await submitJpeg();

    expect(outcome, isA<ProofSubmitted>());
    expect(order, [
      'POST /files',
      'PUT /me/payments/pay-1/proof',
      'GET /me/payments/pay-1',
      'PUT /me/payments/pay-1/proof',
    ]);
    expect(idempotencyKeyOf(puts()[0]), idempotencyKeyOf(puts()[1]));
    expect(bodyOf(puts()[0]), bodyOf(puts()[1]));
    expect(phases, contains(ProofSubmitPhase.checking));
  });

  test('PRD 4.5: pengiriman yang terputus ternyata sudah diterima server: tidak ada PUT kedua', () async {
    setUpWith((options) {
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (options.path == '/me/payments/pay-1/proof') return FakeResponse.network();
      if (options.path == '/me/payments/pay-1') return FakeResponse.json(200, awaitingReviewJson(proofFileId: 'file-2'));
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final outcome = await submitJpeg();

    expect(outcome, isA<ProofSubmitted>());
    expect((outcome as ProofSubmitted).payment.proofVersion, 1);
    expect(puts(), hasLength(1));
  });

  test('AC F03-4: masih offline saat memeriksa: hasil belum diketahui dan key dipertahankan; pemeriksaan berikutnya '
      'mengulang dengan key yang sama', () async {
    var online = false;
    setUpWith((options) {
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (!online) return FakeResponse.network();
      if (options.path == '/me/payments/pay-1') return FakeResponse.json(200, awaitingTransferJson());
      if (options.path == '/me/payments/pay-1/proof') return FakeResponse.json(200, awaitingReviewJson());
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final first = await submitJpeg();
    expect(first, isA<ProofSubmitUnknown>());
    expect(submitter.hasUnknownOutcome, isTrue);
    expect(puts(), hasLength(1));

    online = true;
    final second = await submitter.checkStatus(onPhase: onPhase);
    expect(second, isA<ProofSubmitted>());
    expect(puts(), hasLength(2));
    expect(idempotencyKeyOf(puts()[1]), idempotencyKeyOf(puts()[0]));
    expect(adapter.requestsTo('/files'), hasLength(1));
    expect(submitter.hasUnknownOutcome, isFalse);
  });

  test('AC F04-4: saat memeriksa ternyata bukti sudah diganti dari perangkat lain: konflik dengan versi terbaru, '
      'tidak ditimpa', () async {
    setUpWith((options) {
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (options.path == '/me/payments/pay-1/proof') return FakeResponse.network();
      if (options.path == '/me/payments/pay-1') {
        return FakeResponse.json(200, awaitingReviewJson(proofFileId: 'file-perangkat-lain'));
      }
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final outcome = await submitJpeg();

    expect(outcome, isA<ProofSubmitRejected>());
    final rejected = outcome as ProofSubmitRejected;
    expect(rejected.error.code, ErrorCode.proofVersionConflict);
    expect(rejected.current?.proofFileId, 'file-perangkat-lain');
    expect(puts(), hasLength(1));
  });

  test('AC F04-4: PROOF_VERSION_CONFLICT dari server: payment terbaru dari `current`, key dilepas', () async {
    setUpWith((options) {
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (options.path == '/me/payments/pay-1/proof') {
        return FakeResponse.json(
          409,
          errorJson('PROOF_VERSION_CONFLICT', 'Bukti sudah diganti.', current: awaitingReviewJson(proofVersion: 2)),
        );
      }
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final outcome = await submitJpeg(expected: 1);

    final rejected = outcome as ProofSubmitRejected;
    expect(rejected.error.code, ErrorCode.proofVersionConflict);
    expect(rejected.current?.proofVersion, 2);
    expect(submitter.hasUnknownOutcome, isFalse);
  });

  test('AC F03-4: payment sudah paid: PAYMENT_STATE_CONFLICT ditolak tanpa pengulangan', () async {
    setUpWith((options) {
      if (options.path == '/files') return FakeResponse.json(201, fileRefJson());
      if (options.path == '/me/payments/pay-1/proof') {
        return FakeResponse.json(
          409,
          errorJson(
            'PAYMENT_STATE_CONFLICT',
            'Pembayaran sudah diputus.',
            current: paymentJson(status: 'paid', stage: 'paid', proofVersion: 1, canSubmitProof: false),
          ),
        );
      }
      return FakeResponse.json(404, errorJson('NOT_FOUND', 'x'));
    });

    final outcome = await submitJpeg();

    final rejected = outcome as ProofSubmitRejected;
    expect(rejected.error.code, ErrorCode.paymentStateConflict);
    expect(rejected.current?.stage, PaymentStage.paid);
    expect(puts(), hasLength(1));
  });

  test('N-10: FILE_INVALID dari unggahan: payment tidak disentuh', () async {
    setUpWith((options) {
      if (options.path == '/files') {
        return FakeResponse.json(422, errorJson('FILE_INVALID', 'Berkas rusak atau tidak dapat dibaca.'));
      }
      return FakeResponse.json(500, errorJson('INTERNAL_ERROR', 'x'));
    });

    final outcome = await submitJpeg();

    expect((outcome as ProofUploadFailed).error.code, ErrorCode.fileInvalid);
    expect(puts(), isEmpty);
  });

  test('PRD 4.3: klasifikasi hasil mutasi yang belum diketahui', () {
    expect(isOutcomeUnknown(networkError()), isTrue);
    expect(isOutcomeUnknown(apiError(502, 'INTERNAL_ERROR', 'x')), isTrue);
    expect(isOutcomeUnknown(apiError(409, 'IDEMPOTENCY_CONFLICT', 'x')), isTrue);
    expect(isOutcomeUnknown(apiError(503, 'MAINTENANCE', 'x')), isFalse);
    expect(isOutcomeUnknown(apiError(409, 'PROOF_VERSION_CONFLICT', 'x')), isFalse);
    expect(isOutcomeUnknown(apiError(429, 'RATE_LIMITED', 'x')), isFalse);
    expect(isOutcomeUnknown(apiError(422, 'FILE_INVALID', 'x')), isFalse);
  });
}
