# Phase C slice: api-account

Final report after build, adversarial review (8 findings) and fixes (commit 9914d07dbc60062c657793596ca64125ec7e5279).

## Summary
I checked all 8 review findings for the api-account slice (F-14). Seven were real and are fixed. Each fix has a test, and I confirmed each new test fails on the old code and passes on the new code. The eighth (the Mailer change) was only partly right. The fixes are in three commits on top of a3438b8 (2c2e286, ffe8194, 9914d07). Every required check passed on the final code.

**What was fixed:**
1. **Old web deletion challenge revealed whether an email is registered** (findings 1 and 3, the same issue). Starting a second challenge cancelled the first one for a real account, but not for a decoy, so verifying the first challenge returned 410 for a registered email and 400 for an unknown one.
   - Decoys now follow the same rule: a new challenge (or a resend) for the same email cancels the previous one.
   - The latest decoy per email is tracked under an HMAC of the email, never the plain address. In Redis the pointer is swapped atomically.
   - File: web-deletion-decoys.ts.
2. **POST /auth/otp/resend revealed whether an email is registered** (finding 2). A real deletion challenge got 200, a decoy got 410.
   - Fixed without editing any api-auth file. A new global interceptor in the account module (deletion-decoy-otp.interceptor.ts) watches only POST /api/v1/auth/otp/resend and /auth/otp/status.
   - The auth handler still runs first, so its rate limits and lookups are the same for real and decoy challenges. Only its 410 answer for an id carrying the decoy HMAC tag is replaced with the decoy answer.
   - If api-auth later calls resendIfDecoy itself, the interceptor simply does nothing.
3. **A stalled deletion worker could overwrite a finished deletion** (finding 4).
   - The `attempts` value from the claim now acts as an ownership token.
   - Every step transaction first checks that it still owns the claim and renews the 15-minute lease. Because that check comes first, the job always locks account_deletions before users, events and rooms.
   - Recording a finished step, saving the job's ledger copy, and marking the request completed or failed only succeed while the run still owns the claim.
   - The same check runs right before each email and each write to the external deletion ledger.
   - A run that lost its claim stops with the new outcome `claim_lost` and writes nothing more.
   - The external ledger can no longer be downgraded from completed to requested, and its file keys are merged rather than replaced (`writeLedgerEntryMonotonic`).
   - Limit: an email that was already in flight when the worker stalled still goes out. At most one duplicate "request received" email is possible, and never after the completion email.
4. **Free text written by the member survived deletion** (finding 5).
   - The finance step now clears tickets.cancel_reason when the member cancelled the ticket themselves.
   - It also clears payments.cancel_reason when payment_events shows the owner cancelled the payment.
   - Reasons written by the system or by board members are kept.
5. **Audit snapshots kept identity numbers** (finding 6). redactAuditSnapshot now keeps numbers only under an allow-list of keys (version, counts, quantities, days, amounts). Cohort, class_in/class_out and member_seq are dropped.
6. **The new group admin did not get their promotion on their own channel** (finding 7). The `role_changed` event now goes to room:<id> (excluding the new admin) and to user:<new admin>, so each socket receives it exactly once.
7. **Mailer interface change** (finding 8, partly rejected).
   - The claim that it was undeclared is wrong: the builder report already listed it in shared_changes.
   - The non-breaking suggestion is applied anyway: `sendTransactional` is now optional, and the job treats a missing method as an email-step failure.

**Tests added:**
- 3 in web-deletion.e2e.test.ts:
  - verify and resend side by side for a registered and an unregistered email
  - the full resend sequence through POST /auth/otp/resend: wait-period 429, then 200, then 410 for the old id
  - a direct test of the interceptor, including the status route
- 4 in deletion-job.e2e.test.ts:
  - a worker that stalls while sending email loses its claim
  - a worker that loses its claim between steps stops at its next step
  - the monotonic ledger write
  - identity numbers are dropped from audit snapshots
- **Test data and checks extended:**
  - The fully populated test member now also has a ticket cancelled by the member, a payment cancelled by its owner (both with the member's own text), and an identity-correction audit row. The full-deletion check expectFullyDeleted now covers all three.
  - The realtime test now checks the role_changed channels.

## AC coverage
- [covered] AC F14-1 (identity verified, confirm -> one deletion job, deletion_pending, sessions/sockets revoked, request number shown): Unchanged builder coverage (account-deletion.e2e.test.ts, web-deletion.e2e.test.ts, PG17 two-device test); all still pass
- [covered] AC F14-2 (failure mid-step, retry continues steps_done without touching other users or recounting): Existing coverage: per-step failure injection over all 16 steps, storage and email failures. New tests in deletion-job.e2e.test.ts: a worker stalled past its lease during an email ends claim_lost while the takeover worker completes; attempts=2, exactly one account.deletion_completed audit, no email after the completion email. A claim lost between steps stops at the next step's transaction. Both new tests fail on the pre-fix code.
- [covered] AC F14-3 (credentials, profile, device tokens, uploads, chat content deleted or placeholder): expectFullyDeleted plus the every-table personal-data scan. Fixture extended with the member's own cancellation texts, which the scan now flags before deletion and finds nothing after (tickets added to the pre-deletion hit list).
- [covered] AC F14-4 (financial history keeps amount/date/status/reference, no identity snapshot): expectFullyDeleted asserts tickets.cancel_reason null for the member-cancelled ticket (cancelled_by self kept) and payments.cancel_reason null for owner-cancelled payments, and that the identity-correction audit row has before/after {} and reason null. New redaction unit test 'AC F14-4: angka identitas ... dibuang'. The pre-fix code fails these.
- [covered] AC F14-5 (last group admin -> transfer to eligible member or close group): Realtime test now asserts role_changed is sent to room:<transfer> excluding user:<peer>, and to user:<peer> (contract events/README rule); fails on pre-fix code
- [covered] AC F14-6 (restore of pre-deletion backup -> ledger re-applied): Existing two restore tests plus the PG17 CLI test still pass. New test: writeLedgerEntryMonotonic never downgrades completed to requested and unions object_keys. The stalled-worker test checks the external ledger keeps all 9 deleted object keys.
- [covered] PRD 2.5 non-enumeration of the web deletion flow (challenge, verify, resend, status): web-deletion.e2e.test.ts: 'challenge kedua ... identik' (verify/resend of the cancelled first id gives the same answer for registered and unregistered emails); 'POST /auth/otp/resend ... identik' (429 -> 200 -> 410 -> 429 -> 410 -> 400 sequence equal for both, only the real account receives a code); interceptor unit test for the /auth/otp/status route and pass-through cases. The first two fail on the pre-fix code.
- [covered] Decorators match contract x-kapdh-access for every account operation: Unchanged 'Dekorator akses vs kontrak' test still passes

## Verification
- pass `pnpm build`: 10/10 tasks
- pass `pnpm typecheck`: 15/15 tasks (includes apps/api tsconfig.test.json)
- pass `pnpm lint`: 9/9 tasks; only the 2 known Redocly warnings
- pass `pnpm test`: 15/15 tasks, exit 0. A separate run of pnpm --filter @kapdh/api test: 34 files, 464 tests (was 457, +7 new)
- pass `pnpm --filter @kapdh/api test:pg`: 11 files, 70 tests, exit 0. The known embedded-postgres teardown message 'done is not a function' still prints.
- pass `pnpm contracts:lint`: API description valid with the 2 known warnings; 17 event schemas valid
- pass `pnpm format:check`: All matched files use Prettier code style
- pass `Negative checks (new tests run against the pre-fix code via temporary stash/edit, then restored)`: Every new test fails on the old code: decoy cancellation, resend 410 vs 200, claim_lost in both stall tests, cancel_reason, audit redaction, role_changed channels. All pass after the fixes.

## Contract changes


## Shared changes
- kapdh-platform/apps/api/src/core/adapters/mailer.ts (core): Mailer.sendTransactional is now OPTIONAL (`sendTransactional?(mail)`), so other Mailer implementations stay valid. SmtpMailer, DevLogMailer and MemoryMailer still implement it. The deletion job treats a missing method as an email-step failure (retried, then skipped after 3 failures).
- Behaviour change on api-auth routes, no api-auth file edited: AccountModule registers a global APP_INTERCEPTOR (apps/api/src/modules/account/deletion-decoy-otp.interceptor.ts). It acts only on POST /api/v1/auth/otp/resend and /api/v1/auth/otp/status. If the auth handler answers 410 OTP_EXPIRED for a challenge_id carrying the web-deletion decoy HMAC tag, that answer is replaced by WebDeletionDecoys.resendIfDecoy / statusIfDecoy. All other ids, routes and errors pass through untouched. The route keys include the 'api/v1' global prefix from bootstrap.ts; web-deletion.e2e.test.ts fails if the prefix changes.
- New exported union member in apps/api/src/modules/account/deletion-processor.ts: DeletionRunResult { outcome: 'claim_lost', requestNumber, step }. DeletionLedgerService.reapply already treats any outcome other than 'completed' as a failure.

## Open issues
- Partly rejected, finding 8 (mailer.ts 'core file changed without being declared as a shared change'): the claim is not true; the builder report listed the Mailer.sendTransactional change in shared_changes. The non-breaking suggestion was applied anyway (method made optional).
- Finding 3 is a duplicate of finding 1 (same decoy-cancellation flaw); both are fixed by the same change and covered by the same tests.
- api-auth (remaining timing channel, PRD 2.5): AuthService.resendOtp awaits SMTP (issueOtp -> await mailer.sendOtp) for a real deletion challenge, while a decoy resend answers without SMTP. Status codes and response bodies are now identical; response time is not. Suggest api-auth sends 'deletion'-purpose resend OTPs in the background, as WebDeletionService.startChallenge does.
- api-auth: when getOtpChallengeStatus (POST /auth/otp/status) is implemented, apply any per-IP limit before the otp_codes lookup. The interceptor then inherits that limit for decoys automatically. api-auth may also call WebDeletionDecoys.resendIfDecoy/statusIfDecoy directly; the interceptor then becomes a no-op and can be removed.
- Fencing limit (AC F14-2): an email already handed to SMTP before a worker stalled past its 15-minute lease cannot be recalled. At most one duplicate 'request received' email is possible, never after the completion email. A run that lost its claim starts no new send, ledger write or DB write.
- Carried over from the builder report, still open: the restore runbook (Phase E) must run account:ledger-reapply before the service opens; product owner to confirm that board-written reasons (rejection_reason, adjustment reasons, resolution_note, admin-written payment/ticket cancel reasons) stay as business records; client work (Astro /delete-account, Flutter deletion screens).

## Handoff notes
**Fix commits** on worktree-wf_b8bd7d01-232-10, on top of builder commit a3438b8; working tree clean:
- 2c2e286: decoy cancellation rule and the /auth/otp interceptor
- ffe8194: claim ownership token for the deletion job, monotonic external ledger, optional Mailer.sendTransactional
- 9914d07: cancel_reason clearing, numeric allow-list in audit redaction, role_changed sent to the new admin's user channel

**Deletion job ownership (DeletionSteps.fence and DeletionSteps.tx):**
- Every job transaction must be opened with `this.tx(ctx, fn)`, not `this.db.transaction`.
- `this.tx` first runs an UPDATE on account_deletions that checks id, status 'processing' and attempts equal to the claimed value, and renews the lease. A mismatch throws DeletionClaimLostError, so the transaction rolls back and the run returns 'claim_lost'.
- markDone, saveLedger, complete and fail use the same ownership predicate.
- Emails (sendMail) and external ledger writes (writeLedgerEntryMonotonic) call fence(this.db, ctx) immediately beforehand.
- Lock order inside the job: account_deletions -> users -> events -> tickets -> payments; account_deletions -> rooms for chat. No chat transaction touches account_deletions, so taking it first does not break the C6 rooms-first rule among chat tables (documented in leaveRoom).

**Decoy cancellation rule:** DecoyChallengeStore has a new swapLatest(emailKey, id, ttl). The memory store uses a map; the Redis store uses an atomic Lua GET+SET PX on key kapdh:decoy:e:<HMAC>. WebDeletionDecoys.issue() marks the previous latest decoy as cancelled.

**Finance step:** clears tickets.cancel_reason where cancelled_by='self', and payments.cancel_reason where payment_events has kind 'cancelled' with actor_user_id equal to the user. This must run before the audit step, which nulls that actor; the step order guarantees it.

**Test helpers:**
- createRichMember now also returns payments.ownerCancelled, payments.ticketSelfCancelled, tickets.selfCancelled, events.selfCancelled and auditIds.identityCorrection.
- personalTerms includes 'Budi sakit' and 'Budi ulang'.
- The PG lane test uses the same helpers and passes.
