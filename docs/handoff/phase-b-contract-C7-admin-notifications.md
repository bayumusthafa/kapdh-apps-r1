# Phase B handoff: contract C7-admin-notifications

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

## fix summary
I checked all 8 review findings for C7 and confirmed each one was real. All 8 are fixed in the C7 domain files and CHANGELOG.md. I edited no other domain's file, root.yaml, or the database. The bundle now has 73 operations (previously 72) and 177 schemas.

1. **(high) Admin recovery.**
   - New operation `adminRecoverAdmin`, `POST /admin/admins/{adminId}/recovery`. Body `{reason}`; it needs If-Match, reauth and Idempotency-Key.
   - It applies to an admin who has been active, with status active or disabled. In one READ COMMITTED transaction it:
     - sets status back to `invited` with a new invitation token and bumps `permissions_version`;
     - deletes the `mfa_totp` row and replaces the password hash with a random one;
     - revokes all of the target's sessions, bumps `users.session_version` and disconnects sockets;
     - writes the audit entry `admin.recovery_initiated`;
     - sends the recovery invitation email and an `admin.security_notice` email through the outbox.
   - It rejects a Super Admin recovering themselves, an invited or never-active admin, the last Super Admin guard (23514 maps to 409), and a stale version.
   - This matches the C1 admin-auth contract, which describes "reset MFA by Super Admin = re-invitation".
   - The resend description now sends active admins to recovery. `PATCH status=active` is now only allowed when TOTP is still verified.
2. **(medium) Device token rebinding.** `registerDevice` now locks the `device_tokens` row. When the token moves to another account or session, it cancels the previous owner's pending deliveries in the same transaction, with `error_class token_reassigned`.
   - The worker sends a push only if, at claim time, the token is not revoked and `device_tokens.user_id = notifications.user_id`.
   - Admin retry checks the same ownership condition and has a new skip reason, `token_reassigned`. The `retryable` definition was updated to match.
   - `unregisterDevice` and logout cancel pending deliveries with `token_revoked`.
3. **(medium) Deep link shape.** I removed NotificationRoute, NotificationRouteName and NotificationRouteParams and restored `InboxNotification.deep_link` as a nullable string in `kapdh://app` form, with a pattern and the route catalog in its description.
   - `notifications.data.route` is stored as a path string, which matches ARCHITECTURE §4.7.
   - The REST response, the C6 realtime `notification.created` payload and the FCM data payload now use the same format. No change is needed from C6.
   - CHANGELOG: `GET /notifications` is no longer marked breaking.
4. **(medium) Audit export storage.** Export job state is now stored in the existing `audit_logs` (append-only) and `files` tables, so no new table is needed and the admin module is not blocked.
   - Audit entries `audit.export.requested`, `.completed` and `.failed` use entity_type `audit_export` with the export id as entity_id. The worker inserts the files row in the same transaction as the completed entry.
   - `AuditExport` documents how every field and status is derived. The worker takes an advisory lock per export, so it writes exactly one final entry.
   - Status is now processing|ready|failed|expired; I removed `queued` and `started_at`. I added the failure reason `timed_out`, using a suggested 1-hour configurable limit.
5. **(low) Background request header.** Added a local parameter `AdminDashboardBackgroundRequest` (`X-Background-Request`, pattern `^1$`, identical to C1's) on `adminGetDashboard` and `adminGetDashboardBadges`.
6. **(low) Dashboard payment counts.** `DashboardPayments` now matches C3's `AdminPaymentSummary`:
   - `overdue_count` covers both dues and tickets and uses C3's `review_due_at` rule (Monday to Friday, Asia/Jakarta).
   - New `overdue_by_type` replaces `escalated_ticket_count`; `awaiting_proof_count` is renamed `awaiting_transfer_count`.
   - Added `adjustments_pending_count` and `adjustments_overdue_count` (D6).
   - I removed `payments_awaiting_review` from `AdminNavBadges`. The gold pill's single source is now `GET /admin/payments/summary`.
7. **(low) Admin avatar.** Added `avatar_url` (nullable uri) to `AdminLinkedAlumni`, with a fallback to initials.
8. **(low) Missing 400.** `adminResendAdminInvitation` now declares 400 `ValidationError`, and its description covers a missing If-Match.

All checks in the verification list passed. I did not run test:pg or flutter analyze/test.

## contract/shared changes
- kapdh-platform/packages/contracts/CHANGELOG.md, 'Belum dirilis > C7' section: GET /notifications is no longer breaking (deep_link kept as the only deep-link format). The PUT /devices row notes that pending deliveries are cancelled when a token moves to another account. The new-operations list now includes adminRecoverAdmin, the dashboard and payment-summary alignment, X-Background-Request, and export state stored without a new table.
- Proposed but NOT made (root.yaml, integrator): move X-Background-Request to root as components.parameters.BackgroundRequest. Then replace C7's AdminDashboardBackgroundRequest and C1's AdminBackgroundRequest with it; both have the same name, location and schema.
- Proposed but NOT made (C6, events/notification.created.schema.json): nothing is required now, because C7 again uses the `deep_link` string that C6 mirrors. Optional: add the same pattern ^kapdh://app/[A-Za-z0-9/_.-]*$ and maxLength 320.
- Proposed but NOT made (C3 files.yaml / files module): GET /files/{fileId}/access must not serve files with purpose audit_export unless audit.read + audit.export pass and the caller is the requester or a super_admin. The primary download path is adminGetAuditExportAccess. (Carried over from the builder.)
- Optional, NOT made (schema owner): a dedicated app.audit_exports table. It is no longer required, because export state comes from audit_logs + files as documented in AuditExport. Moving to a table later would not change the contract.
- Proposed but NOT made (optional, root.yaml): a dedicated ErrorCode LAST_SUPER_ADMIN. The contract currently uses 409 VALIDATION_ERROR with field_errors. (Carried over from the builder.)

## open issues
- None of the 8 findings was rejected; all are fixed.
- AC F16-4 (Super Admin starts an alumni password reset) is not in C7's files and is expected in admin-members (C2). Please confirm it is covered there.
- Some values are server configuration with suggested defaults, not fixed by the PRD: invitation and recovery token lifetime (suggested 72 h), audit export time limit (suggested 1 h, leading to failed/timed_out), export file retention, the export row limit, and rate limits on invites, recovery, export creation and retries. Final values should come from D1/D8.
- Business days are Monday to Friday, Asia/Jakarta, following C3. No public-holiday calendar is defined anywhere; if one is wanted, the payments and dashboard counts must share it.
- A Super Admin who is locked out can only be recovered by another active Super Admin (PRD 8.2 requires at least two before go-live). If no other usable Super Admin exists, recovery must go through a server-side CLI, which is not part of the API contract. The ops runbook or integrator should record this.
- Schemas are deliberately duplicated so C7 does not $ref other domains: DashboardPaymentType equals PaymentType, DashboardEventStatus equals the events status enum, DashboardPaymentTypeCounts equals AdminPaymentTypeCounts, and AdminDashboardBackgroundRequest equals AdminBackgroundRequest. After merge the integrator may replace them with $ref.
- x-kapdh-access is still not validated by lint. A rule in scripts/lib/assemble.mjs would enforce it across all domains.

## handoff
> Note (15 October 2026, ADR-025): `reauth` no longer applies to adminInviteAdmin and adminUpdateAdmin, nor to
> adminDeleteAdmin (`DELETE /admin/admins/{adminId}`). adminResendAdminInvitation and adminRecoverAdmin keep it as
> credential actions, and adminUpdateAdmin still requires `X-Reauth-Token` when it changes the login `email`
> (conditional, parameter `ReauthTokenConditional`) (`docs/adr/025-reautentikasi-hanya-tindakan-kredensial.md`). The list is kept as the Phase B
> record.

OPERATIONS (METHOD path operationId access). New or changed by this fix are marked *.
Notifications (tag Notifications):
- GET /notifications listNotifications mobile/any -> NotificationPage {items: InboxNotification[], next_cursor, unread_count}
- GET /notifications/unread-count getNotificationUnreadCount mobile/any -> NotificationUnreadCount
- GET /notifications/{notificationId} getNotification mobile/any -> InboxNotification
- POST /notifications/read markNotificationsRead mobile/any -> MarkNotificationsReadResult
- GET /notifications/preferences getNotificationPreferences mobile/any -> NotificationPreferences
- PUT /notifications/preferences updateNotificationPreferences mobile/any -> NotificationPreferences
- PUT /devices registerDevice mobile/any -> 204 (*cancels the previous owner's pending deliveries on rebind)
- POST /devices/unregister unregisterDevice mobile/any -> 204
Admin Notifications:
- GET /admin/notifications/deliveries adminListNotificationDeliveries admin [notifications.manage]
- POST /admin/notifications/deliveries/retry adminRetryNotificationDeliveries admin [notifications.manage] idempotent (*skip reason token_reassigned)
- GET /admin/notifications/outbox adminListOutboxEvents admin [notifications.manage]
- POST /admin/notifications/outbox/retry adminRetryOutboxEvents admin [notifications.manage] idempotent
Admin Dashboard:
- GET /admin/dashboard adminGetDashboard admin (*header X-Background-Request) -> AdminDashboard
- GET /admin/dashboard/badges adminGetDashboardBadges admin (*header X-Background-Request) -> AdminNavBadges {reports_open?, failed_jobs?} (*payments_awaiting_review removed)
Admin Admins:
- GET /admin/admins adminListAdmins admin [admins.manage]
- POST /admin/admins adminInviteAdmin admin [admins.manage] reauth idempotent -> 201 AdminInvitationResult
- GET /admin/admins/candidates adminListAdminCandidates admin [admins.manage]
- GET /admin/admins/{adminId} adminGetAdmin admin [admins.manage]
- PATCH /admin/admins/{adminId} adminUpdateAdmin admin [admins.manage] reauth, If-Match (*status=active only when activated_at is set AND TOTP is verified)
- POST /admin/admins/{adminId}/invitation adminResendAdminInvitation admin [admins.manage] reauth idempotent, If-Match (*400 declared; for invited admins, including those under recovery, and never-active disabled admins)
- *POST /admin/admins/{adminId}/recovery adminRecoverAdmin admin [admins.manage] reauth idempotent, If-Match, body AdminRecoveryRequest {reason 3..500} -> 200 AdminRecoveryResult {admin: AdminAccountDetail, invitation_expires_at, invitation_sent_at, revoked_session_count}
- GET /admin/permissions adminListPermissions admin
Admin Audit:
- GET /admin/audit/entries adminSearchAudit admin [audit.read]
- GET /admin/audit/entries/{entryId} adminGetAuditEntry admin [audit.read]
- POST /admin/audit/exports adminCreateAuditExport admin [audit.read, audit.export] idempotent -> 202 AuditExport (status processing)
- GET /admin/audit/exports adminListAuditExports admin [audit.read, audit.export]
- GET /admin/audit/exports/{exportId} adminGetAuditExport admin [audit.read, audit.export]
- GET /admin/audit/exports/{exportId}/access adminGetAuditExportAccess admin [audit.read, audit.export]

SCHEMA CHANGES:
- Removed: NotificationRoute, NotificationRouteName, NotificationRouteParams.
- InboxNotification.deep_link: string|null, pattern ^kapdh://app/[A-Za-z0-9/_.-]*$, maxLength 320, required. notifications.data.route stores the path string; deep_link = 'kapdh://app' + path. The FCM data payload carries notification_id, category and deep_link.
- AdminDeliveryRetrySkipReason: [not_found, not_failed, token_revoked, token_reassigned, recipient_unavailable, preference_disabled].
- DashboardPayments: awaiting_review_count, awaiting_review_by_type, oldest_submitted_at, overdue_count (same as C3 AdminPaymentSummary.overdue_count, dues + tickets), overdue_by_type (DashboardPaymentTypeCounts), awaiting_transfer_count, adjustments_pending_count, adjustments_overdue_count, paid_total_amount, paid_count, recent_transactions. The implementation should share one summary query with the payments module.
- New parameter AdminDashboardBackgroundRequest: X-Background-Request header, pattern ^1$.
- AdminLinkedAlumni adds avatar_url (required, nullable uri).
- New schemas AdminRecoveryRequest and AdminRecoveryResult.
- AuditExportStatus: [processing, ready, failed, expired]. AuditExportFailureReason: [row_limit_exceeded, processing_failed, timed_out]. AuditExport drops started_at.

IMPLEMENTATION RULES:
- Recovery runs in one READ COMMITTED transaction:
  - Conditional UPDATE admins ... RETURNING (version = If-Match, status in active/disabled, activated_at not null, target != caller). Update admins before users.
  - Set status=invited with a new invite_token_hash and invite_expires_at; clear disabled_at; bump permissions_version and version.
  - DELETE mfa_totp for the admin's user_id; replace users.password_hash with a random hash.
  - Revoke all sessions, bump users.session_version, disconnect sockets.
  - Write audit admin.recovery_initiated, plus outbox for the invitation email and admin.security_notice.
  - 23514 admins_last_super_admin_chk maps to 409 VALIDATION_ERROR.
- Device rebind: SELECT device_tokens ... FOR UPDATE. If user_id or session_id changes, UPDATE pending notification_deliveries for that device_token_id to status=cancelled, error_class='token_reassigned', in the same transaction.
- Worker claim and admin retry for push: require device_tokens.revoked_at IS NULL AND device_tokens.user_id = notifications.user_id in the same statement.
- Audit export state uses no new table:
  - API transaction: audit 'audit.export.requested' (entity_type 'audit_export', entity_id = export uuid v7, after {filters}) plus outbox 'audit.export.requested' (dedup_key 'audit.export.requested:<id>', payload {export_id}).
  - Worker: in one transaction with the INSERT into files (purpose audit_export, owner_user_id = requester login user, private, ready, attached_at, expires_at), write audit 'audit.export.completed' (system, after {file_id, row_count}); on failure write 'audit.export.failed' (after {failure_reason}).
  - Worker takes pg_advisory_xact_lock on the export id, re-checks that no final entry exists and the deadline has not passed, then writes exactly one final entry.
  - Status precedence: completed (ready, or expired when the file is deleted/expired) > failed > past deadline (failed/timed_out) > processing.
  - file_name = audit-<YYYYMMDD of requested_at>-<first 8 hex of id>.csv.
- Audit actions now named in C7: admin.invited, admin.updated, admin.invitation_resent, admin.recovery_initiated, audit.export.requested, audit.export.completed, audit.export.failed, audit.export.downloaded, notification.delivery.retried, outbox.retried.
