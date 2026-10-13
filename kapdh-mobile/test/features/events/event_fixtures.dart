// Fixture JSON domain Events (kontrak C5, events.yaml) dan metode bayar (payments.yaml). Setiap builder mengisi
// SEMUA field wajib skema; field nullable dikirim null bila tidak berlaku, sama seperti respons server.

import '../../support/fakes.dart';

String iso(DateTime value) => value.toUtc().toIso8601String();

/// Event uji: Camping Alumni KAPDH, Selasa 20 Okt 2026 09.00–15.00 WIB (testNow = 12 Okt 2026 14.00 WIB).
final eventStartsAt = DateTime.utc(2026, 10, 20, 2);
final eventEndsAt = DateTime.utc(2026, 10, 20, 8);

/// Batas refund penuh H-3 (starts_at dikurangi 3 hari kalender, D6).
final fullRefundUntil = DateTime.utc(2026, 10, 17, 2);

Map<String, Object?> eventCategoryJson({String id = 'cat-reuni', String slug = 'reuni', String label = 'Reuni'}) => {
  'id': id,
  'slug': slug,
  'label': label,
};

Map<String, Object?> eventSummaryJson({
  String id = 'event-1',
  String title = 'Camping Alumni KAPDH',
  Map<String, Object?>? category,
  bool noCategory = false,
  String status = 'open',
  String registrationState = 'open',
  String price = '200000.00',
  int seatsTotal = 36,
  int seatsAvailable = 20,
  String? myTicketStatus,
  DateTime? startsAt,
  DateTime? endsAt,
  String timezone = 'Asia/Jakarta',
  String? locationName = 'Bumi Perkemahan Cibubur',
}) => {
  'id': id,
  'title': title,
  'category': noCategory ? null : (category ?? eventCategoryJson()),
  'cover_url': 'https://files.kapdh.or.id/events/$id.jpg',
  'starts_at': iso(startsAt ?? eventStartsAt),
  'ends_at': iso(endsAt ?? eventEndsAt),
  'timezone': timezone,
  'location_name': locationName,
  'status': status,
  'registration_state': registrationState,
  'price': price,
  'is_free': price == '0.00',
  'seats_total': seatsTotal,
  'seats_available': seatsAvailable,
  'my_ticket_status': myTicketStatus,
};

Map<String, Object?> cancellationPolicyJson({bool free = false}) => {
  'self_cancel_until': iso(eventStartsAt),
  'full_refund_until': free ? null : iso(fullRefundUntil),
  'refund_processing_business_days': 7,
  'summary': free
      ? 'Event gratis tidak memiliki refund; pembatalan melepas kursi.'
      : 'Batalkan sampai 17 Okt 2026 09.00 WIB (H-3) untuk refund penuh; setelah itu tanpa refund. Refund '
            'ditransfer bendahara paling lambat 7 hari kerja.',
};

Map<String, Object?> eventDetailJson({
  String id = 'event-1',
  String title = 'Camping Alumni KAPDH',
  String status = 'open',
  String registrationState = 'open',
  String price = '200000.00',
  int seatsTotal = 36,
  int seatsAvailable = 20,
  int participantCount = 16,
  bool canReserve = true,
  String? blockedReason,
  Map<String, Object?>? myTicket,
  String? cancelReason,
  String? locationUrl = 'https://maps.example.com/cibubur',
  DateTime? registrationOpensAt,
}) => {
  ...eventSummaryJson(
    id: id,
    title: title,
    status: status,
    registrationState: registrationState,
    price: price,
    seatsTotal: seatsTotal,
    seatsAvailable: seatsAvailable,
    myTicketStatus: myTicket?['status'] as String?,
  ),
  'description': 'Camping Alumni KAPDH jadi momen buat kumpul lagi, ngobrol santai, dan mempererat silaturahmi.',
  'location_address': 'Jl. Jambore No. 1, Cibubur, Jakarta Timur',
  'location_url': locationUrl,
  'registration_opens_at': iso(registrationOpensAt ?? DateTime.utc(2026, 10, 1)),
  'registration_closes_at': iso(DateTime.utc(2026, 10, 19, 17)),
  'checkin_opens_at': iso(DateTime.utc(2026, 10, 20)),
  'checkin_closes_at': iso(eventEndsAt),
  'hold_hours': 24,
  'participant_count': participantCount,
  'cancellation_policy': cancellationPolicyJson(free: price == '0.00'),
  'cancelled_at': status == 'cancelled' ? iso(testNow.subtract(const Duration(hours: 2))) : null,
  'cancel_reason': cancelReason,
  'can_reserve': canReserve,
  'reservation_blocked_reason': blockedReason,
  'my_ticket': myTicket,
  'updated_at': iso(testNow.subtract(const Duration(days: 1))),
};

Map<String, Object?> eventPageJson(List<Map<String, Object?>> items, {String? nextCursor}) => {
  'items': items,
  'next_cursor': nextCursor,
};

Map<String, Object?> participantJson({String userId = 'user-2', String fullName = 'Ahmad Yusiana', int cohort = 1}) =>
    {
      'user_id': userId,
      'full_name': fullName,
      'cohort': cohort,
      'cohort_code': 'KAPDH ${cohort.toString().padLeft(2, '0')}',
      'avatar_url': null,
    };

Map<String, Object?> ticketEventInfoJson({String id = 'event-1', String status = 'open'}) => {
  'id': id,
  'title': 'Camping Alumni KAPDH',
  'cover_url': 'https://files.kapdh.or.id/events/$id.jpg',
  'starts_at': iso(eventStartsAt),
  'ends_at': iso(eventEndsAt),
  'timezone': 'Asia/Jakarta',
  'location_name': 'Bumi Perkemahan Cibubur',
  'status': status,
};

Map<String, Object?> ticketSummaryJson({
  String id = 'ticket-1',
  String status = 'paid',
  String total = '200000.00',
  String eventStatus = 'open',
  DateTime? holdExpiresAt,
  DateTime? checkedInAt,
  DateTime? cancelledAt,
  String? cancelledBy,
  String? paymentStatus,
}) => {
  'id': id,
  'status': status,
  'event': ticketEventInfoJson(status: eventStatus),
  'total': total,
  'hold_expires_at': holdExpiresAt == null ? null : iso(holdExpiresAt),
  'checked_in_at': checkedInAt == null ? null : iso(checkedInAt),
  'cancelled_at': cancelledAt == null ? null : iso(cancelledAt),
  'cancelled_by': cancelledBy,
  'payment_status': total == '0.00' ? null : (paymentStatus ?? _paymentStatusFor(status)),
  'created_at': iso(testNow.subtract(const Duration(hours: 3))),
};

String _paymentStatusFor(String ticketStatus) => switch (ticketStatus) {
  'paid' => 'paid',
  'expired' => 'cancelled',
  'cancelled' => 'cancelled',
  _ => 'pending',
};

Map<String, Object?> ticketPaymentJson({
  String id = 'payment-9',
  String status = 'pending',
  String amount = '200000.00',
  DateTime? submittedAt,
  DateTime? decidedAt,
  String? rejectionReason,
}) => {
  'id': id,
  'status': status,
  'amount': amount,
  'method': {
    'kind': 'bank',
    'provider': 'Bank Syariah Indonesia',
    'account_number': '7123456789',
    'account_holder': 'KAPDH Pusat',
    'instructions': null,
  },
  'proof_version': submittedAt == null ? 0 : 1,
  'submitted_at': submittedAt == null ? null : iso(submittedAt),
  'decided_at': decidedAt == null ? null : iso(decidedAt),
  'rejection_reason': rejectionReason,
};

Map<String, Object?> refundJson({String id = 'refund-1', String status = 'pending', String amount = '200000.00'}) => {
  'id': id,
  'status': status,
  'amount': amount,
  'due_at': iso(DateTime.utc(2026, 10, 21, 10)),
  'completed_at': status == 'completed' ? iso(testNow) : null,
  'cancelled_at': status == 'cancelled' ? iso(testNow) : null,
  'created_at': iso(testNow),
};

Map<String, Object?> ticketDetailJson({
  String id = 'ticket-1',
  String status = 'paid',
  String total = '200000.00',
  String eventStatus = 'open',
  DateTime? holdExpiresAt,
  DateTime? checkedInAt,
  DateTime? cancelledAt,
  String? cancelledBy,
  String? cancelReason,
  Map<String, Object?>? payment,
  bool noPayment = false,
  List<Map<String, Object?>> refunds = const [],
  bool? canCancel,
  bool? refundEligible,
  String? qrCode,
  String version = '4',
}) {
  final free = total == '0.00';
  final paid = status == 'paid';
  final effectivePayment = free || noPayment
      ? null
      : (payment ??
            ticketPaymentJson(
              status: _paymentStatusFor(status),
              amount: total,
              submittedAt: status == 'awaiting_review' || paid ? testNow.subtract(const Duration(hours: 2)) : null,
              decidedAt: paid ? testNow.subtract(const Duration(hours: 1)) : null,
            ));
  return {
    ...ticketSummaryJson(
      id: id,
      status: status,
      total: total,
      eventStatus: eventStatus,
      holdExpiresAt: holdExpiresAt,
      checkedInAt: checkedInAt,
      cancelledAt: cancelledAt,
      cancelledBy: cancelledBy,
      paymentStatus: effectivePayment?['status'] as String?,
    ),
    'qr_code': qrCode ?? (paid && eventStatus != 'cancelled' ? 'qr-acak-128-bit-uji' : null),
    'checkin_opens_at': iso(DateTime.utc(2026, 10, 20)),
    'checkin_closes_at': iso(eventEndsAt),
    'cancel_reason': cancelReason,
    'payment': effectivePayment,
    'refunds': refunds,
    'can_cancel':
        canCancel ??
        (((status == 'paid' && checkedInAt == null) || status == 'awaiting_payment') && eventStatus != 'cancelled'),
    'refund_eligible': refundEligible ?? (paid && !free && checkedInAt == null && eventStatus != 'cancelled'),
    'full_refund_until': free ? null : iso(fullRefundUntil),
    'version': version,
  };
}

Map<String, Object?> ticketPageJson(List<Map<String, Object?>> items, {String? nextCursor}) => {
  'items': items,
  'next_cursor': nextCursor,
};

Map<String, Object?> paymentMethodJson({
  String id = 'method-bsi',
  String kind = 'bank',
  String provider = 'Bank Syariah Indonesia',
  String accountNumber = '7123456789',
}) => {
  'id': id,
  'kind': kind,
  'provider': provider,
  'account_number': accountNumber,
  'account_holder': 'KAPDH Pusat',
  'instructions': null,
};
