# Phase B handoff: contract C1-identity

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

## fix summary
I checked all 11 review findings against the PRD, ARCHITECTURE, the DB schema and the current auth code. Ten were real and are fixed. Finding 7 was partly wrong: the builder report did raise the shared change. Only contract YAML and the CHANGELOG changed; there are no API, DB or SDK-test edits.

1. **Admin TOTP enrollment window (medium): fixed.** The only enrollment credential is now the mfa_token returned when the admin accepts the invitation: audience kapdh-admin-enroll, valid 30 minutes, not renewable, and bound to the admin and the new password hash. adminLogin now returns 401 for `invited` admins (accepted or not) and for any admin without a verified TOTP, the same 401 as a wrong password. A Super Admin MFA reset is now a re-invitation: the TOTP row is deleted, sessions are revoked, the admin goes back to `invited` with a new time-boxed token and runs steps 2-5 again. This is written in the lifecycle header, adminLogin, accept, enroll, confirm and AdminLoginResponse.
2. **Unpaid refunds at deletion (medium): fixed.** AccountDeletionDisclosure has a new required `pending_refunds` list (AccountDeletionRefundWarning: adjustment, payment and ticket ids, event title, amount, due date, whether a destination account was given, created_at). It is included in `version`. requestAccountDeletion now says what the deletion job does: it never completes or cancels pending refunds on its own (PRD 4.4). The refund destination account is kept at most until the refund finishes or the job's last step (no later than estimated_completion_at), then deleted (D2).
3. **verifyOtp dead end after a lost response (medium): fixed.** The description now gives the recovery. If a retry gets 410 after an attempt whose outcome is unknown, the client calls login instead of resend; next=home means the account is already active. Similar notes were added for reset and the web deletion verify.
4. **refund_eligible ignored suspended members (low): fixed.** It is replaced by `refund_policy` (AccountDeletionRefundPolicy) with four values: full_refund, no_refund, case_by_case (owner suspended, D6) and payment_pending.
5. **Wrong admin MFA code returned 401 (low): fixed.** A wrong code is now 400 VALIDATION_ERROR with field_errors.totp_code or backup_code and the remaining attempts. 401 is kept only for token or admin-state problems. Marked as a breaking change in the CHANGELOG.
6. **Missing 403 for wrong audience (low): fixed.** 403 is declared on changePassword and getAccountDeletionDisclosure. The 403 descriptions on requestAccountDeletion, getAdminMe, adminRegenerateBackupCodes and adminChangePassword now list REAUTH_REQUIRED, MFA_REQUIRED and FORBIDDEN as they apply.
7. **X-Background-Request (low): partly rejected.** The builder report did list moving it to root.yaml as a proposal. I clarified the parameter description (the server honours it on every admin operation) and repeat the proposal below.
8. **Login vs email correction disagreed on the challenge (low): fixed.** signup and email_change now share one activation slot. Login returns whichever activation challenge is active; otherwise it cancels both and issues one new challenge with the purpose of the last activation challenge.
9. **No storage for reset_token and deletion_token (low): fixed by design, no new table.** Both are signed tokens valid at most 10 minutes, bound to the user, the consumed challenge and the account state. They can be used only once because using them changes that state under a row lock: reset does a conditional UPDATE on password_hash, and deletion moves the account from active to deletion_pending and raises session_version.
10. **Admin-initiated reset could not be continued (low): fixed.** The email carries the code and a link `kapdh://app/forgot/otp?challenge_id=<uuid>`. The code is still required, and resend returns the full challenge.
11. **Session paging keyed on last_seen_at (low): fixed.** Paging now uses created_at descending, then id, which never changes.

All checks were run after the last edit and passed.

## contract/shared changes
- Proposal, not made (finding 7): move `components.parameters.AdminBackgroundRequest` (header X-Background-Request, pattern ^1$) from admin-auth.yaml into root.yaml as `BackgroundRequest`. Admin GET operations that are polled in other domains (admin-dashboard counts, admin-payments queue, admin-notifications) should reference it (AC F02-5). AuthGuard already honours the header on every admin request.
- Requirement for C7 (admin-admins.yaml), not made: the Super Admin 'reset MFA' operation must be a re-invitation. In one transaction: delete the mfa_totp row, revoke all sessions and bump session_version, set status back to `invited`, set a new invite_token_hash and invite_expires_at, and email the /invite/<token> link. It needs MFA plus reauth (AC F16-1) and is still guarded by admins_guard_last_super_admin. The admin-auth contract relies on this, because login no longer opens TOTP enrollment.
- Requirement for the admin-members domain, not made: the admin-initiated alumni password reset (AC F16-4) must revoke the member's sessions, send a security notification, and issue a `password_reset` challenge to the verified email only. That email carries the code and the link `kapdh://app/forgot/otp?challenge_id=<uuid>` (outbox topic member.password_reset_initiated).
- Carried over from the builder: kapdh-platform/packages/contracts/dart/kapdh_api/test/models_test.dart (owned by contracts-infra) has the additive Session(...) edit from commit cecf799. Not changed in this fix.

## open issues
- rejected (partly): finding 7 'X-Background-Request was not raised as a root.yaml shared change' — the builder report's shared_changes did contain this proposal. I kept it, restated it in shared_changes, and clarified the parameter description: the server honours the header on all admin operations, and the declaration covers only GET /admin/me until it moves to root.
- Phase C, admin-auth module: auth.service.adminLogin currently gives totp_enrollment_required=true to `active` admins without a verified TOTP. It must return 401 for them and for `invited` admins, and always send totp_enrollment_required=false. adminAcceptInvitation must issue a separate enrollment token: audience kapdh-admin-enroll, valid 30 minutes, bound to the HMAC of the new password_hash. /totp/enroll and /totp/confirm accept only that token and reject it if the admin is not `invited`, invite_token_hash is set again, the user is not active, or the password binding no longer matches. adminVerifyMfa must return 400 VALIDATION_ERROR for a wrong TOTP or backup code; today it returns 401.
- Phase C, auth module: reset_token is a JWT (audience kapdh-password-reset, at most 10 min) with claims cid (the consumed challenge) and a password-hash binding. resetPassword locks the users row and does `UPDATE ... WHERE password_hash = <bound value> RETURNING`; zero rows means 410. Login for pending_otp, register, correction and resend must treat signup and email_change as one slot: supersede both purposes under the users row lock.
- Phase C, account module: deletion_token is a JWT (audience kapdh-web-deletion, at most 10 min) with claims cid and sv (session_version). confirmWebDeletion locks the user and makes a conditional active -> deletion_pending transition. The disclosure must compute pending_refunds (payment_adjustments kind=refund, status=pending, on payments owned by the user) and refund_policy, and both go into `version`. The deletion job must not complete or cancel pending refunds. It removes refund_destination when the refund finishes or at the job's final step, whichever is first, no later than estimated_completion_at.
- Carried over from the builder: apps/web/src/pages/delete-account.astro must switch to challenge -> POST /public/deletion/verify -> confirm {deletion_token, confirm, acknowledged_disclosure_version}. AdminProfile's optional fields should become required once admin-auth returns them. Login for deletion_pending and disabled accounts must not create a session. Fake non-enumerating challenges still need an implementation design. bootstrap-admin CLI must use the invitation flow, which is now required because login no longer allows enrollment. Cleanup of stale pending_otp accounts is not specified.

## handoff
OPERATIONS (METHOD path operationId access); the set is unchanged from the builder, 29 C1 operations:
POST /auth/register register {public, idempotent}
POST /auth/otp/verify verifyOtp {public} (signup and email_change only; X-App-Platform/X-App-Version headers; on 410 after an unknown outcome, call login)
POST /auth/otp/resend resendOtp {public}
POST /auth/email-correction correctPendingEmail {public}
POST /auth/login login {public} (pending_otp: returns the active activation challenge or reissues one slot)
POST /auth/refresh refreshSession {public; security [{}, adminRefreshCookie]}
POST /auth/logout logout {any, member_access any}
POST /auth/logout-all logoutAll {any, any}
GET /auth/sessions listSessions {any, any} (Cursor/Limit -> SessionPage; keyset created_at desc, id desc)
DELETE /auth/sessions/{sessionId} revokeSession {any, any}
POST /auth/password/forgot forgotPassword {public} -> 202 OtpChallenge
POST /auth/password/forgot/verify verifyPasswordResetOtp {public} -> PasswordResetGrant
POST /auth/password/reset resetPassword {public} -> 204
POST /auth/password/change changePassword {mobile, any} -> 204 (403 for an admin token)
POST /auth/reauth reauthenticate {any, any} -> ReauthResponse
POST /admin/auth/login adminLogin {public} -> AdminLoginResponse (totp_enrollment_required always false; only active admins with verified TOTP)
POST /admin/auth/mfa adminVerifyMfa {public} -> AdminSession + Set-Cookie (wrong code 400, bad token 401)
POST /admin/auth/invitations/preview adminPreviewInvitation {public} -> AdminInvitationPreview
POST /admin/auth/invitations/accept adminAcceptInvitation {public} -> AdminLoginResponse (enrollment token, 30 min, totp_enrollment_required true)
POST /admin/auth/totp/enroll adminStartTotpEnrollment {public; enrollment mfa_token in body} -> AdminTotpEnrollment
POST /admin/auth/totp/confirm adminConfirmTotpEnrollment {public} -> AdminTotpEnrollmentResult + Set-Cookie
GET /admin/me getAdminMe {admin} (X-Background-Request via the AdminBackgroundRequest parameter)
POST /admin/auth/backup-codes adminRegenerateBackupCodes {admin, reauth} -> AdminBackupCodes
POST /admin/auth/password/change adminChangePassword {admin} -> 204
GET /me/deletion/disclosure getAccountDeletionDisclosure {mobile, any} -> AccountDeletionDisclosure (403 for an admin token)
POST /me/deletion requestAccountDeletion {mobile, any, reauth, idempotent} -> 202 AccountDeletion
POST /public/deletion/challenge startWebDeletion {public} -> 202 OtpChallenge
POST /public/deletion/verify verifyWebDeletion {public} -> WebDeletionVerification
POST /public/deletion/confirm confirmWebDeletion {public, idempotent} -> 202 AccountDeletion

SCHEMA CHANGES IN THIS FIX:
- New: AccountDeletionRefundPolicy enum [full_refund, no_refund, case_by_case, payment_pending]; AccountDeletionRefundWarning {adjustment_id, payment_id, payment_type, ticket_id|null, event_title|null, amount Money, due_at|null, destination_provided, created_at}.
- AccountDeletionTicketWarning: `refund_eligible` replaced by `refund_policy` (required).
- AccountDeletionDisclosure: new required `pending_refunds` (maxItems 100), included in `version`.
- x-sensitive added to PasswordResetGrant.reset_token, ResetPasswordRequest.reset_token, WebDeletionVerification.deletion_token, WebDeletionConfirmRequest.deletion_token and AdminLoginResponse.mfa_token.
- Session.created_at documented as immutable; it is the sort key.

CONVENTIONS (in addition to the builder's):
- One activation slot: issuing a signup or email_change challenge cancels the active challenges of both purposes under the users row lock.
- One-time tokens derived from OTP (reset_token, deletion_token) are short-lived JWTs (aud kapdh-password-reset / kapdh-web-deletion) bound to cid plus account state. There is no token table; single use comes from an atomic state transition (ARCHITECTURE §2 rule 11).
- Admin token audiences: kapdh-admin-mfa (5 min, only for /admin/auth/mfa) and kapdh-admin-enroll (30 min, only for /admin/auth/totp/enroll and /confirm). They are not interchangeable, and both get 403 MFA_REQUIRED on the admin API.
- A wrong code or credential inside an established flow is 400 VALIDATION_ERROR with field_errors, now also at /admin/auth/mfa. 401 means the token or session is unusable.
- Calling with the wrong audience returns 403 FORBIDDEN, now declared on mobile-only and admin operations.
- Admin-initiated reset link: kapdh://app/forgot/otp?challenge_id=<uuid>; the code from the email is still required.

Files changed: kapdh-platform/packages/contracts/openapi/domains/{auth,admin-auth,account}.yaml and kapdh-platform/packages/contracts/CHANGELOG.md (new rows for POST /admin/auth/login and /admin/auth/mfa, both breaking, plus the 403 notes and the sessions ordering note).
