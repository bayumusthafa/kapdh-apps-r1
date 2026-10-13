import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/idempotency_store.dart';
import '../home/shared/paged_list.dart';

/// Repositori Event dan Tiket (F-09) di atas SDK terbangkit (`KapdhApi.events`, `KapdhApi.payments`). Semua aturan
/// bisnis (kuota, hold, kelayakan, refund) diputus server; repositori hanya meneruskan dan menjaga Idempotency-Key
/// mutasi sampai hasilnya diketahui (PRD 4.3).
class EventsRepository {
  EventsRepository(this._events, this._payments, this._idempotency);

  final EventsApi _events;
  final PaymentsApi _payments;
  final IdempotencyStore _idempotency;

  /// Jumlah item per halaman daftar.
  static const pageSize = 20;

  Future<List<EventCategoryRef>> listCategories() async => (await _events.listEventCategories()).items;

  Future<CursorPage<EventSummary>> listEvents({
    String? categoryId,
    EventListPeriod period = EventListPeriod.upcoming,
    String? query,
    String? cursor,
  }) async {
    final q = query?.trim();
    final page = await _events.listEvents(
      categoryId: categoryId,
      period: period,
      q: q == null || q.isEmpty ? null : q,
      cursor: cursor,
      limit: pageSize,
    );
    return (items: page.items, nextCursor: page.nextCursor);
  }

  Future<EventDetail> getEvent(String eventId) => _events.getEvent(eventId);

  Future<CursorPage<EventParticipant>> listParticipants(String eventId, {String? cursor, int limit = pageSize}) async {
    final page = await _events.listEventParticipants(eventId, cursor: cursor, limit: limit);
    return (items: page.items, nextCursor: page.nextCursor);
  }

  /// Rekening tujuan aktif untuk event berbayar (guideline hal. 8 "Metode Pembayaran", D13).
  Future<List<PaymentMethod>> listPaymentMethods() async => (await _payments.listPaymentMethods()).items;

  /// Niat idempotensi reservasi satu event.
  static String reserveIntent(String eventId) => 'event.reserve.$eventId';

  /// Daftar satu kursi untuk diri sendiri (AC F09-1, F09-3). [expectedPrice] adalah harga yang dikonfirmasi
  /// anggota; event gratis tanpa [paymentMethodId]. Key yang sama dipakai ulang bila jaringan putus sehingga
  /// pengulangan tidak membuat tiket ganda (PRD 4.3, 4.5).
  Future<TicketDetail> reserve(String eventId, {required String expectedPrice, String? paymentMethodId}) {
    final body = EventReservationRequest(
      expectedPrice: expectedPrice,
      paymentMethodId: paymentMethodId == null ? const Optional.absent() : Optional(paymentMethodId),
    );
    return _idempotency.run(
      reserveIntent(eventId),
      body.toJson(),
      (key) => _events.createEventReservation(eventId, body, idempotencyKey: key),
    );
  }

  Future<CursorPage<TicketSummary>> listMyTickets({required TicketListView view, String? cursor}) async {
    final page = await _events.listMyTickets(view: view, cursor: cursor, limit: pageSize);
    return (items: page.items, nextCursor: page.nextCursor);
  }

  Future<TicketDetail> getMyTicket(String ticketId) => _events.getMyTicket(ticketId);

  /// Batalkan tiket sendiri (D6): [expectedRefundEligible] adalah kelayakan refund yang ditampilkan saat konfirmasi;
  /// versi tiket dikirim sebagai If-Match.
  Future<TicketDetail> cancelTicket(TicketDetail ticket, {required bool expectedRefundEligible, String? reason}) {
    final trimmed = reason?.trim();
    final body = TicketCancelRequest(
      expectedRefundEligible: expectedRefundEligible,
      reason: trimmed == null || trimmed.isEmpty ? const Optional.absent() : Optional(trimmed),
    );
    return _idempotency.run(
      'ticket.cancel.${ticket.id}',
      {...body.toJson(), 'if_match': ticket.version},
      (key) => _events.cancelMyTicket(ticket.id, body, ifMatch: ticket.version, idempotencyKey: key),
    );
  }
}

final eventsRepositoryProvider = Provider<EventsRepository>((ref) {
  final api = ref.watch(kapdhApiProvider);
  return EventsRepository(api.events, api.payments, ref.watch(idempotencyStoreProvider));
});

/// `current` pada galat 409 reservasi selalu EventDetail terbaru untuk pemanggil (kontrak C5); null bila tidak ada
/// atau bentuknya tidak sesuai.
EventDetail? eventDetailFromConflict(ApiException error) => _decode(error.current, EventDetail.fromJson);

/// `current` pada galat 409 pembatalan tiket adalah TicketDetail terbaru (kontrak C5).
TicketDetail? ticketDetailFromConflict(ApiException error) => _decode(error.current, TicketDetail.fromJson);

T? _decode<T>(Object? raw, T Function(Map<String, Object?> json) decode) {
  if (raw is! Map<String, Object?>) return null;
  try {
    return decode(raw);
  } on Object {
    return null;
  }
}
