# Phase C slice: api-membership

Final report after build, adversarial review (5 findings) and fixes (commit 0aa5ffe).

## Summary
I resumed from the builder's final commit 697213c. No fixer work had been done before, and the tree was clean. The 5 review findings describe 3 distinct defects, because findings 1 and 3 report the same KTA quota problem and findings 2 and 5 the same avatar problem. All 3 were real; I fixed each one and added a regression test that fails on the old code and passes on the new.

1. **KTA verify per-number quota could be drained by someone else (findings 1 and 3, medium).** In `kta-verify.service.ts` the third rate-limit bucket now uses the token's owner (`kta-verify-member:<claims.userId>`), not the `member_number` in the request body. It still runs only after the signature check (step 1), as before. A valid token belonging to member A, sent with member B's number, now uses up A's quota and never B's. For genuine scans the quota is unchanged. The limit was renamed from `perNumber` to `perMember`. Because the per-token limit (20) is below the per-member limit (30), one photographed QR cannot use up its owner's quota on its own. `public.yaml` got an additive clarification of the rate-limit paragraph.

2. **Suspended members got an avatar link that always fails (findings 2 and 5, low).** The new `MemberProfileService.ownAvatarUrl(auth, status, fileId)` returns null unless the member's status is non-suspended. Both GET /me (`Profile.avatar_url`) and GET /me/card (`MemberCard.avatar_url`) use it now. Previously they returned a signed link that the file access rules always reject for a suspended viewer, so it returned 404. The stored `avatar_file_id` is untouched, so the photo comes back after unsuspend. `me.yaml` got additive description clarifications. I chose null rather than changing the core file access rules, because those are core-owned.

3. **Expiry reminders could be stale (finding 4, low).** In `expiry-reminders.service.ts` the job still selects candidates first, but each one is now re-checked inside its own notification transaction (`deliverIfStillDue`). It locks the users row and then the alumni row FOR SHARE, the same order the membership kernel uses, so it cannot deadlock with renewal approval, suspend, disable or account deletion. It then checks the current data again:
   - the account is still an active alumni account and not suspended;
   - `expires_at` is still the same period (millisecond range);
   - the reminder window and "no renewal proof awaiting review" condition still hold.

   If any of these fails, the notice is skipped. The pre-filter that skips already-notified members is unchanged; it only saves work.

On contracts, only descriptions changed, with no schema change. The CHANGELOG has a new note under the C2 section. One test run hit flaky admin and worker-package timeouts while the machine was heavily loaded; the full suite then ran clean at turbo concurrency 1.

## AC coverage
- [covered] AC F06-4 (finding 1/3: per-number quota keyed on token owner): card-verify.e2e.test.ts 'AC F06-4: token sah milik anggota lain yang dikirim dengan nomor korban tidak menghabiskan kuota nomor korban': 30 attacker tokens sent with the victim's number all return 200 invalid_token, then the victim's genuine QR returns 200 active; the attacker's own number returns 429 RATE_LIMITED. A single photographed victim token hits 429 on the per-token limit while a fresh victim token still verifies active. Failed on the old code with 'expected 429 to be 200'. The existing F06-4 test (garbage tokens, per-token, per-member, per-IP) still passes.
- [covered] AC F05-4 / PRD 5.4 (finding 2/5: suspended avatar_url): card-verify.e2e.test.ts 'AC F05-4, PRD 5.4: anggota suspended → avatar_url null ...': the avatar URL opens 200 before suspend. While suspended, GET /me/card returns status_label suspended with avatar_url null, and GET /me (schema-validated) returns avatar_file_id kept with avatar_url null. After unsuspend the card URL opens 200 again. Failed on the old code.
- [covered] AC F07-5 / PRD 5.1 (finding 4: stale reminders): expiry-reminders.e2e.test.ts has 2 new tests that inject the change between the candidate query and the first notify transaction. (a) renewal approved, suspended, or renewal proof sent: none of the three get a reminder, the unchanged control gets exactly 1, and the renewed period later gets its own reminder with the new dedup key. (b) Expired notice: renewal approved or account disabled means no notice; the control gets 1. Both failed on the old code ({reminders:4} and {expiredNotices:3}). pg/membership.pg.test.ts adds a real-PostgreSQL test: an in-flight renewal approval holding users NO KEY UPDATE and alumni UPDATE makes the job wait (lock wait observed) and then send no reminder. It failed on the old code (no lock wait). The existing PG test with 4 concurrent runs still passes.
- [covered] All previously covered ACs (F05-1..6, F06-1..3, F07-1..5, F10-4, F12-3..5, F15-1, F15-4, F16-4, F17-1): The full API suite passes 466/466 (was 462) and the PG lane 71/71 (was 70), so the builder's AC tests are unchanged and green.

## Verification
- pass `pnpm build`: 10/10 tasks.
- pass `pnpm typecheck`: 15/15 tasks.
- pass `pnpm lint`: 9/9 tasks successful (the 2 known contracts no-ambiguous-paths warnings).
- pass `pnpm test`: Two runs with default turbo concurrency each had a timing-only failure in files this fix does not touch: apps/admin src/flow.test.tsx (a different test each time, 75s and 137s file durations) and once api test/core/worker-package.e2e.test.ts, while the machine was heavily loaded. Admin alone passed 143/143 and API alone 466/466. 'pnpm test --concurrency=1' then passed 15/15 tasks: API 466/466, admin 143/143, database 23, storage 33, config 23, shared 16, web 5.
- pass `pnpm --filter @kapdh/api test:pg`: 11 files, 71/71 (was 70); exit code 0. The known embedded-postgres 'done is not a function' teardown message still prints.
- pass `pnpm contracts:lint`: Exit 0, API description valid, the 2 known no-ambiguous-paths warnings, events valid.
- pass `pnpm format:check`: All matched files use Prettier code style.
- pass `pnpm contracts:test-dart`: Extra run, because contract descriptions changed. Exit 0: the Dart SDK passes analyze and its tests.
- pass `New tests run against the old code (service changes stashed, git stash push/pop)`: Proof the tests catch the bugs: all 4 new PGlite tests and the new PG test fail on the old code and pass with the fix.

## Contract changes
- packages/contracts/openapi/domains/public.yaml (owned by api-membership): verifyKta rate-limit description clarified (additive, description only). The per-number quota counts against the member who owns the token (claim sub), not the member_number in the body, and the per-token limit is below the per-number limit.
- packages/contracts/openapi/domains/me.yaml (owned by api-membership): Profile.avatar_url and MemberCard.avatar_url descriptions now say the value is always null while the member is suspended (additive, description only; schema unchanged).
- packages/contracts/CHANGELOG.md: a note for both clarifications under the C2 Membership section.

## Shared changes
- kapdh-platform/apps/api/test/pg/membership.pg.test.ts (PG lane directory, file created by this slice): 1 new real-PostgreSQL test for the expiry-reminder re-check under the kernel's lock order. The lane infrastructure is unchanged.

## Open issues
- Findings 1 and 3 are the same defect (KTA per-number quota keyed on the body's member_number), fixed once. Findings 2 and 5 are the same defect (suspended avatar_url), fixed once. No finding was rejected.
- Still possible after the fix: someone holding two or more genuine QR tokens of the same member (for example several photographs taken at different times) can still use up that member's 30/min quota. The fix narrows the attack to tokens issued to the victim. The values (60/20/30 per minute) remain 'Usulan' pending D1 sign-off.
- The suspended-avatar fix is null-on-suspend in this slice. If product wants suspended members to keep seeing their own photo, core-api would need an owner-scoped exception in the file access rules for the owner's own avatar (core-owned, not changed here).
- The expiry job now takes users then alumni FOR SHARE per candidate inside short transactions. This follows the kernel lock order (users → alumni). Other slices that lock alumni and then users would break that rule anyway.
- Builder open issues still stand: admin-members lives in modules/membership; the moderation slice should reuse appeals.ts; the member.password_reset_initiated handler is owned by MembershipJobsModule; no notification.created handler exists yet; auth must accept admin-initiated password_reset challenges; product should confirm whether the admin password reset also revokes device push tokens.

## Handoff notes
Fix commit 0aa5ffe on branch worktree-wf_b8bd7d01-232-3, on top of the builder's 697213c.

Changed files (kapdh-platform/apps/api):
- src/modules/membership/kta-verify.service.ts: `KTA_VERIFY_LIMITS.perNumber` was renamed to `perMember`. The bucket key is now `kta-verify-member:<sub>`, consumed right after step 1 (`qr.inspect`).
- src/modules/membership/member-profile.service.ts: new `ownAvatarUrl(auth, status, fileId, db?)`, which returns null unless the status is non-suspended. `me()` uses it.
- src/modules/membership/member-card.service.ts: `cardOf` uses `ownAvatarUrl`.
- src/modules/membership/expiry-reminders.service.ts: `sweep(eligible, prefilter, message)`. The `eligible` condition (window, plus no pending renewal proof for reminders) is checked again for each candidate in `deliverIfStillDue`. It locks users FOR SHARE (filtered to active alumni), then alumni FOR SHARE (not suspended, same expires_at within a 1 ms range, eligible), then calls NotificationService.notify. Dedup keys are unchanged.

Tests:
- test/membership/card-verify.e2e.test.ts: 2 new tests.
- test/membership/expiry-reminders.e2e.test.ts: 2 new tests, plus the helpers `isolateFromEarlierMembers()` and `serviceWithGapBeforeFirstNotify(gap)`. The helper overlays `transaction` on `Object.create(t.db)` to inject a change between candidate selection and notify.
- test/pg/membership.pg.test.ts: 1 new test.

Client note: when GET /me or GET /me/card returns avatar_url null for a suspended member, show initials, and the offline card cache should not keep the old photo URL.
