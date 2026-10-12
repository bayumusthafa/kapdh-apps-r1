# Phase B handoff: contract C2-membership

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

## fix summary
I checked all 8 review findings for C2 Membership. Seven were real and are fixed. The low-severity maintenance finding was partly real: I fixed the wording but did not declare a 503 response (reason in open_issues). Everything is committed in 79ec626 on top of 49d8c40, and the branch is green: build, typecheck, lint, all tests and format checks pass, with API tests at 89 of 89.

1. Red branch (high). I put the API adaptation into the repo instead of leaving it as a scratchpad patch.
   - GET /me (apps/api/src/me/me.controller.ts) now returns the new contract shape from real data: account_status, cohort_code, starts_at, renewal_eligible and renewal_opens_at, a profession and skills with historical labels, and registration/renewal payment pointers with their stage (awaiting_proof, awaiting_review or rejected).
   - avatar_url is still null in this interim controller because it has no storage driver yet.
   - GET /public/config now gets server_time from the injected CLOCK inside PublicController, not from `new Date()`. app.module.ts adds store_links and legal.
   - I confirmed the GET /me data against the contract with a temporary test (TestClock, profession, skills, payment stage changes, renewal window), then deleted it.
2. Admin password reset could not be completed (medium). The email now carries the OTP code and an app link `${PUBLIC_WEB_URL}/app/forgot/otp?challenge=<challenge_id>`, or the equivalent `kapdh://app/...` form. The member enters the code without going through "Lupa sandi" again, so the admin's challenge is not replaced. The code is never in a URL. Resend or forgot-password still work as fallbacks.
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
- C1 (auth.yaml) dependency, not edited: forgotPassword's description says an admin-started reset continues through /auth/password/forgot. That call would replace the admin's challenge. C1 should instead say the member redeems the emailed challenge_id directly with the password-reset OTP verify endpoint (challenge_id + code → reset_token), with /auth/otp/resend as the fallback.
- Mobile/ARCHITECTURE §8.4: the /forgot/otp route must accept the query parameter `challenge` (from the email link https://kapdh.or.id/app/forgot/otp?challenge=<id>; DeepLinks.normalize in mobile-foundation already keeps the query). Notification/email templates owner: the admin reset email must contain the code and this link.
- ARCHITECTURE §4.3 wording suggestion (not made): change '/public/** reads' to '/public/** reads (GET, plus POST /public/kta/verify)' to match core-api's maintenanceAllowed.
- x-kapdh-access vocabulary now: audience, member_access, permissions (all required), permissions_any (at least one; new), role (super_admin), reauth, idempotent. core-api has no any-of decorator: add @RequireAnyPermission(...) or check in the handler for adminListMasters. A future contracts lint rule should allow these keys.

## open issues
- Partly rejected: finding 4 (verifyKta should declare 503 MAINTENANCE). The contradiction is real and I fixed it in the description. I did not add a 503 response, because core-api's RequestGate (dde295a, core/http/request-gate.ts maintenanceAllowed) already exempts POST /public/kta/verify by its exact path, so the server never returns 503 MAINTENANCE there. Declaring it would mislead generated clients; any 5xx from a proxy falls to the default response, which the site shows as 'Tidak dapat memverifikasi' (AC F06-4).
- The interim legacy GET /me returns profile.avatar_url = null because the legacy controller has no storage or FilesService. The membership module (Phase C) must issue the signed URL (PRD 5.4).
- Carried over: GET /me/card uses member_access any, which deviates from ARCHITECTURE §3.1 'own card nonsuspended', so a suspended member gets status_label suspended without a QR and the offline cache is replaced (AC F05-4). The architect should confirm.
- Carried over: product decision that PATCH /me/profile cannot change full_name; name corrections go through adminUpdateMember with an audit entry.
- Carried over: guideline page 16 'Hapus Data Pengguna' is not modelled (PRD F-14 deletion is user-initiated only).
- test:pg is timing-sensitive: payments.pg.test.ts concurrently() asserts that at least one session waited on a lock, and this failed once each in two of three runs on this machine for different tests. It is unrelated to C2 and owned by schema/integrator; consider a more robust lock-wait probe.

## handoff
Operations (METHOD path operationId access), unchanged from 49d8c40 except adminListMasters:
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
- POST /admin/members/{userId}/suspend adminSuspendMember {admin, [members.read, moderation.resolve], idempotent}
- POST /admin/members/{userId}/unsuspend adminUnsuspendMember {admin, [members.read, moderation.resolve], idempotent}
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
- Main schema list otherwise as in 49d8c40: Me, MeMembershipPayment(Stage), Profile, ProfilePrivacy(Update), ProfileUpdate, MasterItem(List), MemberCard, MemberCardStatus/Action/Qr, Membership, MembershipPeriod, PublicConfig, LegalVersions, KtaVerifyRequest, KtaVerification, KtaVerifiedMember, HealthReadiness*, AdminMember*, AdminMembershipEvent*, AdminMaster*.

Implementation rules added by this fix:
- Permission filtering, applied to every AdminMemberDetail response and to `current` in 409s:
  - without payments.read: recent_payments = null;
  - without moderation.read: moderation = null, suspension.reason = null and suspension.reason_redacted = true.
- Membership events without moderation.read: warn rows are excluded from items and total, kind=warn returns 403 FORBIDDEN, and suspend/unsuspend rows have reason null with reason_redacted true. number_correction reasons stay visible.
- Admin password reset:
  - lock the users row, then issue an OTP with purpose password_reset;
  - email the code plus the link ${PUBLIC_WEB_URL}/app/forgot/otp?challenge=<challenge_id> (kapdh://app/forgot/otp?challenge=<id> is equivalent);
  - the member redeems challenge_id + code for a reset_token, then calls POST /auth/password/reset;
  - the code never goes in a URL, response, log or audit; the security notification never contains challenge_id or code.
- Social fields: the server re-validates the SocialHandle pattern, strips a leading @ from usernames and rejects other URL schemes with 400 on the field.
- Legacy interim API: GET /me uses toMembershipPayment(row) (rejected → rejected; pending with proof_version 0 → awaiting_proof; otherwise awaiting_review; rejection_reason only when rejected); renewal_eligible = opensAt != null && status != suspended && now >= expires_at - 30 days. PublicController takes StaticPublicConfig (PUBLIC_CONFIG) and adds server_time = clock.now().toISOString().

The x-kapdh-access vocabulary is documented in the me.yaml header comment and in CHANGELOG.md under 'Belum dirilis'.
