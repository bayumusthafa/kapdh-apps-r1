import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:kapdh_api/kapdh_api.dart';

import '../home/shared/paged_list.dart';
import 'events_repository.dart';

/// Kategori event aktif untuk tab daftar (guideline hal. 8 "Semua | Reuni | Workshop"); tab "Semua" dibuat klien.
final eventCategoriesProvider = FutureProvider.autoDispose<List<EventCategoryRef>>(
  (ref) => ref.watch(eventsRepositoryProvider).listCategories(),
  retry: (retryCount, error) => null,
);

/// Filter daftar event: kategori (null = semua), periode dan kata kunci.
typedef EventQuery = ({String? categoryId, EventListPeriod period, String query});

final eventsControllerProvider = NotifierProvider.autoDispose
    .family<EventsController, PagedState<EventSummary>, EventQuery>(EventsController.new);

class EventsController extends PagedController<EventSummary> {
  EventsController(this.query);

  final EventQuery query;

  @override
  Future<CursorPage<EventSummary>> fetchPage(String? cursor) => ref
      .read(eventsRepositoryProvider)
      .listEvents(categoryId: query.categoryId, period: query.period, query: query.query, cursor: cursor);

  @override
  Object keyOf(EventSummary item) => item.id;
}

/// Keadaan detail event (F-09).
@immutable
class EventDetailState {
  const EventDetailState({this.event, this.loading = true, this.error});

  final EventDetail? event;
  final bool loading;
  final ApiException? error;
}

final eventDetailControllerProvider = NotifierProvider.autoDispose
    .family<EventDetailController, EventDetailState, String>(EventDetailController.new);

class EventDetailController extends Notifier<EventDetailState> {
  EventDetailController(this.eventId);

  final String eventId;
  int _generation = 0;

  @override
  EventDetailState build() {
    final generation = ++_generation;
    scheduleMicrotask(() {
      if (ref.mounted && generation == _generation) unawaited(reload());
    });
    return const EventDetailState();
  }

  /// Memuat ulang dari server; mengembalikan detail terbaru (null bila gagal).
  Future<EventDetail?> reload() async {
    final generation = ++_generation;
    state = EventDetailState(event: state.event);
    try {
      final event = await ref.read(eventsRepositoryProvider).getEvent(eventId);
      if (!ref.mounted || generation != _generation) return event;
      state = EventDetailState(event: event, loading: false);
      return event;
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return null;
      state = EventDetailState(event: state.event, loading: false, error: error);
      reportStatusError(ref, error);
      return null;
    }
  }

  /// Menerapkan `current` dari galat 409 (EventDetail terbaru untuk pemanggil, PRD 4.5 "muat ulang data terbaru").
  void apply(EventDetail event) {
    _generation++;
    state = EventDetailState(event: event, loading: false);
  }
}

/// Peserta terkonfirmasi yang tampil di direktori (PRD 3.10, AC F10-2); hanya dimuat untuk anggota aktif.
final participantsControllerProvider = NotifierProvider.autoDispose
    .family<ParticipantsController, PagedState<EventParticipant>, String>(ParticipantsController.new);

class ParticipantsController extends PagedController<EventParticipant> {
  ParticipantsController(this.eventId);

  final String eventId;

  @override
  Future<CursorPage<EventParticipant>> fetchPage(String? cursor) =>
      ref.read(eventsRepositoryProvider).listParticipants(eventId, cursor: cursor);

  @override
  Object keyOf(EventParticipant item) => item.userId;
}

/// Rekening tujuan aktif untuk event berbayar.
final paymentMethodsProvider = FutureProvider.autoDispose<List<PaymentMethod>>(
  (ref) => ref.watch(eventsRepositoryProvider).listPaymentMethods(),
  retry: (retryCount, error) => null,
);

/// Tiket saya per tampilan (aktif/riwayat).
final ticketsControllerProvider = NotifierProvider.autoDispose
    .family<TicketsController, PagedState<TicketSummary>, TicketListView>(TicketsController.new);

class TicketsController extends PagedController<TicketSummary> {
  TicketsController(this.view);

  final TicketListView view;

  @override
  Future<CursorPage<TicketSummary>> fetchPage(String? cursor) =>
      ref.read(eventsRepositoryProvider).listMyTickets(view: view, cursor: cursor);

  @override
  Object keyOf(TicketSummary item) => item.id;
}

/// Keadaan detail tiket (F-09, PRD 4.4).
@immutable
class TicketDetailState {
  const TicketDetailState({this.ticket, this.loading = true, this.error, this.cancelling = false});

  final TicketDetail? ticket;
  final bool loading;
  final ApiException? error;
  final bool cancelling;
}

final ticketDetailControllerProvider = NotifierProvider.autoDispose
    .family<TicketDetailController, TicketDetailState, String>(TicketDetailController.new);

class TicketDetailController extends Notifier<TicketDetailState> {
  TicketDetailController(this.ticketId);

  final String ticketId;
  int _generation = 0;

  @override
  TicketDetailState build() {
    final generation = ++_generation;
    scheduleMicrotask(() {
      if (ref.mounted && generation == _generation) unawaited(reload());
    });
    return const TicketDetailState();
  }

  Future<void> reload() async {
    final generation = ++_generation;
    state = TicketDetailState(ticket: state.ticket, cancelling: state.cancelling);
    try {
      final ticket = await ref.read(eventsRepositoryProvider).getMyTicket(ticketId);
      if (!ref.mounted || generation != _generation) return;
      state = TicketDetailState(ticket: ticket, loading: false);
    } on ApiException catch (error) {
      if (!ref.mounted || generation != _generation) return;
      state = TicketDetailState(ticket: state.ticket, loading: false, error: error);
      reportStatusError(ref, error);
    }
  }

  void apply(TicketDetail ticket) {
    _generation++;
    state = TicketDetailState(ticket: ticket, loading: false);
  }

  /// Membatalkan tiket sendiri (D6). Mengembalikan galat untuk ditampilkan layar; 409 dengan `current` langsung
  /// diterapkan sehingga anggota melihat keadaan terbaru (mis. batas H-3 terlewati) sebelum memutuskan lagi.
  Future<ApiException?> cancel({required bool expectedRefundEligible, String? reason}) async {
    final ticket = state.ticket;
    if (ticket == null || state.cancelling) return null;
    state = TicketDetailState(ticket: ticket, loading: false, cancelling: true);
    try {
      final result = await ref
          .read(eventsRepositoryProvider)
          .cancelTicket(ticket, expectedRefundEligible: expectedRefundEligible, reason: reason);
      if (!ref.mounted) return null;
      apply(result);
      ref
        ..invalidate(ticketsControllerProvider)
        ..invalidate(eventDetailControllerProvider(ticket.event.id));
      return null;
    } on ApiException catch (error) {
      if (!ref.mounted) return error;
      final current = ticketDetailFromConflict(error);
      if (current != null) {
        apply(current);
      } else {
        state = TicketDetailState(ticket: ticket, loading: false);
      }
      reportStatusError(ref, error);
      return error;
    }
  }
}
