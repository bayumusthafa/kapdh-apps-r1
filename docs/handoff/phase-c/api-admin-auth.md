# Phase C slice: api-admin-auth

Final report after build, adversarial review (8 findings) and fixes (commit bd8828b).

## Summary
I checked all 8 review findings. Two pairs were duplicates (1 and 8, 2 and 7), so there were 6 distinct issues. I fixed 5 in code, each with a test that fails on the old code. Finding 3 was a reporting issue; I have re-issued the shared_changes list below. Everything is in one commit, bd8828b ("fix(api-admin-auth): ...") on top of 5156a79. I squashed my interim commits into it.

What changed:

1. **Spent mfa_token (findings 1 and 8).** A token whose jti was already consumed now gets 401 before anything else happens: no MFA failure slot is reserved and no code is checked. If a wrong code is checked while another request with the same token wins, it also gets 401 and its slot is given back. Someone holding a spent token can no longer lock the admin out of the MFA step. A retry after a lost 200 response now sends the user back to login instead of showing "Kode salah".

2. **Lock order (findings 2 and 7).** adminVerifyMfa now locks admins FOR SHARE, then users FOR NO KEY UPDATE, then mfa_totp FOR UPDATE. lockEnrollment now also locks the users row (FOR NO KEY UPDATE) between admins and mfa_totp. The order admins → users → mfa_totp is written down in admin-auth.shared.ts so the C7 MFA reset and the auth-slice reauth can follow it.

3. **Bootstrap CLI race (finding 6, high).** When re-issuing an invite, the CLI now:
   - locks the admins row FOR UPDATE, then users FOR UPDATE;
   - re-checks role, status, user status and whether a usable Super Admin exists, while holding the locks;
   - uses `.returning()` on the conditional UPDATE and refuses if no row changed, before touching users, mfa_totp, sessions or the audit log.
   An activation that commits while the CLI waits is no longer wiped; the CLI exits 1 with "Super Admin aktif sudah ada" and changes nothing.

4. **Failed-attempt audit (finding 4).** There is a new throttled `admin.auth_failed` audit (after: {stage, window_minutes}). It covers these stages:
   - password stage of login, only when the email belongs to an admin identity;
   - wrong MFA code at login;
   - wrong code at enrollment confirm;
   - wrong current password at password change.
   It writes at most one row per admin per stage per 15 minutes, using the rate-limit store. No secrets or attempted emails are stored, and unknown emails are not audited.

5. **Login validation (finding 5).** POST /admin/auth/login now checks the email format, a 254-character limit and a 128-character password limit, as AdminLoginRequest requires. Bad input gets 400 VALIDATION_ERROR before the failure limits are touched. The bootstrap CLI email check uses the same zod email rule.

The admin-auth.yaml changes are description-only, and they are recorded in CHANGELOG.md.

All verification passed. API tests went from 438 to 442, and the PG lane from 72 to 74.

## AC coverage
- [covered] Finding 1/8 (F-02, PRD 2.5): spent mfa_token rejected 401 before any code is checked; MFA budget untouched: test/admin-auth/admin-auth.e2e.test.ts 'AC F02-2 PRD 2.5: mfa_token bekas ditolak 401 sebelum kode dinilai; pemegangnya tidak dapat menghabiskan jatah kode admin': the same token and same code retried → 401; 6 wrong TOTP codes plus 1 backup code from another IP → 401; no admin.mfa_locked or admin.auth_failed rows; the real admin's next wrong code shows 'Sisa percobaan 4.' and the next correct code → 200. Mutation check: with the pre-check and the in-catch check removed, this test fails (400 instead of 401).
- [covered] Finding 2/7 (ARCHITECTURE §2.11): consistent lock order admins → users → mfa_totp; MFA login during an MFA reset does not deadlock: test/pg/admin-auth.pg.test.ts 'ARCHITECTURE §2 butir 11 AC F02-2: login MFA bersamaan dengan reset MFA (admins → users → mfa_totp) → menunggu lalu 401, bukan deadlock 500' (uses withLockWaitGate; lockWaitObserved=true; reset commits; response 401; no session or admin.login). With the pre-fix admin-auth.service.ts restored, the test failed with 500 INTERNAL_ERROR.
- [covered] Finding 6 (PRD 8.2, ARCHITECTURE §2.11): bootstrap re-issue running alongside /totp/confirm refuses and leaves the newly active Super Admin intact: test/pg/admin-auth.pg.test.ts 'PRD 8.2 ARCHITECTURE §2 butir 11: bootstrap ulang bersamaan dengan aktivasi /totp/confirm → menolak; Super Admin yang baru aktif tetap utuh': lockWaitObserved=true; exit 1 with 'Super Admin aktif sudah ada' and no link; admin active; 1 verified mfa_totp row; password hash and session_version unchanged; audits are only ['admin.bootstrap']. With the pre-fix bootstrap-super-admin.ts restored, the test failed (the CLI printed 'diterbitkan ulang').
- [covered] Finding 4 (F-17, slice 'audit every admin auth event'): failed admin auth attempts are audited, throttled, without secrets: e2e 'F-17: sandi salah, kode MFA salah dan sandi lama salah → satu admin.auth_failed per tahap per 15 menit':
- password, mfa and change_password stages each write exactly 1 row;
- the actor is anonymous for login and the calling admin for password change;
- no password, code or email appears in the rows, and an unknown email writes no row;
- after 15 minutes a new failure writes a second row.
e2e 'F-17 F-16: kode salah saat konfirmasi pendaftaran TOTP → admin.auth_failed tahap enrollment, sekali per jendela'.
- [covered] Finding 5 (contract AdminLoginRequest, PRD 5.2): login input validated; 400 does not use up login-failure slots: e2e 'AC F02-2 PRD 5.2: AdminLoginRequest divalidasi (format email, sandi maks. 128) → 400 tanpa menyentuh batas kegagalan login':
- a bad email → 400 field email (matches the contract);
- 12 sends of a 129-character password → always 400, never 429;
- a 128-character password → 401;
- a padded, upper-case email with the correct password → 200.
Mutation check: with the old schema restored, this test fails.
- [covered] Finding 3 (ownership): core changes listed in shared_changes: Re-issued below in full detail, including verifyMfa/verifyMfaClaims now rejecting MFA tokens without a jti. This fix touches no core files.
- [covered] Existing slice ACs: F02-2, F02-4, F02-5, F-16 and PRD 8.2 regression: All existing e2e and PG tests still pass: pnpm test (API 442), test:pg 74, and the bootstrap-cli e2e tests (email validation now uses zod; 'bukan-email' is still refused).

## Verification
- pass `pnpm build`: 10/10 turbo tasks; contracts regenerated; nothing left uncommitted
- pass `pnpm typecheck`: 15/15 tasks
- pass `pnpm lint`: 9/9 tasks; only the 2 known redocly warnings
- pass `pnpm test`: 15/15 tasks on the final run: API 33 files / 442 tests (438 + 4 new), admin 143, config 23, database 23, storage 33, shared 16, web 5. The first full run had one admin flow.test.tsx timeout under parallel load, and the first admin-only rerun had a payments.test.tsx timeout (5.7 s). The next admin-only rerun and the next full run were all green. This fix changes no apps/admin files (checked with git diff 7a0be1e..HEAD -- apps/admin).
- pass `pnpm --filter @kapdh/api test:pg`: 11 files / 74 tests (72 + 2 new). The known embedded-postgres teardown message 'done is not a function' still appears after the results.
- pass `pnpm contracts:lint`: exit 0; 2 known warnings
- pass `pnpm format:check`: All matched files use Prettier code style
- pass `PATH=/c/flutter/flutter/bin:$PATH pnpm contracts:test-dart`: exit 0; Dart SDK analyze clean, all tests passed
- pass `Mutation check: pre-check and in-catch spent-token check disabled, old login schema restored; ran test/admin-auth/admin-auth.e2e.test.ts`: The 2 new e2e tests failed as expected (400 instead of 401; 401 instead of 400). Code restored with git checkout.
- pass `Mutation check: 5156a79 versions of admin-auth.service.ts and bootstrap-super-admin.ts restored; ran test/pg/admin-auth.pg.test.ts`: The 2 new PG tests failed as expected (500 INTERNAL_ERROR deadlock; CLI re-issued over the activation). Code restored with git checkout HEAD.

## Contract changes
- admin-auth.yaml adminLogin description (no schema change): 400 VALIDATION_ERROR for input that breaks AdminLoginRequest (email format, password over 128) without touching the failure limits; failures for an admin identity's email are audited as admin.auth_failed (stage password), at most once per admin per 15 minutes; unknown emails are not audited.
- admin-auth.yaml adminVerifyMfa description: a spent mfa_token gets 401 before any code is checked (same code, next TOTP step, another backup code or a wrong code), so the attempt does not count toward the 5-code limit; the first wrong code in a 15-minute window is audited as admin.auth_failed (stage mfa).
- admin-auth.yaml adminConfirmTotpEnrollment and adminChangePassword descriptions: the first wrong code or wrong current password in a 15-minute window is audited as admin.auth_failed (stage enrollment / change_password), without secrets.
- packages/contracts/CHANGELOG.md 'Fase C api-admin-auth': 3 new table rows for the above, plus a paragraph on the bootstrap re-issue now locking and re-checking state, and the CLI email check matching AdminLoginRequest.

## Shared changes
- Re-issued from the builder commit 5156a79 (finding 3), no further core edits in this fix — apps/api/src/core/identity/token.service.ts (additive, core-owned):
- signMfa now adds a random jti (uuidv7).
- New verifyMfaClaims(token) -> {userId, tokenId, expiresAt}. It returns null for a token without a jti, so verifyMfa now rejects jti-less MFA tokens; only signMfa issues them.
- New audience kapdh-admin-enroll with ADMIN_ENROLL_TTL_SECONDS = 1800, signAdminEnroll({userId, adminId, binding}) and verifyAdminEnroll(token) -> AdminEnrollClaims.
- New exported types MfaClaims and AdminEnrollClaims.
The api-auth slice (TokenService, POST /auth/reauth) must keep these when merging.
- Re-issued from 5156a79 — apps/api/src/core/guards/auth.guard.ts: an enrollment token (aud kapdh-admin-enroll) on any admin-audience route now returns 403 MFA_REQUIRED, like the password-stage token (C1 contract, AC F02-2). If this branch is lost in a merge, enrollment tokens get 401 and the AC F02-2 e2e tests fail.
- Re-issued from 5156a79 — apps/api/src/core/identity/crypto.ts: new adminInviteLink(adminOrigin, token) builds ${ADMIN_ORIGIN}/invite#t=<token>; the newAdminInviteToken comment that suggested the forbidden /invite/<token> form is fixed. The C7 admin-admins slice (invite, resend, recovery) must use adminInviteLink.
- Re-issued from 5156a79 — apps/api/src/core/outbox/topics.ts (additive): admin.security_notice.kind gains 'activated' and 'backup_codes_regenerated'. Nothing consumes this topic yet; the notifications/admin worker slice must send an email for every kind.
- apps/api/src/cli (this slice's CLI): bootstrap-super-admin.ts re-issue now locks admins then users, re-checks state and usable Super Admins under the locks, and refuses when the conditional UPDATE matches 0 rows. Email validation now uses zod email with max 254. bootstrap-admin.ts and bootstrap-admin-command.ts are unchanged in this fix.
- apps/api/test/pg/admin-auth.pg.test.ts (slice-owned file in the PG lane directory): 2 new tests and a runBootstrapCli helper; lane infra is untouched.

## Open issues
- Lock-order rule for other slices: the C7 MFA reset, recovery and re-invite (api-admin) and admin POST /auth/reauth (api-auth) must lock admins → users → mfa_totp and never lock an earlier table after a later one. The rule is documented in apps/api/src/modules/admin-auth/admin-auth.shared.ts. With this fix, adminVerifyMfa waits on the admins row instead of deadlocking.
- Admin reauth (api-auth slice) must still check TOTP with the same anti-replay rule (conditional UPDATE so last_used_step only increases) and remove backup codes atomically. adminRegenerateBackupCodes depends on that endpoint; the tests sign level-2 reauth tokens directly.
- admin.security_notice has no outbox consumer yet (notifications/admin worker slice), including the kinds 'activated' and 'backup_codes_regenerated'.
- admin.auth_failed is throttled to one row per admin per stage per 15 minutes through the shared rate-limit store, so a multi-instance production deployment needs REDIS_URL, as ARCHITECTURE already requires. The admin-audit list (api-admin) may want a label for this action.
- Admin web (outside this slice): apps/admin/src/api/mocks/auth.ts and the /invite and /login/enroll placeholders must follow the real flow preview → accept → enroll → confirm, with the token in the #t= fragment. On a 401 from /admin/auth/mfa the UI should go back to /login, which now includes reuse of a spent token.
- PRD 8.2 only requires refusal when an active Super Admin exists. Running the CLI before activation with a different email still creates a second invited Super Admin. Runs are serialized by the advisory lock, and the usable-Super-Admin check now runs again under the row locks during a re-issue. The product owner may want a stricter rule.
- Admin web tests time out under heavy parallel load (flow.test.tsx, payments.test.tsx); each passes when rerun. Not caused by this slice, which changes no apps/admin files.

## Handoff notes
Fix commit bd8828b, on top of builder commit 5156a79, branch worktree-wf_b8bd7d01-232-2.

Main files (under kapdh-platform/apps/api):
- src/modules/admin-auth/admin-auth.service.ts:
  - adminVerifyMfa runs in this order: verifyMfaClaims, then mfaTokenSpent (peek mfa-token:<jti>) → 401, then reserve mfa:<user>, then a transaction (admins FOR SHARE → users FOR NO KEY UPDATE → mfa_totp FOR UPDATE → check code → consume jti → session).
  - On a wrong code, the catch block checks mfaTokenSpent again: 401 and the slot is released.
  - adminLogin audits 401 failures for admin identities.
- src/modules/admin-auth/admin-auth.shared.ts:
  - the lock-order doc block;
  - auditAuthFailure(deps, adminId, stage), with stages password | mfa | enrollment | change_password and throttle key admin-auth-fail-audit:<stage>:<adminId> (15 minutes); the key is reset if the audit write fails.
- src/modules/admin-onboarding.service.ts: lockEnrollment locks users FOR NO KEY UPDATE; a wrong confirm code is audited with stage enrollment.
- src/modules/admin-auth/admin-credentials.service.ts: injects RateLimitService and audits a wrong current_password with stage change_password.
- src/modules/admin-auth/admin-auth.controller.ts: the login schema is now email().max(254) with password max 128.
- src/cli/bootstrap-super-admin.ts: refuseIfUsableSuperAdmin(tx) helper; the re-issue path takes row locks, re-checks, and uses returning() with a row-count check.

Audit action list from the builder notes, plus admin.auth_failed (after {stage, window_minutes: 15}). The actor is anonymous for public stages and the calling admin for change_password.

New tests:
- e2e (test/admin-auth/admin-auth.e2e.test.ts), 4 tests:
  - spent token;
  - login validation;
  - auth_failed for password, mfa and change_password;
  - auth_failed for enrollment.
- PG (test/pg/admin-auth.pg.test.ts), 2 tests:
  - MFA login during an MFA reset, no deadlock;
  - bootstrap re-issue during activation.

Both PG tests use withLockWaitGate. The bootstrap test uses its own fresh database, 'admin_bootstrap_race'.
