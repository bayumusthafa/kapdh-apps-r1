# Phase B handoff: contract C2-membership

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

The builder report attached to the first review (49d8c40) is stale. It says the apps/api files were not edited and that test/typecheck/build fail; since 79ec626 the GET /me controller, PUBLIC_CONFIG and public controller ARE adapted in the repo and the branch is green. Do not apply `scratchpad/c2-legacy-api-integration.patch`; follow the merge guidance under "contract/shared changes" below.

## fix summary (round 2: post-merge review of 79ec626)
Seven findings checked; six were contract defects and are fixed in the C2 domain files, one (the stale builder report) is fixed by this document. Verification after the fix: contracts:lint, contracts:gen, contracts:test-dart, @kapdh/contracts tests (39/39), pnpm build, typecheck+lint (21/21), pnpm test (13/13 tasks, API 89/89) and format:check pass.

1. verifyKta could answer `active` for an expired token (medium). public.yaml now gives an ordered evaluation, first match wins:
   1. malformed token, unknown `kid`, wrong signature/iss/aud → `invalid_token`, without reading member data;
   2. `sub` account gone or deleted → `not_found` (even when exp has passed; no identity);
   3. binding fails (request number is not the current number of `sub`, or `seq` ≠ N) → `invalid_token`;
   4. exp passed → never `active`, `expiring` false; `expired` only if exp < iat + 7 days (token clamped by membership expiry) AND the current effective_status is expired; every other case → `invalid_token` (renewed member, plain 7-day token, now suspended/disabled/etc.);
   5. exp not passed → verified → active; expiring → active + expiring true; expired → expired; unverified/suspended/disabled/deletion_pending → inactive.
   Identity (`member`) for `expired` from step 4 only while exp is at most 30 days before checked_at; older tokens still answer `expired` with member null.
2. Admin reset deep link disagreed with C1 (medium). The only form now is `kapdh://app/forgot/otp?challenge_id=<challenge_id>` (ARCHITECTURE §4.7 external form, same as auth.yaml forgotPassword, parameter name = PasswordResetVerifyRequest.challenge_id). The `${PUBLIC_WEB_URL}/app/forgot/otp?challenge=` form is removed, so nobody needs App Links/Universal Links files or a web fallback route in R1.0. The description now names POST /auth/password/forgot/verify (verifyPasswordResetOtp) and POST /auth/otp/resend with challenge_id.
3. Member-page suspend/unsuspend vs moderation (low).
   - Permissions are now `[members.read, moderation.read, moderation.resolve]` on both, the same rule as adminResolveReport (PRD 2.3), so the actor can always read back the internal reason.
   - adminUnsuspendMember's single transaction now closes every open/in_review `appeal` report of the member as granted (status resolved, action unsuspend, resolution_note citing the member-page unsuspend and reason, resolved_by_admin_id = actor, resolved_at, version bump, audit `moderation.report_resolved` per appeal), as admin-moderation.yaml requires for "jalur unsuspend lain".
   - New optional `AdminMemberUnsuspendRequest.member_message` (3..500): used in the member notification and as the closed appeals' `decision_message`; default text "Pembatasan akun Anda telah dicabut pengurus". One notification only, no per-appeal duplicates.
   - Suspend wording aligned with moderation: after commit `session.revoked` (reason account_suspended, all_sessions true) and socket disconnect.
4. recent_tickets leaked ticket payment info (low). `AdminMemberDetail.recent_tickets` is now `[array, null]`, null unless the caller has events.manage or payments.read (events.checkin alone is not enough). Applies to every AdminMemberDetail response and to `current` in 409s.
5. verifyKta per-number rate limit could be exhausted with garbage tokens (low). Limits are now per IP (all requests), per token hash (SHA-256, all requests) and per member number ONLY for requests that pass signature/iss/aud (step 1). 429 carries retry_after_seconds and clients show "Tidak dapat memverifikasi" with retry.
6. Period kind vocabulary mismatch (low). `MembershipPeriodKind` is now `[activation, renewal]` (was `[registration, renewal]`), matching membership_events.kind and AdminMembershipEventKind. Breaking for GET /me/membership (no server implementation yet); recorded in CHANGELOG.
7. Stale builder report (low). Fixed by the note at the top of this file and the accurate report of this round. The scratchpad patch must not be re-applied.

## fix summary (round 1, commit 79ec626)
I checked all 8 review findings for C2 Membership. Seven were real and are fixed. The low-severity maintenance finding was partly real: I fixed the wording but did not declare a 503 response (reason in open_issues). Everything is committed in 79ec626 on top of 49d8c40, and the branch is green: build, typecheck, lint, all tests and format checks pass, with API tests at 89 of 89.

1. Red branch (high). I put the API adaptation into the repo instead of leaving it as a scratchpad patch.
   - GET /me (apps/api/src/me/me.controller.ts) now returns the new contract shape from real data: account_status, cohort_code, starts_at, renewal_eligible and renewal_opens_at, a profession and skills with historical labels, and registration/renewal payment pointers with their stage (awaiting_proof, awaiting_review or rejected).
   - avatar_url is still null in this interim controller because it has no storage driver yet.
   - GET /public/config now gets server_time from the injected CLOCK inside PublicController, not from `new Date()`. app.module.ts adds store_links and legal.
   - I confirmed the GET /me data against the contract with a temporary test (TestClock, profession, skills, payment stage changes, renewal window), then deleted it.
2. Admin password reset could not be completed (medium). The email now carries the OTP code and an app link (round 2 made `kapdh://app/forgot/otp?challenge_id=<challenge_id>` the only form; the https form described in round 1 is gone). The member enters the code without going through "Lupa sandi" again, so the admin's challenge is not replaced. The code is never in a URL. Resend or forgot-password still work as fallbacks.
3. Moderation data shown without moderation.read (medium). Without moderation.read:
   - suspension.reason and the reason on suspend/unsuspend events are null, with a new required flag reason_redacted set to true;
   - warn events are left out of the history list and its total, and filtering by kind=warn returns 403;
   - the same filtering applies to 200 responses and to `current` in 409 replies.
4. verifyKta and maintenance (low). The description now says core-api exempts POST /public/kta/verify by its exact path, so it never returns 503 MAINTENANCE.
5. Optional fields that must always be sent (low). MemberCard.cohort and graduation_year are now required, and so are KtaVerification.expiring and member. I updated the Dart fixture and the apps/web test fixture to match.
6. adminListMasters open to any admin (low). It now requires either members.read or master.manage, using a new x-kapdh-access key, permissions_any.
7. Social links (low). A new SocialHandle schema (a username or an https URL; javascript:, data:, http: and similar are rejected) now covers all four social fields in ProfileUpdate and AdminMemberUpdate. I tested the pattern against 16 good and bad values.
8. CHANGELOG phone entry (low). It now says phone already existed and was tightened (nullable, maxLength 24, new pattern), marked as a breaking change. I also fixed a table row that a "|" character had split.

I also added outbox_oldest_pending_seconds to HealthReadinessChecks and copied core-api's wording into public.yaml, so the merge with core-api's edit of that file conflicts less.

## contract/shared changes
- apps/api (owned by core-api; edited only so this branch stays green): apps/api/src/me/me.controller.ts, apps/api/src/app.module.ts (PUBLIC_CONFIG typed StaticPublicConfig with store_links and legal added), apps/api/src/public/public.controller.ts (merges server_time from the injected CLOCK), apps/api/src/public/public.tokens.ts (adds type StaticPublicConfig). How to resolve the merge with core-api (dde295a): take core-api's app.module.ts and its settings-backed modules/public/public.controller.ts, which already return store_links, legal and server_time from the Clock; accept core-api's deletion of src/public/*. Copy the new GET /me fields from src/me/me.controller.ts into core-api's modules/membership/me.controller.ts: account_status, cohort_code, starts_at, renewal_eligible and renewal_opens_at (via renewalOpensAt), registration_payment and renewal_payment via toMembershipPayment, profile phone, bio, last_education_*, social_*, profession and skills (joins), avatar_url and privacy.show_email. Then remove pending_payment_id.
- apps/web/src/scripts/kta-verify.test.ts (owned by public-web): fixture now includes expiring: false and member: null because KtaVerification requires them.
- packages/contracts/dart/kapdh_api/test/models_test.dart (owned by contracts-infra): the MemberCard fixture adds 'cohort': 29 and 'graduation_year': 2025 plus one assertion. The hunk is about 100 lines away from C1's change to the same file, so it should merge without conflict.
- packages/contracts/openapi/domains/public.yaml is also edited by core-api (dde295a). I copied core-api's readiness wording and outbox_oldest_pending_seconds exactly. The remaining conflicts are expected: keep my version, which adds x-kapdh-access lines, removes /public/pages and adds verifyKta.
- C1 (auth.yaml) dependency: resolved on main. forgotPassword already says the member redeems the emailed challenge_id with POST /auth/password/forgot/verify; C2 now uses exactly C1's link form.
- Mobile/ARCHITECTURE §8.4: the /forgot/otp route must accept the query parameter `challenge_id` (from the email link `kapdh://app/forgot/otp?challenge_id=<uuid>`) and open the OTP screen bound to that challenge without calling POST /auth/password/forgot. Notification/email templates owner: the admin reset email (outbox topic member.password_reset_initiated / sync OTP mail) must contain the code and this one link; no https/App Links variant in R1.0.
- Moderation (C6) consistency, no edit to C6 files needed: adminUnsuspendMember performs the appeal auto-close that admin-moderation.yaml requires; the implementer of both paths should share one helper (close active appeals as granted) inside MembershipKernel/moderation so the two paths cannot diverge.
- ARCHITECTURE §4.3 wording suggestion (not made): change '/public/** reads' to '/public/** reads (GET, plus POST /public/kta/verify)' to match core-api's maintenanceAllowed.
- x-kapdh-access vocabulary now: audience, member_access, permissions (all required), permissions_any (at least one; new), role (super_admin), reauth, idempotent. core-api has no any-of decorator: add @RequireAnyPermission(...) or check in the handler for adminListMasters. A future contracts lint rule should allow these keys.

## open issues
- Architect: verifyKta deviates from the literal ARCHITECTURE §3.2 sentence "Public verify checks signature, iss/aud/exp". exp is still checked and a passed exp never yields active, but two outcomes are reachable after exp: `not_found` for a deleted account (AC F06-2 "termasuk setelah penghapusan akun") and `expired` for a membership-clamped token of a currently expired member (otherwise AC F06-2 "Kedaluwarsa" could never be shown for a scanned QR, because exp ≤ expires_at). Suggested §3.2 wording: "a passed exp never yields active; a token clamped by membership expiry yields expired only while the member is currently expired; otherwise invalid".
- Product owner to confirm: the 30-day bound after which an expired token still answers `expired` but without identity (`member` null). Chosen to stop old captured QR images from disclosing the name indefinitely; not a PRD value.
- The apps/web verify script treats every non-OK response (including 429) as unreachable and shows "Tidak dapat memverifikasi"; that matches the contract. If public-web wants a countdown, it can read retry_after_seconds.
- Partly rejected (round 1): finding 4 (verifyKta should declare 503 MAINTENANCE). The contradiction is real and I fixed it in the description. I did not add a 503 response, because core-api's RequestGate (dde295a, core/http/request-gate.ts maintenanceAllowed) already exempts POST /public/kta/verify by its exact path, so the server never returns 503 MAINTENANCE there. Declaring it would mislead generated clients; any 5xx from a proxy falls to the default response, which the site shows as 'Tidak dapat memverifikasi' (AC F06-4).
- The interim legacy GET /me returns profile.avatar_url = null because the legacy controller has no storage or FilesService. The membership module (Phase C) must issue the signed URL (PRD 5.4).
- Carried over: GET /me/card uses member_access any, which deviates from ARCHITECTURE §3.1 'own card nonsuspended', so a suspended member gets status_label suspended without a QR and the offline cache is replaced (AC F05-4). The architect should confirm.
- Carried over: product decision that PATCH /me/profile cannot change full_name; name corrections go through adminUpdateMember with an audit entry.
- Carried over: guideline page 16 'Hapus Data Pengguna' is not modelled (PRD F-14 deletion is user-initiated only).
- test:pg is timing-sensitive: payments.pg.test.ts concurrently() asserts that at least one session waited on a lock, and this failed once each in two of three runs on this machine for different tests. It is unrelated to C2 and owned by schema/integrator; consider a more robust lock-wait probe.

## handoff
Operations (METHOD path operationId access), current after round 2 (changed vs 49d8c40: adminListMasters in round 1; adminSuspendMember and adminUnsuspendMember permissions in round 2):
- GET /me getMe {mobile, member_access any}
- PATCH /me/profile updateMyProfile {mobile, nonsuspended}, If-Match (alumni.version)
- GET /me/card getMyCard {mobile, any}
- GET /me/membership getMyMembership {mobile, any}
- GET /masters/{kind} listMasters {mobile, nonsuspended}
- GET /health getHealth {public}, security []
- GET /health/ready getHealthReadiness {public}, security []; 200 or 503 HealthReadiness (checks now include optional outbox_oldest_pending_seconds)
- GET /public/config getPublicConfig {public}, security []
- POST /public/kta/verify verifyKta {public}, security [], 429; exempt from maintenance by exact path
- GET /admin/members adminListMembers {admin, [members.read]}
- GET /admin/members/{userId} adminGetMember {admin, [members.read]}
- PATCH /admin/members/{userId} adminUpdateMember {admin, [members.read, members.manage]}, If-Match
- POST /admin/members/{userId}/suspend adminSuspendMember {admin, [members.read, moderation.read, moderation.resolve], idempotent}, If-Match + Idempotency-Key (CHANGED in round 2: + moderation.read)
- POST /admin/members/{userId}/unsuspend adminUnsuspendMember {admin, [members.read, moderation.read, moderation.resolve], idempotent}, If-Match + Idempotency-Key (CHANGED in round 2: + moderation.read; closes active appeals)
- POST /admin/members/{userId}/password-reset adminInitiateMemberPasswordReset {admin, role super_admin, reauth, idempotent}; 202
- GET /admin/members/{userId}/membership-events adminListMemberMembershipEvents {admin, [members.read]}
- GET /admin/masters/{kind} adminListMasters {admin, permissions_any [members.read, master.manage]} (CHANGED from permissions [])
- POST /admin/masters/{kind} adminCreateMaster {admin, [master.manage]}; 201
- GET /admin/masters/{kind}/{masterId} adminGetMaster {admin, [master.manage]}
- PATCH /admin/masters/{kind}/{masterId} adminUpdateMaster {admin, [master.manage]}, If-Match
- DELETE /admin/masters/{kind}/{masterId} adminDeleteMaster {admin, [master.manage]}, If-Match; 204

New or changed schemas:
- me.yaml: SocialHandle (string 1..200, pattern `^(?:@?[A-Za-z0-9._-]{1,100}|https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/?#][^\s<>"'`]*)?)$`; Dart typedef SocialHandle = String). Used through oneOf [SocialHandle, null] by ProfileUpdate.social_* and AdminMemberUpdate.social_*.
- MemberCard: cohort and graduation_year are now required.
- KtaVerification: required [result, checked_at, expiring, member].
- AdminMemberSuspension: reason_redacted (boolean, required) added.
- AdminMembershipEvent: reason_redacted (boolean, required) added.
- Round 2: MembershipPeriodKind enum [activation, renewal] (was [registration, renewal]); AdminMemberDetail.recent_tickets type [array, null]; AdminMemberUnsuspendRequest.member_message optional (string 3..500); KtaVerification/KtaVerifiedMember/KtaVerificationResult descriptions carry the ordered evaluation and the 30-day identity bound.
- Main schema list otherwise as in 49d8c40: Me, MeMembershipPayment(Stage), Profile, ProfilePrivacy(Update), ProfileUpdate, MasterItem(List), MemberCard, MemberCardStatus/Action/Qr, Membership, MembershipPeriod, PublicConfig, LegalVersions, KtaVerifyRequest, KtaVerification, KtaVerifiedMember, HealthReadiness*, AdminMember*, AdminMembershipEvent*, AdminMaster*.

Implementation rules (rounds 1 and 2):
- verifyKta: evaluate in the order of the public.yaml description (signature/iss/aud → account exists → binding → exp → current status); first match wins. Rate-limit buckets: IP (all), sha256(token) (all), member number (only after step 1 passes). Never log the raw token.
- adminUnsuspendMember transaction: lock the alumni row; clear suspend columns; membership_event unsuspend; audit member.unsuspended; lock and close every open/in_review appeal report of the member (resolved, action unsuspend, resolution_note, resolved_by_admin_id, resolved_at, version+1, audit moderation.report_resolved); one account notification with member_message or the default text. adminResolveReport's unsuspend must use the same helper.
- Permission filtering, applied to every AdminMemberDetail response and to `current` in 409s:
  - without payments.read: recent_payments = null;
  - without events.manage and without payments.read: recent_tickets = null;
  - without moderation.read: moderation = null, suspension.reason = null and suspension.reason_redacted = true.
- Membership events without moderation.read: warn rows are excluded from items and total, kind=warn returns 403 FORBIDDEN, and suspend/unsuspend rows have reason null with reason_redacted true. number_correction reasons stay visible.
- Admin password reset:
  - lock the users row, then issue an OTP with purpose password_reset;
  - email the code plus the single link kapdh://app/forgot/otp?challenge_id=<challenge_id> (same as C1 forgotPassword);
  - revoke all sessions after commit with session.revoked reason password_reset (all_sessions true);
  - the member redeems challenge_id + code for a reset_token, then calls POST /auth/password/reset;
  - the code never goes in a URL, response, log or audit; the security notification never contains challenge_id or code.
- Social fields: the server re-validates the SocialHandle pattern, strips a leading @ from usernames and rejects other URL schemes with 400 on the field.
- Legacy interim API: GET /me uses toMembershipPayment(row) (rejected → rejected; pending with proof_version 0 → awaiting_proof; otherwise awaiting_review; rejection_reason only when rejected); renewal_eligible = opensAt != null && status != suspended && now >= expires_at - 30 days. PublicController takes StaticPublicConfig (PUBLIC_CONFIG) and adds server_time = clock.now().toISOString().

The x-kapdh-access vocabulary is documented in the me.yaml header comment and in CHANGELOG.md under 'Belum dirilis'.
