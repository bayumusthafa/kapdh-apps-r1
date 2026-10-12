# Phase B handoff: contract C5-events

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

## fix summary
I checked all 7 review findings against PRD 2.2, 2.3, 3.9 (D6), 4.3, 4.4 and 6.4, and against ARCHITECTURE §3.1, §3.3 and §4.6. All 7 are real and all 7 are fixed. Commit c1d8d56 is on top of b451628. It changes only events.yaml, admin-events.yaml and CHANGELOG.md.

1. (high) adminCancelTicket with `refund=true` is now restricted.
   - The caller also needs `payments.decide`, evaluated from the DB.
   - It is refused with 403 FORBIDDEN when the ticket holder is the caller's linked alumni account (`admins.linked_alumni_user_id`).
   - Both checks run before any change. `refund=false` still needs only events.manage.
   - New required field `AdminEventTicket.can_refund`, computed for the caller.
   - The 403 response and the `AdminTicketCancelRequest.refund` description now document this.
   - adminCancelEvent says its refunds are required by D6 (not a discretionary decision), so events.manage is enough there; the treasurer settles them under the PRD 2.3 conflict-of-interest rule.
2. (medium) A binding global lock order now heads events.yaml: events row, then tickets ordered by id, then payments ordered by id.
   - IDs taken from another row are read without a lock first; state is checked again once the lock is held.
   - The header maps every path to this order: reservation and the hold-expiry job, self-cancel, admin ticket cancel, admin event cancel, admin update and status change, check-in, account deletion, and the payments paths for type=ticket.
   - cancelMyTicket ("lock ticket, then event") and adminCancelEvent now describe this order.
   - Payments paths for type=ticket must lock event and ticket before the payment row. That needs a PaymentTypeHandler hook that ARCHITECTURE §4.6 does not have yet (see shared_changes).
3. (medium) What the payments API must do for type=ticket is now written in the events.yaml header and in the TicketPaymentInfo description, and is listed under shared_changes for C3.
4. (low) Event browsing now follows PRD 2.2.
   - listEventCategories and listEvents now need `active`; 403 means MEMBERSHIP_REQUIRED or ACCOUNT_SUSPENDED.
   - getEvent keeps `nonsuspended`, with a check in the service: unverified or expired callers can open only events where they hold a ticket. Otherwise they get 403 MEMBERSHIP_REQUIRED, the same whether or not the event exists (N-09).
   - The wrong PRD 2.2 citation is removed.
5. (low) Added 400 VALIDATION_ERROR to listEventParticipants, getEvent, getMyTicket, adminGetEvent, adminDeleteEvent and adminGetEventStats.
6. (low) adminSetEventStatus now takes an Idempotency-Key and declares `idempotent: true`. The check order is documented: replay first, then the same-status no-op returns 200 before If-Match is compared, then If-Match, then the transition. Its 409 description covers VERSION_CONFLICT and IDEMPOTENCY_CONFLICT.
7. (low) EventReservationRequest now has a required `expected_price` (Money). New step 5, after the sold-out check and before payment method validation: if the price differs, the server returns 409 VERSION_CONFLICT with current = EventDetail and creates no hold.

All operations are new in this phase, so none of these changes breaks a pre-existing operation. The CHANGELOG C5 section now mentions the conditional permission, the getEvent exception and the lock order.

## contract/shared changes
- Suggested, not made (core/ARCHITECTURE §4.6, PaymentTypeHandler): add an optional hook, e.g. `lockRelated?(tx: Tx, payment: { id: string; ticketId: string | null }): Promise<void>`. The payments kernel would call it BEFORE `SELECT payments ... FOR UPDATE` on proof submission, decision and cancellation. The ticket handler would use it to lock the events row and then the tickets row. Proof submission may lock only the ticket. This is what makes the global order (events, then tickets, then payments, PRD 6.4) hold for type=ticket. onApproved and onRejected must not lock the event or ticket after the payment is locked.
- Suggested, not made (C3 payments.yaml submitPaymentProof): for type=ticket, also return 409 RESERVATION_EXPIRED with current = Payment when the proof arrives after hold_expires_at, or when the ticket is no longer awaiting_payment or awaiting_review (AC F09-2).
- Suggested, not made (C3 admin-payments.yaml adminDecidePayment): for a ticket payment whose ticket was cancelled by an event cancellation, approve makes the payment paid and creates a pending refund payment_adjustment for the full total (due in 7 business days, D6). The ticket stays cancelled and the seat counters do not change. Reject makes the payment rejected and does not release the seat a second time. The admin payment queue item should show the ticket status and event status (and the event title) so the deciding admin can see the event was cancelled.
- packages/contracts/CHANGELOG.md: the '## Belum dirilis > ### C5 Events' section got two more bullets. Expect a trivial merge with other authors' sections.
- Still open from the builder: content.yaml Home.upcoming_events refs EventSummary (C4/integrator), and files.yaml purpose event_cover (C3).

## open issues
- The lock order is binding in the contract, but the payments kernel cannot follow it for type=ticket until the PaymentTypeHandler pre-lock hook exists (see shared_changes). Until then, an approval running at the same time as an event cancel or a self-cancel can still deadlock (40P01). The integrator or core-api must add the hook before the events module is implemented.
- Product reading to confirm with the PO: event browsing is now limited to active members (PRD 2.2 allow-lists for unverified and expired do not mention event information). Unverified or expired members can open only events where they hold a ticket. If the PO wants unverified members to browse events, relax listEvents and listEventCategories back to nonsuspended.
- x-kapdh-access has no field for conditional permissions. adminCancelTicket declares events.manage, and the additional payments.decide for refund=true is documented only in prose. A future lint or decorator-parity test must treat this as a documented exception.
- Still open from the builder: event category CRUD ownership (C4 vs events.manage); refund destination account flow (C3 payment_adjustments, D6/D2); the H-3 reading (starts_at minus 3 calendar days in the event timezone); the schedule-change notification in adminUpdateEvent is a product reading; x-kapdh-access is not machine-enforced; review_overdue business days and hold release on the next request are described only in prose.

## handoff
FILES: kapdh-platform/packages/contracts/openapi/domains/events.yaml (tag Events) and admin-events.yaml (tag Admin Events). Dart classes: KapdhApi.events and KapdhApi.adminEvents.

OPERATIONS (METHOD path operationId access):
- GET /event-categories listEventCategories mobile/active (changed from nonsuspended)
- GET /events listEvents mobile/active (changed; query: category_id, period=upcoming|past, q, cursor, limit)
- GET /events/{eventId} getEvent mobile/nonsuspended. Service exception: unverified or expired callers get the event only when they hold a ticket on it (any status). Otherwise 403 MEMBERSHIP_REQUIRED, the same whether or not the event exists. For these callers can_reserve=false and reservation_blocked_reason=membership_required.
- GET /events/{eventId}/participants listEventParticipants mobile/active
- POST /events/{eventId}/reservations createEventReservation mobile/active idempotent (201 TicketDetail). Body: {expected_price: Money (required), payment_method_id?}.
  Steps run with the event row locked:
  1. Release expired holds (ticket -> expired, payment -> cancelled).
  2. Registration window, else 409 RESERVATION_EXPIRED.
  3. Active ticket, else 409 VERSION_CONFLICT with current = TicketDetail.
  4. Seats, else 409 EVENT_SOLD_OUT.
  5. expected_price != price, else 409 VERSION_CONFLICT with current = EventDetail, no hold.
  6. payment_method_id, else 400.
- GET /me/tickets listMyTickets mobile/nonsuspended
- GET /me/tickets/{ticketId} getMyTicket mobile/nonsuspended
- POST /me/tickets/{ticketId}/cancel cancelMyTicket mobile/nonsuspended idempotent, If-Match
- GET /admin/event-categories adminListEventCategories admin [events.manage]
- GET /admin/events adminListEvents admin [events.manage]
- POST /admin/events adminCreateEvent admin [events.manage] idempotent
- GET /admin/events/{eventId} adminGetEvent admin [events.manage]
- PATCH /admin/events/{eventId} adminUpdateEvent admin [events.manage] If-Match
- DELETE /admin/events/{eventId} adminDeleteEvent admin [events.manage] If-Match
- POST /admin/events/{eventId}/status adminSetEventStatus admin [events.manage] idempotent (new), If-Match. Check order:
  1. Idempotency replay.
  2. Same status: 200 no-op before If-Match is compared.
  3. If-Match.
  4. Transition rules.
- POST /admin/events/{eventId}/cancel adminCancelEvent admin [events.manage] idempotent, If-Match
- GET /admin/events/{eventId}/stats adminGetEventStats admin [events.manage]
- GET /admin/events/{eventId}/tickets adminListEventTickets admin [events.manage]
- POST /admin/events/{eventId}/tickets/{ticketId}/cancel adminCancelTicket admin [events.manage] idempotent, If-Match. refund=true also needs payments.decide, and is refused with 403 FORBIDDEN when ticket.user_id == caller admins.linked_alumni_user_id. Both checks run before any write.
- GET /admin/checkin/events adminListCheckinEvents admin [events.checkin]
- POST /admin/checkin adminCheckInTicket admin [events.checkin] idempotent

SCHEMA CHANGES IN THIS FIX:
- EventReservationRequest.expected_price is required (Money).
- AdminEventTicket.can_refund is a required boolean, computed for the caller: ticket paid, total > 0, not checked in, event not cancelled, caller has payments.decide, holder is not the caller's linked alumni account.
- The other schemas are unchanged from the builder handoff: EventSummary, EventDetail, TicketSummary, TicketDetail, AdminEventSummary, AdminEventDetail, AdminCheckinRejection, etc.

BINDING LOCK ORDER (events.yaml header, PRD 6.4):
- Lock the events row, then tickets ordered by id ASC, then payments ordered by id ASC. payment_adjustments are only inserted after that.
- Read event_id or ticket_id without a lock, lock in this order, then check state again.
- Use SELECT ... FOR UPDATE.
- Self-cancel and adminCancelTicket lock the event first, then the ticket, then the payment.
- adminCancelEvent locks the event, then all active tickets, then their payments.
- Check-in updates only the ticket, with a conditional UPDATE.
- Payments for type=ticket need the pre-lock hook (shared_changes).

The remaining 400s were added on uuid-path and If-Match operations.
