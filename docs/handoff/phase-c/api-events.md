# Phase C slice: api-events

Final report after build, adversarial review (9 findings) and fixes (commit e858761).

## Summary
I checked all 9 review findings for slice api-events. Six were real and are fixed, each with a test that would have caught it. Finding 8 is real but needs a payments-owned API, so it is recorded as an open issue. Finding 9 is partly rejected.

Fixes:
- Findings 1 and 5 (duplicates), check-in window past the end of the event:
  - adminCreateEvent and adminUpdateEvent now reject checkin_closes_at > ends_at with 400 field_errors.checkin_closes_at (scheduleErrors in admin-events.service.ts).
  - checkinWindow (event-rules.ts) and the SQL for the scanner list (checkin.service.ts) cap the effective close at ends_at. Older rows can no longer advertise a window that is never enforced. This applies to effective_checkin_closes_at, TicketDetail.checkin_closes_at, the scanner list and too_late rejections.
  - The contract descriptions in admin-events.yaml are updated.
- Finding 2: events.yaml now says 409 RESERVATION_EXPIRED in all three places, matching the implementation and payments.yaml. The AC F09-2 e2e test and the pg test now assert HTTP 409 and current = PaymentDetail.
- Finding 3: H-N is now computed in event.timezone as the same wall-clock time N calendar days earlier (new calendarDaysBefore in event-rules.ts). It handles both the spring-forward gap and the autumn overlap. fullRefundUntil takes the event, and memberRefundEligible, cancellationPolicy, TicketDetail and self-cancel all use it. Indonesian zones still get exactly 72 h.
- Finding 6: events.reminders handles each event in chunks of up to 500 holders.
  - Each chunk runs in one transaction that first runs SELECT events ... FOR SHARE.
  - It then recomputes status, starts_at and the reminder kind/dedup key from the locked row, and re-reads the paid holders before notifying.
  - Cancel, update, self-cancel and payment decisions all lock the event FOR UPDATE, so they are serialized with the reminder transaction.
- Finding 7: adminCancelEvent locks all active tickets, including lapsed holds, in one SELECT ordered by id. It then processes them in payment-id order: lapsed holds expire through expireTicket, the rest are cancelled. No ticket is locked after a payment.
- Finding 4: there is now a contract-driven AC F15-1 test: 14 admin operations x 4 sessions (member, payments-only admin, events.checkin-only admin, events.manage-only admin), 42 denials checked with 403 FORBIDDEN and no state change. A second test checks ACCOUNT_SUSPENDED on all 8 member operations, including getMyTicket and cancelMyTicket, and 403 for an admin token. Test names that lacked an ID now carry AC/PRD prefixes.

Proof that the new tests catch the old code: I temporarily restored the old events-jobs.service.ts, and the new reminder test failed with 1 stale reminder. I temporarily restored the old admin-events.service.ts, and the new pg lock-order test failed because the lapsed payment was already locked while cancel waited on a ticket. Both new files were put back before committing.

Verification, all green: pnpm build, typecheck, lint, test (API 552/552), test:pg (77/77), contracts:lint, contracts:test-dart, format:check.

Commits: wip 1a63b52, then fix e858761.

## AC coverage
- [covered] D5 / AC F09-6: a check-in override cannot outlast the event; the window shown equals the window enforced: checkin.e2e 'D5, AC F09-6: override check-in yang ditutup sesudah acara selesai ...':
- create returns 400 field_errors.checkin_closes_at; closes == ends_at is allowed; a PATCH that moves ends_at earlier returns 400.
- For an older row, effective_checkin_closes_at, TicketDetail and the scanner list all show ends_at.
- After the end, a scan is too_late with the same window both before and after events.lifecycle.
event-rules.test 'D5, AC F09-6' covers the clamp.
- [covered] AC F09-2 (proof sent after the hold expired is rejected): reservations.e2e 'AC F09-2' now asserts statusCode 409, code RESERVATION_EXPIRED and current {id, status cancelled}. The pg test 'AC F09-2' asserts 409.
- [covered] D6 (self-cancel until H-3 gets a full refund; the deadline is in the event's timezone): event-rules.test 'D6: H-3 = jam dinding yang sama 3 hari kalender sebelumnya ...':
- Europe/London: 2026-10-24T08:00Z, plus the summary text.
- Boundaries of memberRefundEligible.
- DST gap and overlap cases.
- Asia/Jayapura is exactly 72 h.
The existing tickets.e2e D6 tests still pass.
- [covered] AC F13-6 (H-3/H-1 reminders; stale schedules are cancelled when the event changes): jobs.e2e 'AC F13-6: pembatalan dan perubahan jadwal yang commit di tengah putaran job ...': the job's first transaction runs an admin cancel and a reschedule, and no reminder is written for either event. The new schedule then gets exactly one h1 reminder with the new key. This test fails against the previous implementation. The earlier F13-6 tests still pass.
- [covered] PRD 6.4 lock order (adminCancelEvent: event, then all active tickets, then payments): pg test 'pembatalan event mengunci SEMUA tiket aktif ...':
- While cancel waits on a ticket, the lapsed hold's payment can still be locked with FOR UPDATE NOWAIT.
- Final state: expired/cancelled tickets, both payments cancelled with the right reasons, counters at 0.
- This test fails against the previous implementation.
- [covered] AC F15-1 (permissions evaluated; access without permission is refused), negative authz per endpoint: access.e2e 'AC F15-1: setiap operasi pengurus event (baca dan ubah) ditolak 403 ...': 42 denials, driven by x-kapdh-access, with no change to the event or ticket. Also access.e2e 'PRD 2.2: anggota suspended ditolak ACCOUNT_SUSPENDED di setiap operasi anggota event ...' (8 operations, plus 403 for an admin token).
- [covered] AC F09-1, F09-3, F09-4, F09-5, F09-7, F15-2, F15-4, PRD 2.2 (from the builder): All existing tests still pass: API 552/552 and pg 77/77.

## Verification
- pass `pnpm build`: 10/10 tasks
- pass `pnpm typecheck`: 15/15 tasks
- pass `pnpm lint`: 9/9 tasks; only the 2 known contracts warnings
- pass `pnpm test`: API 552/552 (46 files), admin 143/143, other packages green; exit 0
- pass `pnpm --filter @kapdh/api test:pg`: 77/77 (12 files). The known embedded-postgres 'done is not a function' teardown message appears afterwards.
- pass `pnpm contracts:lint`: Valid; 2 known no-ambiguous-paths warnings
- pass `pnpm contracts:test-dart`: Dart SDK analyze clean and all tests pass
- pass `pnpm format:check`: All matched files use Prettier code style
- fail `regression check: old events-jobs.service.ts with the new jobs.e2e test`: Done on purpose: with the old implementation restored, the new AC F13-6 test failed (1 stale reminder). The new implementation was restored afterwards and passes.
- fail `regression check: old admin-events.service.ts with the new pg lock-order test`: Done on purpose: with the old cancelEvent restored, the lapsed payment was already locked while cancel waited on a ticket. The new implementation was restored and passes.

## Contract changes
- events.yaml (description only): the Events tag, createEventReservation and TicketPaymentInfo now say 409 RESERVATION_EXPIRED (was 410) for a proof sent after the hold expired, with current = PaymentDetail.
- events.yaml (description only): the global lock-order rule now covers the H-3/H-1 reminder job (event FOR SHARE, then re-read) and says adminCancelEvent locks all active tickets, including lapsed holds, in one step before any payment.
- admin-events.yaml (validation documented): adminCreateEvent/adminUpdateEvent require checkin_closes_at <= ends_at (400 field_errors.checkin_closes_at). AdminEventCreateRequest.checkin_closes_at gets a description. No field or operation was added or removed.
- packages/contracts/CHANGELOG.md: three bullets added under C5 Events.

## Shared changes
- apps/api/test/core/jobs.e2e.test.ts (core-owned test, unchanged in this fix pass, carried over from the builder): JobsProbe deletes the real 'event.cancelled' topic handler from JobRegistry's private handlers map before registering its probe. The core owner should replace this with a public test hook such as JobRegistry.replaceTopicHandler, or a probe-only topic.

## Open issues
- Finding 8 (real, needs a payments-owned API): the discretionary admin refund (adminCancelTicket with refund=true) still uses PaymentLedger.lockPayment/refundedCents/recordRefund directly.
- Why: PaymentsKernel has no refund attributed to an admin. recordSystemRefund always writes created_by null, and PRD 2.3 requires a money decision to be attributed to the deciding admin. This slice is not allowed to edit payments files.
- Request to the payments owner: add an additive `PaymentsKernel.recordAdminRefund(tx, {paymentId, amount, dueAt, reason, adminId})` that also caps the amount at what remains, then switch admin-events.service.ts adminRefund to it and remove the duplicated cap.
- The exception is documented in the adminRefund docstring.
- Payments-owned follow-up from finding 3: payment-rules.ts selfCancelFullRefundUntil, used by fullRefundForCancelledTicket and fullRefundOnApprove, still uses a fixed 72 h. In events it is only reached by the self-cancel branch of TicketPaymentHandler.onApproved. That branch cannot currently be reached: self-cancel cancels a payment without proof, and awaiting_review tickets cannot be self-cancelled. It should still be aligned with event-rules.calendarDaysBefore(startsAt, days, event.timezone) by the payments owner.
- rejected (partly): finding 9 says the core test edit was 'not listed as a shared change' and could 'double-register without any sign'. Both claims are wrong. The edit was listed in the builder's shared_changes. If JobRegistry is refactored, `handlers.delete` throws a TypeError or registerTopicHandler throws 'sudah terdaftar', so it fails loudly. The part about ownership and depending on a private detail is valid; it stays listed in shared_changes for the core owner to resolve.
- Deadlock note, new with the finding 6 fix but similar to existing paths: the reminder transaction and existing events transactions (reservation, hold expiry) insert rows that reference users while holding the event lock, which takes FOR KEY SHARE on users. Account deletion (api-account) may hold users FOR UPDATE and then lock events. PostgreSQL would detect such a deadlock and abort one side; both are retried (scheduled job, outbox job). The integrator should confirm the users → events order in account deletion.
- Carried over from the builder: account deletion (api-account) writes tickets directly instead of going through TicketLedger; product readings from C5 (event browsing limited to active members, the schedule-change notification).

## Handoff notes
Module: kapdh-platform/apps/api/src/modules/events. Changes in this fix pass:

- event-rules.ts:
  - New export `calendarDaysBefore(startsAt, days, timezone)`: the same wall-clock time N calendar days earlier; for a gap it moves forward, for an overlap it takes the earliest instant.
  - `fullRefundUntil` signature is now `(event: {startsAt, timezone}, amount, days)`.
  - `memberRefundEligible` needs event.timezone.
  - `checkinWindow` caps closesAt at endsAt.
- admin-events.service.ts:
  - scheduleErrors rejects checkin_closes_at > ends_at.
  - cancelEvent locks all active tickets in one SELECT, then processes them in payment-id order; lapsed holds go through expireTicket and are not counted in tickets_cancelled.
- checkin.service.ts: the scanner-list SQL caps at ends_at.
- events-jobs.service.ts: sendReminders runs per event and per chunk of 500 holders in a transaction with the event locked FOR SHARE (remindChunk). Reminders are idempotent through dedup keys as before.
- Clients:
  - The admin event form should show the new field error on checkin_closes_at.
  - Flutter should map RESERVATION_EXPIRED on proof upload as HTTP 409.

New tests:
- test/events/access.e2e.test.ts: AC F15-1 matrix and PRD 2.2 suspended-member checks.
- test/events/checkin.e2e.test.ts: D5 override past the end of the event.
- test/events/jobs.e2e.test.ts: AC F13-6 change committed mid-run. It wraps the service's db in a Proxy because the PGlite db object is frozen.
- test/pg/events-module.pg.test.ts: PRD 6.4 cancel lock order.
- src/modules/events/event-rules.test.ts: H-3 in a DST zone, and the check-in window clamp.

No migrations were added and no payments files were edited.
