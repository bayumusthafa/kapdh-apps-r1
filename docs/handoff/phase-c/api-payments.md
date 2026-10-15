# Phase C slice: api-payments

Final report after build, adversarial review (10 findings) and fixes (commit e9903b81c1f49be8cc89d5467f3046757654c00f).

## Summary
I fixed every real problem in the 10 review findings, which come down to 7 distinct issues since several were duplicates. Two findings were only partly right. All fixes are in one commit on the same branch (e9903b8, on top of the builder's 45ee9a6). The full verification passed.

What changed:
1. Refund bank accounts no longer appear in the adjustments list (findings 1 and 6). GET /admin/payment-adjustments used to send the member's refund account to any admin with payments.decide. List rows now always have `refund_destination: null` and keep `has_refund_destination`. The single-adjustment detail and the payment detail still show the account to deciding admins, as the contract allows.
2. One payment decision now creates exactly one notification (finding 7, AC F13-1). Approving a ticket payment whose ticket was already cancelled used to create two notifications, "Refund sedang diproses bendahara" and "Dana tiket diterima". It now creates one, titled "Dana tiket diterima, refund sedang diproses bendahara", and its body asks the member for their refund account. Refunds created by an admin or through the kernel still send their own notification.
3. A tampered pagination cursor now returns 400 VALIDATION_ERROR on the `cursor` field instead of 500 (finding 8). This covers the payments queue, adjustments, payment methods, and also the member's own payment history. Cursor timestamps must be valid, canonical dates, and payment-method sort_order must fit the database column.
4. `in_use` on a payment method now means "ever used by a payment" and never goes back to false (findings 3 and 9, AC F15-3). When a member switches method before sending proof, the old method's id is kept inside the payment's stored method snapshot as `previous_method_ids`. That method then cannot be deleted and its account details cannot be edited. No migration was needed, and the extra field is never sent to clients.
5. The core Idempotency-Key change is now limited to payment endpoints (findings 2 and 10). The builder's change made every endpoint ignore secret-named fields whose value is null. That now applies only to endpoints that declare a `storedBody` filter; all other endpoints behave exactly as on main.
   - The one visible side effect is documented in the contract and CHANGELOG: replaying "create refund adjustment" with the same key returns `refund_destination: null`, because the refund account is never stored for replay.
6. The AC F04-5 test now really simulates push failing (finding 4). It makes the member's push fail twice, then checks that the outbox event goes failed (attempt 1), failed (attempt 2), then dispatched (attempt 3) with the expected backoff. Throughout, the decision stays committed, there is one inbox notification, and one membership period.

I checked that the new tests catch the original bugs: the four tests for the list leak, double notification, cursors and in_use all fail against the builder's code and pass now.

## AC coverage
- [covered] AC F03-1: member-payments.e2e 'AC F03-1: ...' and Idempotency-Key replay test; pg lane: concurrent requests from one member create one payment
- [covered] AC F03-2: member-payments.e2e 'AC F03-2: bukti baru menaikkan proof_version...' and the stale-version 409 PROOF_VERSION_CONFLICT test
- [covered] AC F03-3: member-payments.e2e 'AC F03-3: ...'; admin-payments.e2e D13 in-place needs_fix test
- [covered] AC F03-4: member-payments.e2e 'AC F03-4: payment paid atau cancelled tidak dapat diganti buktinya...'
- [covered] AC F03-5: member-payments.e2e 'AC F03-5: perubahan biaya setelah payment dibuat tidak mengubah snapshot...'
- [covered] AC F04-1: admin-payments.e2e 'AC F04-1: approve menyimpan payment paid, payment_event, periode keanggotaan, audit dan notifikasi + outbox dalam satu transaksi'
- [covered] AC F04-2: admin-payments.e2e 'AC F04-2: alasan tolak kosong atau hanya spasi ditolak 400...'
- [covered] AC F04-3: admin-payments.e2e 'AC F04-3: ...'; pg lane: two admins approve concurrently, giving one 200, one 409 and one membership_event
- [covered] AC F04-4: admin-payments.e2e 'AC F04-4: ...'; pg lane covers both lock orderings
- [covered] AC F04-5: admin-payments.e2e 'AC F04-5: push/email sedang gagal → keputusan tetap committed, inbox tersedia, worker mengulang pengiriman tanpa memperpanjang dua kali'. FakePush.failNext is applied twice to the member's token through a notification.created delivery handler. The outbox event goes failed (attempts 1, then 2, nextAttemptAt = now + outboxBackoffMs) and then dispatched (attempts 3). The test also checks 3 push sends, 1 inbox row, 1 membership_event, unchanged expires_at and an idempotent replay. pg lane: concurrent replays with the same key.
- [covered] AC F13-1 (payment decision → one notification_id): ticket-payments.e2e 'AC F09-7, D6, F13-1: ... approve membuat refund sistem dengan satu notifikasi keputusan' checks exactly 1 new notification (category payment, route /payments/{id}, body asks for the refund account) and 1 outbox event. It failed on the old code with 2 notifications.
- [covered] AC F07-1 / F07-2 (payment side): admin-payments.e2e 'AC F07-1, F07-2: ...'
- [covered] AC F07-4: admin-payments.e2e 'AC F07-4: ...'
- [covered] AC F07-5 (renewal window eligibility): member-payments.e2e fees test and 'renewal sebelum jendela 400'
- [covered] PRD 2.2 suspended cannot create payments: member-payments.e2e 'PRD 2.2: anggota suspended ditolak 403 ACCOUNT_SUSPENDED...'
- [covered] PRD 2.3 conflict of interest: admin-payments.e2e 'PRD 2.3: ...'; adjustments.e2e conflict-of-interest 403
- [covered] AC F15-1: admin-payments.e2e and payment-methods.e2e refusal tests; access.e2e checks decorators against x-kapdh-access for all 26 operations (accessMismatches == [])
- [covered] AC F15-3 (payment methods: in_use, reauth, audit, old snapshots unchanged; reauth removed by ADR-025 on 15 October 2026): payment-methods.e2e 'AC F15-3: in_use = pernah dirujuk payment; metode yang ditinggalkan saat ganti rekening tetap in_use, identitasnya terkunci dan tidak dapat dihapus'. After the member switches A→B, A shows in_use true in detail and list; an identity edit returns 400 on field account_number; delete returns 400; deactivation is allowed; the stored snapshot has previous_method_ids [A]; the member response has no extra field. Unit tests in src/modules/payments/payment-rules.test.ts. Fails on the old code.
- [covered] AC F15-4: payment-methods.e2e 'AC F15-4: If-Match usang menghasilkan 409 VERSION_CONFLICT dengan current'
- [covered] D2 / D6 refund destination never in the adjustments list: adjustments.e2e 'D2: daftar tidak pernah memuat rekening tujuan refund, juga bagi pemegang payments.decide; detail tetap memuatnya'. It checks both sorts and the has_refund_destination filter; the body never contains the account number; the detail and AdminPaymentDetail still contain it for a deciding admin. Fails on the old code.
- [covered] PRD 7.3 / root Cursor: tampered cursor gives 400, not 500: admin-payments.e2e 'PRD 7.3: cursor yang dimanipulasi di antrean, penyesuaian, metode dan riwayat anggota → 400 VALIDATION_ERROR field cursor (bukan 500)'. It uses 8 tampered cursors (not-a-date, 31 Feb, null created_at, year 0, sort_order 1e12, created_at 1e15, year +275760) and confirms a real next_cursor still works. Fails on the old code with 500.
- [covered] AC F09-2 / F09-4 (payment side): ticket-payments.e2e tests for late proof (409 RESERVATION_EXPIRED) and rejected ticket proof (uses the test ticket handler until the events module exists)
- [partial] AC F09-7 (refunds): Payments side is tested: refund_on_approve, a system refund on approve with one decision notification, and an idempotent PaymentsKernel.recordSystemRefund. Refunds for tickets that were already paid when an event is cancelled must be created by the events module calling PaymentsKernel.recordSystemRefund.
- [covered] D4: member-payments.e2e fees test (50000+10000 registration lines, 10000 renewal line)
- [covered] D6: adjustments.e2e (7 tests incl. the new list test), ticket-payments.e2e D6 tests, JS/SQL business-day equality test
- [covered] D13: member-payments.e2e hidden-platform test; admin-payments.e2e 3 D13 record tests

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 tasks successful
- pass `pnpm typecheck`: 15/15 tasks successful (includes apps/api tsconfig.test.json)
- pass `pnpm lint`: 9/9 tasks; only the 2 known contracts warnings
- pass `pnpm test`: Second full run: 15/15 tasks green. API 475/475 (was 469), admin 143/143, database 23, config 23, storage 33, shared 16, web 5. In the first full run one apps/admin test (src/flow.test.tsx, login/TOTP flow) failed on a timing-sensitive element lookup under load. A standalone admin run then failed a different flow test the same way, and the next standalone run passed 143/143. This branch does not change apps/admin.
- pass `pnpm --filter @kapdh/api test:pg`: 71/71 in 11 files (includes the 5 payment concurrency scenarios)
- pass `pnpm contracts:lint`: Bundle valid with the 2 known warnings; events 17 schemas valid
- pass `PATH=/c/flutter/flutter/bin:$PATH pnpm contracts:test-dart`: Run because admin-payments.yaml descriptions changed: dart analyze found no issues and the dart fixture tests all passed
- pass `pnpm format:check`: All matched files use Prettier code style
- pass `Regression check: the new tests run against the builder's source files (git checkout 45ee9a6 -- the 7 payments source files)`: As intended, all 4 new tests failed on the old code (list leak, double notification, 500 on bad cursors, in_use false). The fixed sources were then restored, and the final commit has the same tree as the verified state.

## Contract changes
- packages/contracts/openapi/domains/admin-payments.yaml (owned by api-payments; descriptions only, no change to schema shape or operations): adminCreatePaymentAdjustment now says (a) a system refund created by approving a payment does not send a second notification, because the refund-account request is inside the single decision notification (AC F13-1); (b) replaying with the same Idempotency-Key returns `refund_destination` null (`has_refund_destination` stays true), because the refund account is never copied into idempotency storage (D2, ARCHITECTURE §2.3). The AdminPaymentMethod.in_use description now says it also covers methods a member switched away from before sending proof, and never returns to false.
- packages/contracts/CHANGELOG.md: new bullet under 'C3 Finance … Keputusan perilaku' recording the clarifications above and that the adjustments list never contains refund_destination.

## Shared changes
- apps/api/src/core/idempotency/idempotent.ts (owner: core-api; additive and compatible for existing callers). Versus main:
- `@Idempotent(options?)` accepts `{publicResponsePaths?: string[], storedBody?: (body) => unknown}` under metadata key IDEMPOTENT_OPTIONS_KEY, and IdempotencyInterceptor now injects Reflector.
- The exported `containsSecretKeys` signature changed from `(value, depth = 0)` to `(value, options: {publicPaths?, ignoreNullValues?} = {})`. In main its only caller is the interceptor.
- Fixer change: fields with secret-sounding names whose value is null are ignored ONLY on endpoints that declare `storedBody` (ignoreNullValues = storedBody !== undefined). Without options, the check behaves exactly as on main, so `@Idempotent()` in auth and the core probe are unchanged.
- Only payments endpoints use the options: member payment endpoints use publicResponsePaths, admin decision/cancel/record/adjustment endpoints use publicResponsePaths plus storedBody=redactRefundDestinations, and payment method create uses publicResponsePaths ['account_number'].
- Please add this to phase-b-core-api.md.
- apps/api/src/core/idempotency/idempotent.test.ts (new core unit test, 4 tests): without options a null secret field still counts; with ignoreNullValues only null values are ignored; publicPaths behaviour.
- apps/api/test/pg/payments-module.pg.test.ts (builder's file in the pg lane; not changed in this fix pass): the 5 PostgreSQL 17 payment concurrency scenarios.
- No migration added. The permanent in_use record is stored inside the existing payments.method_snapshot jsonb as `previous_method_ids`; no schema change.

## Open issues
- Partly rejected: findings 2 and 10 said the core idempotency change was not declared. The builder report I received already listed idempotent.ts and its test under shared_changes. The real parts of those findings are fixed: the global null rule is now limited to storedBody endpoints, and the replay redaction is documented in admin-payments.yaml and CHANGELOG.
- Rejected: finding 5 said handoff notes for PaymentsKernel were missing. The builder report I received had handoff_notes covering createPayment, cancelForTicket, recordSystemRefund, cancelUnprovenDues, summary, findPayment, the PaymentsJobsModule import and the ticket-handler expectations. They are repeated and updated in this report's handoff_notes. I did not add a docs/handoff file because those are written by the integrator ('docs:' commits on main).
- Events module: it must register the `ticket` payment handler following the contract; the expectations are in handoff_notes. Until then, payments tests use a test-only handler registered at bootstrap only when no `ticket` handler exists.
- Contract inconsistency (not changed; owned by events): events.yaml prose says 410 RESERVATION_EXPIRED for late proofs, while payments.yaml (the authoritative operation) and the implementation use 409.
- Core ordering: on submitPaymentProof, IDEMPOTENCY_CONFLICT is raised by the core interceptor before the handler runs, so a reused key with a different payload returns 409 even for a payment that does not exist (the contract lists 404 first).
- There is no public-holiday calendar, so the dues review deadline (1 business day) and refund deadline (7 business days) count Monday to Friday in Asia/Jakarta (also a C3/C7 open issue).
- The fees settings endpoints (/admin/settings/fees, payment-instructions) are in admin-settings.yaml, owned by api-admin, and are not implemented here.
- Flaky test outside this slice: apps/admin src/flow.test.tsx login and invitation flow tests sometimes fail to find an element under heavy machine load; they pass on rerun. apps/admin is unchanged in this branch.

## Handoff notes
All files are under kapdh-platform/apps/api/src/modules/payments.

PaymentsKernel (payments.kernel.ts):
- Provided and exported by PaymentsJobsModule, so worker modules can use it. Use it with `@Module({ imports: [PaymentsJobsModule] })` and inject `PaymentsKernel`.
- Every method takes a commit-aware tx (this.db.transaction, TxRunner or withTx) and checks it with assertCommitAware.
- Lock order is users → alumni → events → tickets → payments → payment_adjustments. The caller already holds the earlier locks; the kernel locks only the payment row, plus payment_methods FOR SHARE as a leaf lock.
- Other modules never write payments, payment_events or payment_adjustments directly.

Kernel methods:
- `createPayment(tx, {userId, type:'ticket', ticketId, amount, lines:[{code:'ticket', label?, amount}], paymentMethodId})` returns the PaymentRow.
  - Snapshot rules match dues: lines, method snapshot, settings_version null.
  - An inactive or missing method gives 400 VALIDATION_ERROR on field payment_method_id.
  - The amount must be a Money string greater than 0 and equal to the sum of the lines; free events have no payment (AC F09-3).
  - The caller holds the event then ticket locks; there is one payment per ticket (payments_ticket_id_key).
- `cancelForTicket(tx, ticketId, reason, {system?})` returns `{outcome: 'cancelled'|'kept_with_proof'|'unchanged'|'none', payment}`.
  - Only a pending payment without proof is cancelled, exactly once, with history and audit.
  - A pending payment that already has proof is kept and must still be decided by an admin.
  - It does not call the ticket handler and sends no payment notification; events notifies the member.
  - Pass `{system:true}` for hold expiry triggered by a member request.
- `recordSystemRefund(tx, {paymentId, amount, dueAt, reason})` returns the adjustment row or null.
  - Payment must be paid. Creates a refund adjustment with created_by null, capped at the remaining refundable amount; returns null when already fully refunded, so repeats are safe.
  - Writes audit and sends its own 'Refund sedang diproses bendahara' notification. Use it when an event is cancelled or a member self-cancels up to H-3 on a paid ticket, with dueAt = `refundDueAt(cancelledAt)` (7 business days).
- `cancelUnprovenDues(tx, userId, reason)` cancels the account's pending dues payments that have no proof, for account deletion. The caller holds the users then alumni locks. Returns the count.
- `summary()` returns the AdminPaymentSummary shape, from the same query as GET /admin/payments/summary (C7 DashboardPayments).
- `findPayment(id)` reads a payment without a lock.

Expected `ticket` handler (events module):
- lockRelated locks the event row, then the ticket row.
- onProofSubmitted moves awaiting_payment to awaiting_review. If the hold has passed, it expires the ticket, releases the seat, calls `cancelForTicket(tx, ticketId, 'Batas reservasi habis', {system:true})`, and throws AppException(409, 'RESERVATION_EXPIRED'). Payments commits that work and answers 409 with `current`.
- onApproved makes the ticket paid with a QR. For an already-cancelled ticket it changes nothing and returns `{refund}` when D6 requires one; use `fullRefundForCancelledTicket` and `refundDueAt` from payment-rules.ts so the admin `refund_on_approve` preview matches.
  - Payments records that refund without its own notification. The single approval notification ('Dana tiket diterima, refund sedang diproses bendahara') asks for the refund account (AC F13-1).
- onRejected and onCancelled cancel the ticket and release the hold, and do nothing for an already-cancelled ticket.

Other notes for integrators:
- payments.method_snapshot may contain `previous_method_ids`, which is internal (it backs the permanent in_use). Always read it through `readMethodSnapshot()` (payment-rules.ts), which returns only contract fields. Method changes must go through `PaymentLedger.changeMethod`.
- @Idempotent options: endpoints whose response includes `payment.method.account_number` (for example events createEventReservation returning TicketDetail) need `@Idempotent({ publicResponsePaths: ['payment.method.account_number', 'payment.lines.*.code'] })`. Without options, any field with a secret-sounding name, even null, prevents storing the result.
- PaymentsModule exports PaymentViews, which builds the contract DTOs; admin-members can reuse it for recent_payments.
- `PaymentViews.adminAdjustment(row, viewer, now, {listing:true})` never includes refund_destination.
- File access: payment_proof is open to the owner or payments.read; adjustment_evidence to payments.decide (core also allows payments.read). Admin-recorded proofs (D13) are owned by the admin's account, so members never see them.
- Notifications use category payment with route `/payments/{id}`. Dedup keys:
  - `payment.approved:<id>` (also carries the refund-account request when approval creates a refund)
  - `payment.rejected:<id>:v<proof_version>`
  - `payment.cancelled:<id>`
  - `payment.refund_requested:<adjId>` (admin and kernel refunds only)
  - `payment.adjustment_completed:<adjId>`
  - `payment.refund_cancelled:<adjId>`
- Audit actions:
  - payment.approved / rejected / cancelled / recorded / refund_destination_set
  - payment_adjustment.created / updated / completed / cancelled
  - payment_method.created / updated / deleted (stores only the last 4 digits of the account number)
- Admin web:
  - Use AdminPaymentDetail.actions (can_decide / can_cancel / can_adjust) and stage=awaiting_review for the 'Menunggu' tab.
  - The adjustments list shows only has_refund_destination; open the adjustment detail to see the account.
  - A tampered or stale cursor returns 400 VALIDATION_ERROR on field cursor; reload from the first page.

Tests:
- test/payments/*.e2e.test.ts (6 files plus support.ts)
- src/modules/payments/payment-rules.test.ts
- src/core/idempotency/idempotent.test.ts
- test/pg/payments-module.pg.test.ts
