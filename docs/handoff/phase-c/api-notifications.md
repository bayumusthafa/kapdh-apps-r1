# Phase C slice: api-notifications

Final report after build, adversarial review (4 findings) and fixes (commit a04c3a4).

## Summary
I checked all 4 findings. All were real and are fixed, each with a regression test. An earlier fixer session had done most of the code before it hit its session limit (commits fe0b310, 72554a5, 32e6949). I re-verified that work, did two mutation checks, finished the contract wording, fixed formatting and added one small hardening. The full verification is green.

**Finding 1 (high, AC F13-5): fixed.** `NotificationDeliveryService.begin()` now runs a short transaction for each delivery right before the provider call:
- It locks the device token FOR SHARE, using the same lock order (token, then delivery) as logout, registerDevice, unregister, the device sweep and record.
- It locks the delivery row FOR UPDATE, requiring `status='pending' AND attempt=<claimed>`.
- It re-applies the claim's target rules: token not revoked and still owned by the recipient, preference on, recipient available.

Effects:
- A logout, unregister, token move or preference change that commits after the batch claim cancels the queued row without sending it.
- Only an attempt already running at the provider can still get through.
- record() now marks a row `sent` if the provider accepted it, even when it was cancelled during that same attempt. Admin history no longer shows 'cancelled' for a push that was actually sent.

**Finding 2 (medium, duplicate sends after the lease expires): fixed.** begin() extends the lease for each delivery (now + 5 min) just before sending. A row whose batch lease ran out while waiting in the queue can be claimed again by another worker, which bumps attempt. The first worker then sees the attempt no longer matches and skips the row (new `skipped` count in the summary). Each push is sent exactly once.

**Finding 3 (medium, timeout didn't abort the send): fixed.** withProviderTimeout now passes an AbortSignal and aborts it when the timeout fires.
- SmtpMailer.send opens and holds its own SMTPConnection, with dns/connection/greeting/socket timeouts all under 60 s. Larger values in SMTP_URL can't loosen these. On abort it closes the connection before the end of DATA, so the server never accepts the message.
- The Message-ID is stable per delivery (`dedupKey`).
- FcmPushSender aborts both the OAuth and the messages:send fetch, including reading the response body.
- MemoryMailer and FakePush honour the signal.
- I corrected the contract and CHANGELOG wording: the abort is what prevents duplicates, not the timeout by itself.

**Finding 4 (low, English validation messages): fixed.** New validation.ts helpers (`strictBody`, `queryText`, `uuidList`) give Indonesian messages for every notifications and admin-notifications body and query, including `error_class=`, `topic=`, `all:"true"`, the `ids` type, unknown keys and non-object bodies.

**Changes in this session:**
- Ran prettier on 10 files.
- Added wording to notifications.yaml (registerDevice) and admin-notifications.yaml (deliveries list and retry) and the CHANGELOG.
- SmtpMailer now keeps its 'error' listener attached with `on` instead of `once`, so a later error during teardown can't become an unhandled 'error' event that crashes the process.

**Mutation checks:**
- With the begin() re-check bypassed, all 5 batch-race tests failed (pushes after logout, after the token moved, after the token was renewed, after the preference was turned off, and 40 pushes instead of 32 in the expired-lease case).
- With the abort disabled, the 3 abort tests failed (the pure policy test, the MemoryMailer e2e and the mock SMTP server e2e).
- Both mutations were reverted.

## AC coverage
- [covered] AC F13-5 (logout/account switch: device stops receiving the old account's notifications), finding 1: test/notifications/delivery-race.e2e.test.ts covers four cases. 'AC F13-5: logout saat batch klaim sedang dikirim …' (logout during a batch) asserts startedAfterLogout = [], at most 4 pushes in flight, and the rest cancelled/token_revoked. 'AC F13-5: token berpindah akun selama batch berjalan …' (token moves account) asserts token_reassigned. 'AC F13-1: token FCM perangkat diperbarui …' (token renewed) asserts the remaining pushes go to the new token. 'AC F13-2: preferensi kategori dimatikan …' (preference off) asserts preference_disabled. On real PG17, test/pg/notifications.pg.test.ts 'AC F13-5: logout (API, kapdh_app) saat worker mengirim batch …' passes. All 5 race tests fail when the re-check is bypassed.
- [covered] AC F13-1 / PRD 5.1 (retries never duplicate inbox rows or sends), finding 2: delivery-race.e2e 'AC F13-1: lease klaim habis selagi baris menunggu giliran …' (lease expires while rows wait): 32 pushes, 6 slow rounds of 59 s, then 4 held while a second worker runs. Exactly 32 unique pushes; first worker {claimed 32, sent 28, skipped 4}; second worker {claimed 4, sent 4}. pg 'AC F13-1: provider lambat, lease klaim habis selama batch …' passes on real PG17. Earlier tests (delivery.e2e AC F13-1, F13-6 dedup) still pass.
- [covered] AC F13-4 (UNREGISTERED revokes the token; 429/5xx/timeout retried with backoff, no duplicates), finding 3: delivery-policy.test.ts checks the timeout aborts the signal with ProviderTimeoutError. delivery-race.e2e 'AC F13-4: email yang macet melewati batas waktu DIBATALKAN …' (stalled email): the held send is aborted and the retry delivers exactly 1 message with the same dedupKey. smtp-provider.e2e.test.ts runs against a local mock SMTP server: abort before the end of DATA closes the connection and the server never accepts the message; an already-aborted signal opens no connection; a lost reply after DATA is retried with the same Message-ID; greeting and DATA stalls are bounded by SMTP_SEND_TIMEOUTS; full processor run: first attempt times out, retry accepted exactly once. fcm-provider.e2e covers a stalled body being cut off and the caller's abort cutting off messages:send. Earlier FCM error-class and backoff tests still pass.
- [covered] ARCHITECTURE §2.9 / PRD 5.2 (Indonesian field_errors), finding 4: admin-notifications.e2e asserts 'Wajib diisi bila dikirim' for error_class= and topic=, and 'Harus berupa daftar id'. inbox.e2e asserts 'Wajib true atau false' for all:"true" and 'Harus berupa daftar id'. preferences.e2e and devices.e2e cover unknown keys and non-object bodies; support.ts checks no English zod messages remain.
- [covered] AC F13-2, F13-3, F13-6 and admin authz (unchanged from builder): All earlier builder tests still pass: inbox/preferences/devices/admin-notifications/access-contract e2e. AC F13-6 is only partly in this slice: reminder scheduling belongs to the events and membership slices (see open_issues).

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 tasks, re-run after the contract description edits
- pass `pnpm typecheck`: 15/15 tasks
- pass `pnpm lint`: 9/9 tasks; contracts show only the 2 known no-ambiguous-paths warnings (files)
- pass `pnpm test --concurrency=1`: 15/15 tasks. API: 42 files, 522 tests passed (505 at builder report). Admin: 143 passed. With default turbo concurrency the admin package failed 1-2 flow tests at ~5-6 s timeouts, a different test on each run; machine CPU was at 90-100% from other agents. No admin files were changed. Admin also passed 143/143 alone with --testTimeout=120000, and with --concurrency=1.
- pass `pnpm --filter @kapdh/api test:pg`: 11 files, 74 tests passed (including the 2 new batch tests on real PG17), exit=0. Teardown prints the known embedded-postgres 'done is not a function'.
- pass `pnpm contracts:lint`: Valid; 2 known warnings; 17 realtime event schemas valid
- pass `pnpm format:check`: All matched files use Prettier code style (10 files were reformatted first)
- pass `Mutation: begin() bypassed (MUTANT=1) -> vitest delivery-race.e2e`: All 5 batch-race regression tests failed as expected (e.g. 4 pushes after logout; 40 pushes instead of 32). Reverted.
- pass `Mutation: withProviderTimeout without controller.abort -> delivery-race/smtp-provider/delivery-policy tests`: 3 abort tests failed as expected (policy, MemoryMailer e2e, mock SMTP server e2e). Reverted.

## Contract changes
- notifications.yaml registerDevice description (additive): the push target rule (token not revoked and owned by the recipient) is checked again for each delivery right before the provider call, not only at batch claim. A revocation that commits before a delivery's turn always prevents that delivery. Only an attempt already running at the provider (at most 60 s) can get through; if the provider accepts it, it is recorded as sent.
- admin-notifications.yaml adminListNotificationDeliveries description (additive): each provider attempt is limited to 60 s and is aborted when the limit is reached (SMTP connection closed before the end of DATA, FCM request cut off). It is recorded as timeout/NETWORK and retried. Email uses a stable Message-ID per delivery and push uses collapse key = notification id. adminRetryNotificationDeliveries: the worker re-checks token ownership at claim and again right before the provider call.
- packages/contracts/CHANGELOG.md, section 'api-notifications: implementasi F-13': bullets for the abort-on-timeout behaviour and the per-delivery re-check. No operation, field or schema was added, renamed or removed.

## Shared changes
- apps/api/src/core/adapters/mailer.ts (core, additive):
- MailMessage.dedupKey (stable Message-ID).
- Mailer.send(message, options?: {signal}). SmtpMailer.send now holds its own SMTPConnection: SMTP_SEND_TIMEOUTS dns 10 s, connection 15 s, greeting 10 s, socket 20 s, capped even when SMTP_URL sets larger values. It closes the connection on abort and keeps its error listener attached with `on`.
- MemoryMailer: aborted[] and holdNext().
sendOtp is unchanged.
- apps/api/src/core/adapters/push.ts (core, additive): PushSender.send(message, options?: {signal}). FcmPushSender aborts the OAuth and messages:send fetch, including reading the response body, on timeout or caller abort, and the result is a retryable network error.

## Open issues
- AC F13-6, the scheduling side (H-3/H-1 event reminders, 30-day expiry reminder, cancelling stale schedules), belongs to the events and membership slices. This slice only guarantees that notify dedup and delivery scheduling never duplicate inbox rows or sends.
- Remaining accepted window for AC F13-5, now much narrower than the builder's open issue: only an attempt already running at the provider when a logout or token move commits can still be delivered (at most 60 s, usually under 1 s). It is then recorded honestly as sent. Closing it fully would mean holding a row lock across the network call.
- Minor: when a claim lease expires and another worker claims the row again, attempt goes up even though the row was never sent. Under very slow providers this uses up part of the 6 automatic attempts; an admin retry still gives one more. The attempt count is still needed as the ownership check, so I left it as is.
- maintenance.cleanup (admin slice) should still revoke an expired family's tokens before deleting its session rows. The hourly notifications.device-sweep also covers tokens left with session_id null.
- Proposed for the integrator: add notifications.device-sweep (every 1 h) to the ARCHITECTURE §4.8 job table.
- The admin package's flow tests are timing-sensitive: they hit 5 s timeouts when the machine is overloaded and turbo runs api and admin tests in parallel. This is not caused by this slice.

## Handoff notes
Code is in kapdh-platform/apps/api/src/modules/notifications.

Delivery pipeline:
1. Claim: a batch is taken with SKIP LOCKED, attempt+1, and a 5-minute lease.
2. begin(), once per item right before the provider call, in a short transaction:
   - lock the token FOR SHARE, then the delivery FOR UPDATE with `status='pending' AND attempt=<claim>`;
   - apply the same target rules as the claim;
   - extend the lease.
   - Possible results: send, cancelled (reason stored), or skipped (the claim moved to another worker).
3. sendOne(): calls the provider under withProviderTimeout(60 s). The AbortSignal is passed to Mailer.send and PushSender.send.
4. record(): writes the result with the same ownership check. If the provider accepted it but the row was cancelled during the same attempt, it is written as sent.

DeliveryRunSummary has a new `skipped` count.

Lock order everywhere is device_tokens first, then notification_deliveries.

Any new Mailer or PushSender implementation must honour `options.signal` by actually closing its connection, not just stopping waiting.

Tests:
- test/notifications/delivery-race.e2e.test.ts (PGlite): batch races, lease expiry, email abort.
- test/notifications/smtp-provider.e2e.test.ts: SmtpMailer against a local mock SMTP server.
- test/pg/notifications.pg.test.ts: describe 'Batch klaim yang dikirim bergiliran' on real PG17.

Commits on the branch after the builder's a6f3c87: fe0b310, 72554a5, 32e6949 (earlier fixer session); 0c044f3 and 7f45c4f (this session's wip); a04c3a4 (final fix commit, empty, because everything was already checkpointed).
