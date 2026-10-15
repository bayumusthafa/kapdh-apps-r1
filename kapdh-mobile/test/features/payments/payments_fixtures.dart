import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/payments/proof_file.dart';

import '../../support/fakes.dart';

/// Data uji kontrak C3 (`payments.yaml`, `files.yaml`) dan C2 (`me.yaml`) dengan SEMUA field wajib; field nullable
/// dikirim null bila tidak berlaku. Bentuknya mengikuti skema final agar uji tidak lolos karena data longgar.

String iso(DateTime value) => value.toUtc().toIso8601String();

const methodBsi = <String, Object?>{
  'id': 'method-1',
  'kind': 'bank',
  'provider': 'BSI',
  'account_number': '7123456789',
  'account_holder': 'KAPDH Pusat',
  'instructions': null,
};

const methodDana = <String, Object?>{
  'id': 'method-2',
  'kind': 'ewallet',
  'provider': 'DANA',
  'account_number': '081234567890',
  'account_holder': 'KAPDH Pusat',
  'instructions': null,
};

/// URL publik tetap gambar QRIS (`GET /files/public/{fileId}`, berkas purpose `payment_qr`).
const qrisImageUrl = 'https://api.kapdh.or.id/api/v1/files/public/file-qr-1';

/// QRIS statis organisasi (ADR-026): `provider` nama metode, `account_number` NMID, `account_holder` merchant.
const methodQris = <String, Object?>{
  'id': 'method-3',
  'kind': 'qris',
  'provider': 'QRIS',
  'account_number': 'ID1020200012345',
  'account_holder': 'KAPDH Pusat',
  'instructions': null,
  'qr_image_url': qrisImageUrl,
};

List<Map<String, Object?>> linesFor(String type) => switch (type) {
  'registration' => [
    {'code': 'registration_fee', 'label': 'Register alumni baru', 'amount': '50000.00'},
    {'code': 'card_fee', 'label': 'Pembuatan KTA', 'amount': '10000.00'},
  ],
  'renewal' => [
    {'code': 'renewal_fee', 'label': 'Perpanjangan KTA', 'amount': '10000.00'},
  ],
  _ => [
    {'code': 'ticket', 'label': 'Tiket Silaturahmi Akbar', 'amount': '75000.00'},
  ],
};

String amountFor(String type) => switch (type) {
  'registration' => '60000.00',
  'renewal' => '10000.00',
  _ => '75000.00',
};

/// `PaymentEvent`.
Map<String, Object?> paymentEventJson(
  String kind, {
  required DateTime at,
  String actor = 'member',
  int? proofVersion,
  String? reason,
}) => {'at': iso(at), 'kind': kind, 'actor': actor, 'proof_version': proofVersion, 'reason': reason};

/// `PaymentDetail` (Payment + events, adjustments, method_active, instructions_hidden).
Map<String, Object?> paymentJson({
  String id = 'pay-1',
  String type = 'registration',
  String status = 'pending',
  String stage = 'awaiting_transfer',
  int proofVersion = 0,
  String? proofFileId,
  String? transferNote,
  DateTime? submittedAt,
  DateTime? decidedAt,
  String? rejectionReason,
  DateTime? cancelledAt,
  String? cancelReason,
  Map<String, Object?>? ticket,
  Map<String, Object?>? period,
  String version = '1',
  bool canSubmitProof = true,
  bool canChangeMethod = true,
  bool canCancel = true,
  List<Map<String, Object?>>? events,
  List<Map<String, Object?>> adjustments = const [],
  Map<String, Object?> method = methodBsi,
  bool methodActive = true,
  bool instructionsHidden = false,
}) => {
  'id': id,
  'type': type,
  'status': status,
  'stage': stage,
  'amount': amountFor(type),
  'lines': linesFor(type),
  'method': method,
  'proof_version': proofVersion,
  'proof_file_id': proofFileId,
  'transfer_note': transferNote,
  'submitted_at': submittedAt == null ? null : iso(submittedAt),
  'decided_at': decidedAt == null ? null : iso(decidedAt),
  'rejection_reason': rejectionReason,
  'cancelled_at': cancelledAt == null ? null : iso(cancelledAt),
  'cancel_reason': cancelReason,
  'ticket': ticket,
  'period': period,
  'created_at': iso(testNow.subtract(const Duration(minutes: 30))),
  'version': version,
  'actions': {'can_submit_proof': canSubmitProof, 'can_change_method': canChangeMethod, 'can_cancel': canCancel},
  'events': events ?? [paymentEventJson('created', at: testNow.subtract(const Duration(minutes: 30)))],
  'adjustments': adjustments,
  'method_active': methodActive,
  'instructions_hidden': instructionsHidden,
};

/// Payment menunggu bukti pertama (prototipe layar 3).
Map<String, Object?> awaitingTransferJson({String type = 'registration', String version = '1'}) =>
    paymentJson(type: type, version: version);

/// Payment dengan bukti menunggu verifikasi (prototipe layar 4).
Map<String, Object?> awaitingReviewJson({
  String type = 'registration',
  int proofVersion = 1,
  String proofFileId = 'file-1',
  String version = '2',
  bool canSubmitProof = true,
}) => paymentJson(
  type: type,
  stage: 'awaiting_review',
  proofVersion: proofVersion,
  proofFileId: proofFileId,
  submittedAt: testNow,
  version: version,
  canChangeMethod: false,
  canCancel: false,
  canSubmitProof: canSubmitProof,
  events: [
    paymentEventJson('created', at: testNow.subtract(const Duration(minutes: 30))),
    paymentEventJson(proofVersion == 1 ? 'proof_submitted' : 'proof_replaced', at: testNow, proofVersion: proofVersion),
  ],
);

/// Iuran ditolak dan dapat diperbaiki (prototipe layar 5).
Map<String, Object?> needsFixJson({String reason = 'Foto bukti buram sehingga nominal tidak terbaca.'}) => paymentJson(
  status: 'rejected',
  stage: 'needs_fix',
  proofVersion: 1,
  proofFileId: 'file-1',
  submittedAt: testNow.subtract(const Duration(days: 1)),
  decidedAt: testNow,
  rejectionReason: reason,
  version: '3',
  canChangeMethod: false,
  canCancel: false,
  events: [
    paymentEventJson('created', at: testNow.subtract(const Duration(days: 1, hours: 1))),
    paymentEventJson('proof_submitted', at: testNow.subtract(const Duration(days: 1)), proofVersion: 1),
    paymentEventJson('rejected', at: testNow, actor: 'admin', proofVersion: 1, reason: reason),
  ],
);

/// `FeeQuote`.
Map<String, Object?> feeQuoteJson({
  required String type,
  bool eligible = true,
  String? ineligibleReason,
  String? openPaymentId,
  DateTime? renewalOpensAt,
}) => {
  'type': type,
  'lines': linesFor(type),
  'total': amountFor(type),
  'eligible': eligible,
  'ineligible_reason': ineligibleReason,
  'open_payment_id': openPaymentId,
  'renewal_opens_at': renewalOpensAt == null ? null : iso(renewalOpensAt),
};

/// `MyFeeQuotes` untuk anggota unverified (bawaan) atau dengan kutipan tertentu.
Map<String, Object?> feesJson({
  Map<String, Object?>? registration,
  Map<String, Object?>? renewal,
  bool instructionsHidden = false,
}) => {
  'registration': registration ?? feeQuoteJson(type: 'registration'),
  'renewal': renewal ?? feeQuoteJson(type: 'renewal', eligible: false, ineligibleReason: 'registration_required'),
  'period_months': 12,
  'settings_version': '4',
  'instructions_hidden': instructionsHidden,
};

/// `MeMembershipPayment`.
Map<String, Object?> meMembershipPaymentJson({
  String id = 'pay-1',
  String stage = 'awaiting_review',
  String amount = '60000.00',
  int proofVersion = 1,
  String? rejectionReason,
}) => {
  'id': id,
  'stage': stage,
  'amount': amount,
  'proof_version': proofVersion,
  'created_at': iso(testNow.subtract(const Duration(hours: 1))),
  'submitted_at': proofVersion > 0 ? iso(testNow) : null,
  'decided_at': stage == 'rejected' ? iso(testNow) : null,
  'rejection_reason': rejectionReason,
};

/// `Membership` (GET /me/membership).
Map<String, Object?> membershipJson({
  String status = 'unverified',
  DateTime? startsAt,
  DateTime? expiresAt,
  bool renewalEligible = false,
  DateTime? renewalOpensAt,
  Map<String, Object?>? renewalPayment,
  List<Map<String, Object?>> periods = const [],
}) => {
  'effective_status': status,
  'member_number': '29.01.01.7',
  'card_issued_at': iso(testNow.subtract(const Duration(minutes: 45))),
  'starts_at': startsAt == null ? null : iso(startsAt),
  'expires_at': expiresAt == null ? null : iso(expiresAt),
  'renewal_eligible': renewalEligible,
  'renewal_opens_at': renewalOpensAt == null ? null : iso(renewalOpensAt),
  'renewal_payment': renewalPayment,
  'periods': periods,
};

/// `PaymentMethodList`.
Map<String, Object?> methodsJson([List<Map<String, Object?>> items = const [methodBsi, methodDana]]) => {
  'items': items,
};

/// `FileRef` hasil POST /files purpose payment_proof.
Map<String, Object?> fileRefJson({String id = 'file-2', String mime = 'image/jpeg', int bytes = 1258291}) => {
  'id': id,
  'purpose': 'payment_proof',
  'mime': mime,
  'bytes': bytes,
  'width': mime == 'application/pdf' ? null : 1600,
  'height': mime == 'application/pdf' ? null : 1200,
  'visibility': 'private',
  'public_url': null,
  'created_at': iso(testNow),
};

/// Foto JPEG uji (magic bytes FF D8 FF) berukuran tampilan 1,2 MB.
PickedProof jpegProof({String name = 'bukti-transfer.jpg'}) => PickedProof(
  name: name,
  sizeBytes: 1258291,
  kind: ProofKind.jpeg,
  bytes: Uint8List.fromList(const [0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1]),
);

/// Pemilih berkas tiruan: setiap sumber mengembalikan [result].
class FakeProofPicker implements ProofPicker {
  FakeProofPicker([ProofPickResult? result]) : result = result ?? ProofPicked(jpegProof());

  ProofPickResult result;
  final List<ProofSource> sources = [];

  @override
  Future<ProofPickResult> pick(ProofSource source) async {
    sources.add(source);
    return result;
  }
}

/// Header Idempotency-Key request.
String? idempotencyKeyOf(RequestOptions request) => request.headers['Idempotency-Key'] as String?;

/// Body JSON request.
Map<String, Object?> bodyOf(RequestOptions request) => (request.data as Map).cast<String, Object?>();

/// Layar uji tinggi agar seluruh isi daftar terbangun tanpa menggulir (lebar tetap 390 px prototipe).
Future<void> useTallScreen(WidgetTester tester, {double height = 2400}) async {
  tester.view.physicalSize = Size(390, height);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpAndSettle();
}

/// Menangkap teks yang disalin ke clipboard.
List<String> captureClipboard(WidgetTester tester) {
  final copied = <String>[];
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
    return null;
  });
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
  return copied;
}

/// Notifikasi realtime `notification.created` (kontrak events/notification.created.schema.json).
NotificationCreatedPayload notificationOf(
  String category, {
  String title = 'Iuran pendaftaran disetujui',
  int unreadCount = 1,
}) => NotificationCreatedPayload.fromJson({
  'id': 'notif-1',
  'category': category,
  'title': title,
  'body': null,
  'deep_link': 'kapdh://app/payments/pay-1',
  'created_at': iso(testNow),
  'unread_count': unreadCount,
});
