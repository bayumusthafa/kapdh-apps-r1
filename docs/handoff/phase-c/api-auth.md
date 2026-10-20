# Phase C slice: api-auth

Final report after build, adversarial review (9 findings) and fixes (commit e83c7a1).

## Summary
I checked all 9 findings and every one was real. The 7 code findings are fixed, and each fix has a test that fails on the old code (6a7d235) and passes now. The 2 reporting findings are handled through shared_changes below.

**1. Login could issue a session after a password reset or change (findings 1 and 6, high).** `AuthService.login` no longer just updates `last_login_at`. The update now only succeeds if the stored `password_hash` is still the one bcrypt checked and the account is still `active` (and `kind = 'alumni'`). It waits behind the row lock held by a reset or change. If it updates no row, the login gets the same 401 'Email atau password salah.' and no session.
- Default-lane tests in `test/auth/password.e2e.test.ts` (new describe block): reset, change and account disabling happen exactly between the bcrypt check and session issuance. They spy on `PasswordVerifier.verify`, so they are deterministic.
- PG-lane tests: login with the old password while a reset or change holds its lock.

**2. Revocations could miss a refresh rotation that was in progress (findings 2, 5, 7 and 8).** New file `modules/auth/session-locks.ts` sets one lock order on the users row:
- Refresh now starts its transaction by locking the users row `FOR SHARE`. The status, kind and admin checks moved inside that lock; they used to run before the transaction.
- `logout`, `logoutAll`, `revokeFamilyOnReuse` and `SessionsService.revoke` now start by locking the users row `FOR UPDATE`.
- Effect: a revocation either runs after the rotation commits and also revokes the new row, or the rotation loses and gets 401.
- No deadlock: every transaction takes the users lock before any session row.
- The reuse audit row now counts the newly rotated row.
- Reset and change already locked the users row first, so they are unchanged.

New PG-lane file `test/pg/auth-races.pg.test.ts` holds a lock on a `device_tokens` row to freeze a transaction midway. It covers:
- logout-all while another device's rotation is in progress, and the reverse order;
- reuse detection while the thief's rotation is in progress;
- `revokeSession` (now 204, not 404) and logout during a rotation;
- the two login races from point 1.

6 of the 7 fail on the old code; the reverse-order case is a regression guard that passes on both.

**3. Re-registering a pending account could be used to guess its password (finding 4).** When the email belongs to an existing `pending_otp` account, `register` now takes one failure slot from the `login:<email>` and `login-ip` limits before comparing the password, via `PasswordVerifier.beginAttempt`. A matching password resets the counter; a different one stays counted. Once the limit is used up, the response is 429 with 'Terlalu banyak percobaan pendaftaran ulang untuk email ini. Coba lagi nanti.' and nothing is written. The test is in `test/auth/otp.e2e.test.ts`.

**4. Undeclared shared changes (findings 3 and 9).** Both were real for the report and are now listed in shared_changes below; no code change. A table was still needed for decoy challenges. Status, resend, cooldown, the attempt count and replacement all need stored state per challenge_id and per email key. The rate-limit store only keeps counters, and in production it is Redis or per-instance memory. A stateless signed challenge cannot count attempts or be marked as replaced.

**Contract changes** (auth.yaml descriptions plus CHANGELOG) are listed in contract_changes.

**Checks.** All verification commands passed: API 464/464 (was 460), PG lane 84/84 (was 77). The first two parallel `pnpm test` runs each had one unrelated test time out under machine load; full details are in the verification entries.

Commits on the branch: eece3da (WIP), then e83c7a1 (final fix).

## AC coverage
- [covered] AC F02-4 (login vs concurrent reset/change, findings 1 and 6): Default lane, test/auth/password.e2e.test.ts, describe 'AC F02-4: login yang menilai sandi lama tidak memperoleh sesi setelah reset/ganti sandi (TOCTOU)': reset in the window gives 401 and no live session; change in the window gives 401 and only the changer's family stays live; account disabled in the window gives 401. PG lane, test/pg/auth-races.pg.test.ts: 'AC F02-4: reset sandi commit saat login sandi lama menunggu...' and 'AC F02-4: ganti sandi commit saat login sandi lama menunggu...'. All fail on 6a7d235 and pass now.
- [covered] AC F02-6 (logout-all vs in-flight rotation, findings 2 and 5): test/pg/auth-races.pg.test.ts 'AC F02-6: logout semua saat rotasi perangkat lain berjalan...': the rotated row is revoked, its refresh token and access token get 401, audit sessions_revoked = 2, push tokens revoked. 'AC F02-6: logout semua lebih dulu, rotasi menunggu lalu kalah...': refresh gets 401 and no session stays live. Existing sessions.e2e AC F02-6 (real Socket.IO) still passes.
- [covered] AC F02-3 (reuse detection vs thief's in-flight rotation, finding 7): test/pg/auth-races.pg.test.ts 'AC F02-3: pemakaian ulang token lama saat rotasi pencuri berjalan...': r2 revoked and gets 401 afterwards; the audit row is exactly [{sessions_revoked: 1, concurrent: false}]. Existing auth-flows.pg concurrent same-token refresh test still passes.
- [covered] revokeSession / logout vs in-flight rotation (finding 8, AC F13-5): test/pg/auth-races.pg.test.ts 'kontrak revokeSession: ... → 204 dan baris hasil rotasi ikut dicabut' (was 404 on 6a7d235) and 'AC F13-5: logout saat rotasi keluarga yang sama berjalan → baris hasil rotasi ikut dicabut'.
- [covered] PRD 2.5 register is not a password oracle (finding 4): test/auth/otp.e2e.test.ts 'PRD 2.5: registrasi ulang menilai sandi tersimpan → dihitung ke batas kegagalan login (bukan oracle sandi)': 9 wrong guesses, then the owner's own password gives 201 with the same challenge (counter reset); 10 more wrong guesses, then the correct password gives 429 RATE_LIMITED with the re-register message and Retry-After; login also gets 429; after 15 minutes 201. Fails on 6a7d235.
- [covered] AC F01-1, F01-2, F01-3, F01-4, F02-1, F02-2, F02-5, PRD 2.5 non-enumeration, decorator/x-kapdh-access parity: All builder tests unchanged and passing: test/auth/{auth,access,otp,password,sessions}.e2e.test.ts (106 tests in test/auth) and test/pg/auth-flows.pg.test.ts, auth-otp.pg, auth-limits.pg.

## Verification
- pass `pnpm build`: 10/10 tasks successful (contracts regenerated after the auth.yaml description edits)
- pass `pnpm typecheck`: 15/15 tasks successful
- pass `pnpm lint`: 9/9 tasks successful; only the 2 known redocly warnings
- pass `pnpm test`: The first two parallel runs each had one unrelated timeout under machine load: admin src/flow.test.tsx (82 s file), then api test/core/worker-package.e2e.test.ts (30 s timeout). Neither touches code changed here, and both passed when re-run alone (admin 143/143, worker-package 2/2). The full suite then passed via `pnpm exec turbo run test --concurrency=1`: 15/15 tasks, api 464/464 (was 460), admin 143/143, database 23, storage 33, config 23, shared 16, web 5.
- pass `pnpm --filter @kapdh/api test:pg`: 12 files, 84/84 (was 77; +7 in auth-races.pg.test.ts); exit 0. The known embedded-postgres 'done is not a function' teardown message still prints. auth-races + auth-flows also passed 3 consecutive repeat runs (18/18 each).
- pass `pnpm contracts:lint`: API description valid, 2 known warnings; events catalog valid
- pass `pnpm format:check`: All matched files use Prettier code style
- pass `PATH=/c/flutter/flutter/bin:$PATH pnpm contracts:test-dart`: Dart SDK analyze clean; all tests passed
- pass `Regression proof: old auth.service.ts and sessions.service.ts restored temporarily, then new tests run`: On the 6a7d235 code, the 4 new default-lane tests failed and 6 of the 7 new PG-lane race tests failed (404 instead of 204, rotated row revoked_at null, in-flight login 200). The 7th, the reverse-order logout-all case, is a regression guard and passes on both. Fixed files were then restored and all pass.
- not_run `flutter analyze / flutter test (kapdh-mobile)`: No mobile code changed; contract changes are description-only

## Contract changes
- auth.yaml register: description says 429 also covers the resend cooldown and the password-failure limit. Re-registering a pending_otp account uses the login:<email> failure slot for each password comparison (PRD 2.5). Description only.
- auth.yaml login: a session is issued only if the checked password and status 'active' still hold under the users row lock; a login in progress when a reset, change or disable commits gets the same 401 (AC F02-4). Description only.
- auth.yaml refreshSession: a rotation in progress is serialized with revocations (logout, logout-all, revokeSession, reuse detection, reset or change) through the users row lock. The revocation also revokes the rotated row, or the rotation loses with 401 (AC F02-3, F02-6). Description only.
- auth.yaml logoutAll: a rotation or login in progress on another device either completes first and is then revoked, or fails with 401. Description only.
- auth.yaml revokeSession: a rotation of the target family in progress completes first and its new row is revoked; the response is 204, not 404. Description only.
- packages/contracts/CHANGELOG.md: three rows added to the 'Fase C api-auth' table (POST /auth/register; POST /auth/login; refresh, logout-all and DELETE /auth/sessions/{sessionId}). All additive.

## Shared changes
- From builder commit 6a7d235, carried unchanged by this fix (findings 3 and 9 are now declared). NEW MIGRATION (integrator renumbers): packages/database/migrations/0007_auth_otp_decoys.sql, plus meta/0007_snapshot.json and the _journal.json entry with idx 7. It will collide with any other Phase C 0007 migration and must be renumbered. It adds table app.otp_decoys: purpose CHECK in (password_reset, deletion), email_key (64-hex HMAC), email_masked, attempts 0..5, expires_at, resend_available_at, superseded_at, created_at, a partial unique index on (email_key, purpose) WHERE superseded_at IS NULL, and a created_at index. No foreign keys, no enum changes, no PG18-only SQL.
- Why the table is needed: decoy challenges (non-enumeration, PRD 2.5 / contract C1) must behave like real ones. That needs stored state per challenge_id and per email key: status, resend, the 60 s cooldown, attempts 0..5, replacement and 24 h retention. otp_codes cannot hold them because user_id is NOT NULL. The rate-limit store only keeps counters and is Redis or per-instance memory in production, so it cannot hold this state consistently. A stateless signed challenge cannot count attempts or be marked as replaced.
- packages/database/src/schema/identity.ts: new otpDecoys table definition (file owned by the database team; builder commit 6a7d235).
- apps/api/src/core/db/locks.ts (core-owned): ADVISORY_LOCK_NAMESPACES.otpDecoy = 47_110_003 (builder commit 6a7d235). The integrator must keep advisory namespaces unique across slices.
- packages/database/test/schema.pglite.test.ts:139 and apps/api/test/pg/migrate-and-seed.pg.test.ts:140: expected app table count changed 39 -> 40 (builder commit 6a7d235). Merge with other slices' table additions. ARCHITECTURE §5.3 ('37 PRD + 2 extras') should mention otp_decoys; not edited.
- This fix commit touches no shared files: changes are only in modules/auth (auth.service.ts, sessions.service.ts, new session-locks.ts), the auth tests, the new test/pg/auth-races.pg.test.ts, and the slice-owned auth.yaml and CHANGELOG.md.

## Open issues
- admin-auth (other slice): adminLogin issues an mfa_token (5 min) after the password check. adminVerifyMfa then issues a session without re-checking that the password_hash or session_version is unchanged. So an mfa_token obtained just before an admin password change or reset still yields a session. This is the same class of bug as finding 1. Suggested fix: bind the mfa_token to an HMAC of password_hash (like the reset_token binding) or to session_version, and re-check it under the users lock in the MFA transaction. Not edited (admin-auth owns that file).
- Lock-order rule for other slices (see modules/auth/session-locks.ts): any transaction that revokes sessions must lock the users row before touching sessions. Use FOR UPDATE, or at least FOR NO KEY UPDATE, which already conflicts with refresh's FOR SHARE; MembershipKernel.lockMember already does this. Session issuance must go through a users row lock (login, activation and admin MFA all update users first). Account deletion, admin disable and admin-members suspend should keep this order.
- Carried from builder: the account (F-14 deletion) and admin-members (AC F16-4) slices should use the exported OtpChallengeService (issueForAccount, issueDecoy, verifyCode, consume) so /auth/otp/status and /auth/otp/resend work for their challenges and decoys. The integrator must reconcile any separate decoy storage with otp_decoys.
- Carried from builder: maintenance.cleanup (core/admin) should delete otp_codes and otp_decoys rows older than OTP_CHALLENGE_RETENTION_MS (24 h). The auth module already treats older challenges as unknown and cleans stale decoys in batches when it issues new ones.
- Carried from builder: the sessions list created_at is the earliest stored row of the family; if cleanup deletes old rotated rows, the value can move (still stable while paging). test/auth/auth.e2e.test.ts still contains the admin TOTP tests (the admin-auth slice may move them). Admin logout-all writes an audit row only (admin.security_notice has no logout_all kind).
- Test flakiness under load (not caused by this slice): apps/admin src/flow.test.tsx and apps/api test/core/worker-package.e2e.test.ts each timed out once during a parallel `pnpm test` on this loaded machine, then passed alone and in a serial turbo run.

## Handoff notes
**Fix commits on worktree-wf_b8bd7d01-232-1:**
- eece3da: wip checkpoint
- e83c7a1: fix(api-auth), on top of the builder's 6a7d235

**Lock order (new: kapdh-platform/apps/api/src/modules/auth/session-locks.ts):**
- `lockOwnerForRotation(tx, userId)` selects users FOR SHARE and returns `{status, kind}`. It is the first statement of the `AuthService.refresh` transaction; status, kind and the admin-active check now run inside the transaction under this lock.
- `lockOwnerForRevocation(tx, userId)` selects users FOR UPDATE. It is the first statement of `logout`, `logoutAll`, `revokeFamilyOnReuse` and `SessionsService.revoke`.
- `PasswordService` reset and change already lock users FOR UPDATE first and are unchanged.
- FOR UPDATE conflicts with SHARE (rotation), NO KEY UPDATE (login and activation updates) and KEY SHARE (the foreign-key check on any session INSERT). So revocation and issuance never interleave.
- Deadlock-free because every path takes the users lock before any session row.

**Login (AuthService.login, active branch):** the transaction runs `UPDATE users SET last_login_at WHERE id AND kind='alumni' AND password_hash=<verified hash> AND status='active' RETURNING id`. Zero rows gives `unauthenticated('Email atau password salah.')` before `SessionIssuer.issue`.

**Register:** for an existing pending_otp account, `beginReRegisterAttempt(email)` wraps `PasswordVerifier.beginAttempt` and rewrites the 429 message. Call `succeeded()` on a password match; keep the slot on a mismatch; call `cancel()` on infrastructure errors. New emails take no slot.

**Tests:**
- Default lane (test/auth/password.e2e.test.ts): the `afterPasswordCheck` helper spies once on `PasswordVerifier.verify` to run an operation inside the TOCTOU window.
- PG lane (test/pg/auth-races.pg.test.ts): `deviceTokenGate(userId, sessionRowId|null)` holds FOR UPDATE on a device_tokens row, freezing a rotation (in moveDeviceTokensToSession) or a reset, change or logout-all (in revokeDeviceTokens) midway. `untilLockWaiters(n)` polls pg_stat_activity. Other slices can reuse this pattern.

**Counts:** API default lane 464, PG lane 84.
