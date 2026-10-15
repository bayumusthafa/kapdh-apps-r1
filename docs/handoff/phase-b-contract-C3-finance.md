# Phase B handoff: contract C3-finance

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

## fix summary
I checked all 11 review findings against the PRD, ARCHITECTURE and the DB schema. All 11 are real and none were rejected. Each was fixed in payments.yaml, admin-payments.yaml or admin-settings.yaml; three of them also need changes in files I don't own, listed under shared_changes. The bundle now has 73 operations, 33 of them in C3; every C3 operation has x-kapdh-access. Every check in the task's verification list passed. Commit is 6519ea6.

What changed, by finding:
1. **Ticket payment with proof whose ticket was already cancelled (high).** adminDecidePayment now says such a payment must still be decided. Approve means the money arrived: the payment becomes paid, the ticket stays cancelled and no QR is issued. When D6 requires a full refund (event cancelled, or the member cancelled up to H-3), a system refund adjustment is created in the same transaction: created_by null, full amount, due in 7 working days. Reject means the money was not found. "Event cancelled" was removed as a reason for PAYMENT_STATE_CONFLICT. The adjustments and getMyPayment descriptions now point to this path.
2. **Admin cancel (medium).** adminCancelPayment and can_cancel are now limited to pending payments with proof_version 0. Rejected payments can no longer be cancelled, matching PRD 4.3 and ARCHITECTURE §3.3.
3. **Adjustment cancel reason (medium).** AdminPaymentAdjustment now carries cancel_reason and a new cancelled_by, documented as columns on payment_adjustments and never read from audit_logs. The DB migration is required and listed as a shared change.
4. **iOS backup plan, D13 (medium).** New POST /admin/payments (adminRecordPayment): one transaction creates a registration/renewal payment from the current fees snapshot, attaches the admin's proof as version 1 and approves it. It needs payments.decide, an Idempotency-Key and the conflict-of-interest check; it returns 409 with `current` when an open payment exists. New PUT /admin/settings/payment-instructions sets which platforms hide dues instructions, and GET /admin/settings includes it. The calling platform comes from X-App-Platform. Members see a required `instructions_hidden` flag on MyFeeQuotes and PaymentDetail. Creating, changing the method of, or submitting proof for a dues payment from a hidden platform returns 403 FORBIDDEN. Tickets are not affected.
5. **Ticket review deadline (medium).** For tickets, review_due_at is now the earlier of submitted_at + 2 working days and the event's check-in opening. AdminPaymentItem gains event_starts_at, and AdminPaymentSort gains review_due_at_asc.
6. **Editing a method already in use (low).** Changing kind, provider, account_number or account_holder of an in-use method is refused with 400; the admin must deactivate it and create a new one. Edits and payment creation lock the method row so no new payment copies stale details.
7. **Deleting a method in use (low).** Now 400 VALIDATION_ERROR instead of 409.
8. **Admin method list (low).** Now paged with Cursor/Limit, returning AdminPaymentMethodPage {items, next_cursor, total}.
9. **Proof submission error order (low).** The order is now explicit. 410 RESERVATION_EXPIRED takes precedence over 409 PAYMENT_STATE_CONFLICT, including when the system already cancelled the payment because the hold expired.
10. **adjustment_evidence file purpose (low).** files.yaml belongs to core-api in this run, so I couldn't add it. It is recorded as a required shared change and a merge gate.
11. **Default queue view (low).** adminListPayments now maps the UI filters: Menunggu = stage=awaiting_review, so the total matches the menu badge; Disetujui = status=paid; Ditolak = status=rejected; Semua = no status or stage filter.

The CHANGELOG is updated under "Belum dirilis". Outside my three files I made two small edits needed to keep checks green: the admin mock and two Dart test fixtures.

## contract/shared changes
- kapdh-platform/apps/admin/src/api/mock.ts (admin-foundation / admin payments page agent): added `event_starts_at: null` to the mock AdminPaymentDetail so it typechecks against the new required field.
- kapdh-platform/packages/contracts/dart/kapdh_api/test/api_test.dart and models_test.dart (contracts-infra / integrator): payment fixtures now include the new required `instructions_hidden: false` on PaymentDetail.
- REQUIRED, not made (schema owner): additive migration on packages/database payments.ts paymentAdjustments, adding `cancel_reason text`, `cancelled_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL` with a partial index, and extending CHECK payment_adjustments_cancelled_chk to `status <> 'cancelled' or (cancelled_at is not null and cancel_reason is not null and btrim(cancel_reason) <> '')`. Without it the contract fields cancel_reason and cancelled_by cannot be stored. They must never be read back from audit_logs.
- REQUIRED, not made (schema owner and integrator): new app_settings key `payment_instructions`. Add it to APP_SETTING_KEYS in packages/database/src/schema/settings.ts, seed `{dues_hidden_platforms: []}` in seeds/reference.ts, add the zod type in core/settings/keys.ts, and add a row to ARCHITECTURE §5.4.
- REQUIRED before or together with the C3 merge (files.yaml owner, core-api): add `adjustment_evidence` to FilePurpose (admin upload, private, readable with payments.read; the DB FILE_PURPOSES already has it). Allow admin uploads with purpose `payment_proof` for adminRecordPayment. Let payments.read admins open payment_proof files, including older proof versions referenced from payment_events, and adjustment_evidence files.
- Suggested, not made (public.yaml owner, C2): expose `payment_instructions.dues_hidden_platforms` in PublicConfig so the app can apply the D13 hiding at splash. The C3 contract already carries `instructions_hidden` on MyFeeQuotes and PaymentDetail, so this is optional.
- Suggested, not made (integrator): ARCHITECTURE §4.6 PaymentTypeHandler.onApproved should allow the ticket handler to report a refund obligation (or the payments module derives it), so that approving a payment whose ticket is already cancelled creates the D6 system refund in the same transaction.

## open issues
- MERGE GATE: files.yaml must add the adjustment_evidence purpose and admin payment_proof uploads (shared_changes). Until then, adminCompletePaymentAdjustment (refund evidence) and adminRecordPayment (proof) cannot be used end to end. If the order cannot be guaranteed, the integrator should add this gate to BUILD_PLAN.
- BLOCKER for the payments API module: the payment_adjustments cancel_reason / cancelled_by_admin_id migration and the new app_settings key payment_instructions must land before implementation (shared_changes).
- Events domain (C5) must:
- (1) when the event is cancelled or the member self-cancels, leave a pending payment that already has proof untouched (do not cancel it);
- (2) make the ticket handler's onApproved a no-op for a cancelled ticket (no QR, no reactivation) and report the D6 refund obligation (event cancelled, or self-cancel up to H-3, means full refund due 7 working days after the ticket cancellation);
- (3) make onRejected a no-op for an already-cancelled ticket;
- (4) on hold expiry, cancel the payment with actor system and reason 'batas reservasi habis', exactly once;
- (5) throw RESERVATION_EXPIRED from onProofSubmitted, which payments maps to HTTP 410.
- Product-owner decision still open: a rejected registration/renewal payment can only go back to pending through the owner (PRD 4.3). With the iOS fallback active, an iOS-only member who has a rejected dues payment blocks adminRecordPayment (409 with current). Allowing an admin to abandon or settle it would need a PRD 4.3 / ARCHITECTURE §3.3 change.
- Product owner should confirm the 1-working-day dues review threshold: it comes from prototype screen_8 and the PRD 1.6 proposal. Tickets use the earlier of 2 working days (D5) and check-in opening.
- Admin PaymentsPage (admin payments page agent) still defaults to status=pending and gates the decide button on status. It should send stage=awaiting_review for 'Menunggu' and use AdminPaymentDetail.actions.can_decide / can_cancel.
- No findings were rejected; all 11 were confirmed and fixed. #10 is fixed by recording the files.yaml change as a merge gate, because files.yaml is outside this fixer's ownership.

## handoff
> Note (15 October 2026, ADR-025): the `reauth` marker below no longer applies to adminCreatePaymentMethod,
> adminUpdatePaymentMethod, adminDeletePaymentMethod and the six `PUT /admin/settings/*` operations. The product owner
> limited step-up re-auth to credential actions (`docs/adr/025-reautentikasi-hanya-tindakan-kredensial.md`,
> `packages/contracts/CHANGELOG.md`). Permissions, If-Match, Idempotency-Key and audit are unchanged. The list is kept
> as the Phase B record.

OPERATIONS (METHOD path operationId access)
- GET /payment-methods listPaymentMethods mobile/nonsuspended
- GET /me/fees getMyFees mobile/nonsuspended (MyFeeQuotes now requires instructions_hidden)
- GET /me/payments listMyPayments mobile/any
- POST /me/payments createPaymentInstruction mobile/nonsuspended idem (201 new | 200 existing open; 403 FORBIDDEN when the X-App-Platform is in payment_instructions.dues_hidden_platforms)
- GET /me/payments/{paymentId} getMyPayment mobile/any (PaymentDetail requires instructions_hidden: true only for registration/renewal on a hidden platform)
- PUT /me/payments/{paymentId}/method changeMyPaymentMethod mobile/nonsuspended (If-Match; 403 ACCOUNT_SUSPENDED or FORBIDDEN on hidden platform for dues)
- PUT /me/payments/{paymentId}/proof submitPaymentProof mobile/nonsuspended idem. Error order after global checks: 404 -> 409 IDEMPOTENCY_CONFLICT -> 403 FORBIDDEN (hidden platform, dues) -> 410 RESERVATION_EXPIRED (ticket expired or hold passed, even if the system already cancelled the payment) -> 409 PAYMENT_STATE_CONFLICT (paid, cancelled by owner/admin/event, ticket rejected, ticket cancelled) -> 409 PROOF_VERSION_CONFLICT -> 422 FILE_INVALID.
- POST /me/payments/{paymentId}/cancel cancelMyPayment mobile/nonsuspended idem (If-Match)
- GET /admin/payments adminListPayments admin[payments.read]. UI mapping: Menunggu = stage=awaiting_review (total == summary.awaiting_review_count), Disetujui = status=paid, Ditolak = status=rejected, Semua = no status and no stage. sort adds review_due_at_asc.
- POST /admin/payments adminRecordPayment admin[payments.read,payments.decide] idem. Body AdminRecordPaymentRequest{user_id, type: MembershipPaymentType, payment_method_id (active or inactive), proof_file_id (payment_proof uploaded by the calling admin), transfer_note?, funds_verified (must be true), reason}. 201 AdminPaymentDetail. One tx: create from current fees, then proof v1, then paid, then membership handler, audit, notification and outbox. 400 field_errors user_id/type/payment_method_id; 403 conflict of interest; 409 PAYMENT_STATE_CONFLICT (already registered, or open payment of the same type with current=AdminPaymentDetail); 422 FILE_INVALID.
- GET /admin/payments/summary adminGetPaymentSummary admin[payments.read]
- GET /admin/payments/{paymentId} adminGetPayment admin[payments.read]
- POST /admin/payments/{paymentId}/decision adminDecidePayment admin[payments.read,payments.decide] idem. A cancelled ticket (event cancelled or self-cancel) can still be decided: approve = paid with no QR and no reactivation, plus a system refund adjustment (created_by null, full amount, due 7 working days after the ticket cancellation) when D6 requires one; reject = funds not found. 409 order: PAYMENT_STATE_CONFLICT (not pending or no proof), PROOF_VERSION_CONFLICT, VERSION_CONFLICT.
- POST /admin/payments/{paymentId}/cancel adminCancelPayment admin[payments.read,payments.decide] idem (If-Match; ONLY pending with proof_version 0; rejected is never cancellable)
- POST /admin/payments/{paymentId}/adjustments adminCreatePaymentAdjustment admin[payments.read,payments.decide] idem (paid only)
- GET /admin/payment-adjustments adminListPaymentAdjustments admin[payments.read]
- GET /admin/payment-adjustments/{adjustmentId} adminGetPaymentAdjustment admin[payments.read]
- PATCH /admin/payment-adjustments/{adjustmentId} adminUpdatePaymentAdjustment admin[payments.read,payments.decide] (If-Match)
- POST /admin/payment-adjustments/{adjustmentId}/complete adminCompletePaymentAdjustment admin[payments.read,payments.decide] idem (If-Match)
- POST /admin/payment-adjustments/{adjustmentId}/cancel adminCancelPaymentAdjustment admin[payments.read,payments.decide] idem (If-Match; stores cancel_reason and cancelled_by in the adjustment columns, never read from audit_logs)
- GET /admin/payment-methods adminListPaymentMethods admin[settings.manage] (active filter, Cursor, Limit; returns AdminPaymentMethodPage {items, next_cursor, total}; order sort_order, provider, id)
- POST /admin/payment-methods adminCreatePaymentMethod admin[settings.manage] reauth idem
- GET /admin/payment-methods/{methodId} adminGetPaymentMethod admin[settings.manage]
- PUT /admin/payment-methods/{methodId} adminUpdatePaymentMethod admin[settings.manage] reauth (If-Match; when in_use, kind/provider/account_number/account_holder must be unchanged or 400 VALIDATION_ERROR; method row locked FOR UPDATE, while payment creation and method changes lock it FOR SHARE)
- DELETE /admin/payment-methods/{methodId} adminDeletePaymentMethod admin[settings.manage] reauth (If-Match; 204; 400 VALIDATION_ERROR field_errors._ when in_use; 409 only VERSION_CONFLICT)
- GET /admin/settings adminGetAppSettings admin[settings.manage] (AdminAppSettings now requires payment_instructions)
- GET /admin/settings/fees adminGetFees admin[settings.manage]
- PUT /admin/settings/fees adminUpdateFees admin[settings.manage] reauth (If-Match)
- PUT /admin/settings/min-app-version adminUpdateMinAppVersion admin[settings.manage] reauth (If-Match)
- PUT /admin/settings/maintenance adminUpdateMaintenance admin[settings.manage] reauth (If-Match)
- PUT /admin/settings/store-links adminUpdateStoreLinks admin[settings.manage] reauth (If-Match)
- PUT /admin/settings/payment-instructions adminUpdatePaymentInstructions admin[settings.manage] reauth (If-Match; body AdminPaymentInstructionsInput{dues_hidden_platforms: DevicePlatform[] (max 2, unique), reason?}; returns AdminPaymentInstructionsSetting)
- PUT /admin/settings/support adminUpdateSupportContact admin[settings.manage] reauth (If-Match)

NEW OR CHANGED SCHEMAS
- AdminRecordPaymentRequest
- AdminPaymentMethodPage (replaces AdminPaymentMethodList)
- AdminPaymentInstructionsSetting / AdminPaymentInstructionsInput (app_settings key `payment_instructions` = {dues_hidden_platforms: ("android"|"ios")[]}; DevicePlatform comes from root)
- AdminPaymentItem: + event_starts_at (required, nullable). review_due_at for tickets = min(submitted_at + events.review_escalation_business_days business days, coalesce(events.checkin_opens_at, starts_at - events.checkin_before_hours)); for dues = submitted_at + 1 business day (Mon-Fri, Asia/Jakarta).
- AdminPaymentSort: + review_due_at_asc
- AdminPaymentAdjustment: + cancelled_by (AdminPaymentActorRef or null, required)
- PaymentDetail: + instructions_hidden (required); MyFeeQuotes: + instructions_hidden (required)
- AdminPaymentActions.can_cancel = pending with proof_version 0 only
All other schemas are as in the builder handoff.

CONVENTIONS
- The D13 hiding is computed per request from the X-App-Platform header; it is not a security boundary. Older app builds are forced to update via min_app_version.
- Tickets are never hidden.
- The created event of an admin-recorded payment stores the admin's verification note in payment_events.reason. It is shown in admin history and audit only and must be stripped from the member PaymentEvent.
