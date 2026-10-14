# Phase C integration: platform track

Integrator report for merging the Phase C platform branches into `main` (on top of the API slices auth, admin-auth,
membership, payments, content, network, chat, moderation, account, events and notifications that were already on
`main`). Branches were merged one at a time with `git merge --no-ff`, in this order:

| #   | Branch                      | Slice            |
| --- | --------------------------- | ---------------- |
| 1   | worktree-wf_b8bd7d01-232-11 | api-admin        |
| 2   | worktree-wf_b8bd7d01-232-12 | worker           |
| 3   | worktree-wf_2dfc8f13-ce6-7  | public-web       |
| 4   | worktree-wf_2dfc8f13-ce6-8  | admin-payments   |
| 5   | worktree-wf_2dfc8f13-ce6-9  | admin-members    |
| 6   | worktree-wf_2dfc8f13-ce6-10 | admin-content    |
| 7   | worktree-wf_2dfc8f13-ce6-11 | admin-events     |
| 8   | worktree-wf_2dfc8f13-ce6-12 | admin-governance |

Every non-trivial resolution is listed below: the file, what each side wanted, what was chosen and why.

## 1. api-admin

### Conflicts

- `apps/api/src/core/adapters/mailer.ts`
  - main (notifications, membership, account): `send(message: MailMessage, options?: {signal}) -> Promise<MailSendResult>`
    is REQUIRED (the F-13 delivery processor needs the abort signal, the Message-ID and SMTP error classes);
    `sendOtp(..., OtpMailOptions)`; optional `sendTransactional(TransactionalMail)`. MailMessage has `html?` and
    `dedupKey?`.
  - api-admin: an OPTIONAL `send?(MailMessage): Promise<void>` for its outbox handlers (admin invitation, security
    notices), made optional only so that other Mailer implementations keep compiling; `MemoryMailer.lastMessage(to)`;
    `DevLogMailer.send` prints the body so the invitation link is usable in development without SMTP.
  - Chosen: main's unified interface (required `send` with options and result). It already serves api-admin's callers:
    `AdminMailJob.deliver()` calls `this.mailer.send(message)` and ignores the result. The api-admin guard is kept as a
    runtime check (a cast test double without `send` still makes the handler fail clearly so the outbox retries), and
    its test (`jobs.e2e` "Mailer tanpa jalur transaksional") now builds the legacy double with a cast, because a
    `Mailer` without `send` no longer type-checks. `MemoryMailer` is main's (sent/mail/messages/aborted/holdNext/
    failNext/messagesTo) plus api-admin's `lastMessage(to)`. One `DevLogMailer.send` returning `{messageId: null}`
    that prints subject, recipient AND the text body (development only; main.ts and the worker refuse this mailer
    outside development, same policy as the OTP code it already prints), so admin invitation links work without SMTP.
    The duplicated `MailMessage` declaration was merged into main's (doc updated to cover F-16 mail).
- `apps/api/src/core/db/locks.ts`: both sides added `ADVISORY_LOCK_NAMESPACES` value `47_110_003` (main: `otpDecoy`,
  auth slice; api-admin: `auditExport`). Both kept; `otpDecoy` keeps 47_110_003 (already shipped with the auth
  migration's tests), `auditExport` moved to **47_110_004**. All usages reference the constant
  (`audit-export.job.ts`, `test/pg/admin-governance.pg.test.ts`), so no other change was needed.
- `apps/api/src/core/files/files.service.ts`: main split access policies into `defaultPolicies` / `modulePolicies` /
  `replacedDefaults` (`registerAccessPolicy(..., {replaceDefaults})`, chat AC F11-4); api-admin had the older single
  `policies` map and added `accessHooks` + `registerAccessHook(purpose, hook)` + `storeGenerated({tx})` +
  `deleteStoredObject`. Union: main's three policy collections plus api-admin's `accessHooks`; `accessFor` evaluates
  the main policy model and then runs the hooks before signing the URL (already auto-merged that way).
- `apps/api/src/core/outbox/topics.ts`: `admin.security_notice.kind` union of main's `activated`,
  `backup_codes_regenerated` (admin-auth) and api-admin's `email_changed`. Since api-admin's `AdminMailJob` is the
  single handler of the topic (JobRegistry rejects duplicate handlers) and its template table is a
  `Record<kind, ...>`, templates for `activated` and `backup_codes_regenerated` were added in
  `modules/admin/admin-mail.ts`, so every kind admin-auth publishes is actually emailed.
- `packages/contracts/CHANGELOG.md`: both sections kept (api-notifications, then Fase C api-admin).

### Semantic integration

- Invitation link: main's core already had `adminInviteLink()` (core/identity/crypto.ts, used by the bootstrap CLI);
  api-admin had its own `adminInvitationLink()`. Both produce `${ADMIN_ORIGIN}/invite#t=<token>`. The admin helper
  now delegates to the core one (one source of the link form); the core one gained `encodeURIComponent` (a no-op for
  base64url tokens). api-admin's open issue about the CLI printing `/invite/<token>` was already fixed on main.
- Shared queue formulas (api-admin review finding 7, left for integration; contract admin-dashboard: "one summary
  query shared with the payments module, not a second formula"). api-admin computed dashboard/badge counts with its
  own `modules/admin/queue-rules.ts` + `business-days.ts`; main's payments, moderation and notifications slices each
  shipped their own single source (`PaymentsKernel.summary`/`reviewDueSql`, `ModerationVisibility.dashboardSummary`,
  `countActionableFailedDeliveries`). The two sets disagreed:
  - payments overdue is `review_due_at <= now` (also the `overdue=true` list filter); admin used `now > review_due_at`,
    so a payment exactly at its deadline was overdue in the queue but not on the dashboard (same for adjustments);
  - notifications `retryable` treats a recipient as available unless `disabled`/`deleted` (contract text), admin
    required `users.status = 'active'`, so failed deliveries to `deletion_pending` accounts were missing from
    `DashboardJobs.failed_delivery_count` but present in the list total;
  - payments' `addBusinessDaysSql` added `make_interval(days)` to a timestamptz, which follows DST of the database
    session time zone; admin's version did the arithmetic on Jakarta local time (its test runs with
    `America/New_York` and failed against the payments SQL across 1 Nov 2026).
  - Chosen: the domain owners' functions are the single source, admin keeps none. `payment-sql.ts` gained
    `paymentQueueDetail()` (the SAME query as `paymentQueueSummary`, plus `oldest_submitted_at` and `overdue_by_type`
    that only the dashboard needs) and `PaymentsKernel.dashboardSummary(now)`; `DashboardService` uses it,
    `ModerationVisibility.dashboardSummary` for the moderation section and `reports_open` badge, and
    `countActionableFailedDeliveries` for the jobs section. `AdminModule` imports `PaymentsJobsModule` and
    `ModerationModule`. `modules/payments/business-days.ts` `addBusinessDaysSql` now does the day arithmetic on
    Jakarta local time (results unchanged in UTC sessions); `modules/admin/business-days.ts` re-exports it so the
    admin unit/TZ tests exercise the one implementation (both formulas were proven equal: 7q + r + 2·[w+r>5] − back).
    `queue-rules.ts` keeps only `tsLiteral` and `FAILED_DELIVERY_WINDOW_MS`.
  - New test `test/admin/queue-consistency.e2e.test.ts`: for the same caller, dashboard payments = `/admin/payments/
summary` = total of `stage=awaiting_review&overdue=true`, moderation/badge = `/admin/reports` counts (linked
    alumni and joined-group exclusions), jobs = deliveries list total; data includes the boundary cases above. With
    api-admin's old formulas restored temporarily, the payments and deliveries tests failed (overdue 1 vs 3, failed
    deliveries 1 vs 2); with the unified code all pass. Existing `dashboard.e2e` expectations are unchanged.
- Admin lock order: admin-auth documents `admins → users → mfa_totp` (admin-auth.shared.ts) and api-auth requires every
  session revocation to lock `users` FOR UPDATE before touching `sessions` (auth/session-locks.ts; its report names
  "admin disable" explicitly). api-admin's `recover()` deleted `mfa_totp` before updating `users`, and
  `revokeSessions()` updated `sessions` before `users`. Fixed in `admins.service.ts`: `revokeSessions` locks `users`
  FOR UPDATE first; recovery updates users, revokes sessions, then deletes TOTP; email re-issue revokes sessions
  before deleting the pending TOTP. Behaviour and audit are unchanged (admin e2e and PG lane pass).

## 2. worker

No textual conflicts. `main` had not touched `core/jobs/**`, `worker.ts` or `packages/config` since the worker branch's
base, so the worker's shared changes (JobRunner claim/process/release split with atomic lease takeover,
`runScheduled(name, {jobId?})`, the extra `@kapdh/api/worker` exports, the four optional WorkerEnv keys) merged as
the branch had them. Checked by hand:

- `core/db/locks.ts`: the new bigint key `ADVISORY_LOCK_KEYS.workerSchedulerLeader = 4711000520` does not collide with
  `lastSuperAdmin` (…518) or `bootstrapSuperAdmin` (…519); it lives in the single-bigint key space, separate from the
  two-int4 `ADVISORY_LOCK_NAMESPACES` (`otpDecoy` 47_110_003, `auditExport` 47_110_004).
- The handoff check for the interrupted-fixer revert: `job-runner.ts` contains the `MENGAMBIL ALIH` takeover and
  `runScheduled(name, options: { jobId?: string })`.
- Scheduled jobs and outbox topics added by the Phase C API slices (api-admin `maintenance.cleanup` and the audit
  export handler, the account deletion processor, notifications delivery, content announce, events and membership
  expiry reminders) need no worker change: the worker schedules and routes whatever the `JobRegistry` holds.
- Verified after the merge: `pnpm build`, `pnpm --filter @kapdh/worker test` (9 files, 54/54), API
  `test/core/jobs.e2e.test.ts` + `test/core/worker-package.e2e.test.ts` (17/17). The whole suite and both PG lanes
  run again in the final verification.

## 3. public-web

- `pnpm-lock.yaml` (only conflict): `main` (worker, api-admin) added bullmq/msgpackr, sanitize-html and friends;
  public-web added `@kapdh/shared`, `@fontsource/poppins` 5.3.0, `@astrojs/check` and `jsdom` to the `apps/web`
  importer. Took `main`'s lockfile and re-ran `pnpm install`; the result is the union (diff against either parent
  shows only the other side's packages).
- Semantic check: every endpoint the site calls exists on the merged API with the contract's path
  (`public/deletion/{challenge,verify,confirm}` in account, `auth/otp/resend`, `public/kta/verify` in membership,
  `public/pages/{slug}` in content, `public/config`), and the site compiles against the merged contract types and
  `@kapdh/shared` error catalog. Its delete-account 409 handling relies on core idempotency sending
  `retry_after_seconds` only for "still processing", which is unchanged on `main`.
- The site self-hosts Poppins (`@fontsource/poppins`, `src/styles/global.css`), so admin-governance's open note that
  `apps/web` still loads Google Fonts is obsolete after this merge.
- Verified after the merge: `pnpm build` (10/10, CSP gate passes for 11 pages), `@kapdh/web` test 14 files 169/169,
  typecheck (astro check 0 errors + tsc) and lint.

## 4. admin-payments

No textual conflicts (all changes under `apps/admin`; the foundation `Tabs.tsx` `countLabel` and the payments mock
controls are additive). The page and its mocks type-check against the merged contracts, including main's api-payments
additions (`conflict_of_interest` on the payment detail that the adjustment panel now reads). Verified after the
merge: `pnpm build` 10/10, admin typecheck and lint, `@kapdh/admin` test 18 files 190/190.

## 5. admin-members

No textual conflicts. Foundation changes are additive (`ConfirmDialog.confirmDisabled`, `Breadcrumb.search`,
`mockAdminRole()` in the auth mock). The report's possible mock collision on `GET /admin/members` does not occur:
`mocks/members.ts` is the only mock that registers `/admin/members*` and `/admin/masters*`. Verified after the merge:
admin build, typecheck and lint; `@kapdh/admin` test 20 files 241/241 (190 + the members tests). The first full run
had one timeout in the foundation `flow.test.tsx` "keluar membersihkan seluruh cache" (the lazily loaded /payments
page under parallel load); it passed alone (25/25) and in a full re-run.

## 6. admin-content

No textual conflicts. The one cross-slice decision this slice handed to the integrator, event-category ownership, is
kept as the slice chose it: the events page owns the event-category UI (guideline p14, C4 handoff F8), so
`mocks/content.ts` registers no `/admin/content/event-categories*` route and `mocks/events.ts` (merged next) is
their only mock. `/content` manages post categories (`/admin/content/post-categories`) only. Both paths are in
`admin-content.yaml`, and the API serves them from the content module. Verified after the merge: admin typecheck,
lint and build; `@kapdh/admin` test 28 files 294/294.

## Breakages already on main before this track (fixed in a separate commit)

Found by the first full API run after merge 1; neither involves an api-admin file.

- `test/content/access.e2e.test.ts` and `test/events/access.e2e.test.ts` failed: the content slice
  (`/admin/content/event-categories`, 5 operations) and the events slice (`/admin/event-categories`, 1 operation)
  both named their controller class `AdminEventCategoriesController`, and the access tests select routes by
  `<Controller>.<method>` name, so each test saw the other's routes. The content class was renamed
  `AdminManagedEventCategoriesController` (after its operationId `adminListManagedEventCategories`) and the content
  test's controller list updated. No route, path or access metadata changed.
- PG lane `notifications.pg.test.ts` "registerDevice bersamaan dengan logout" returned 500 (deadlock 40P01) in every
  run: `DevicesService.register` locked the session row and then inserted `device_tokens` (FK check takes FOR KEY
  SHARE on `users`), while logout (auth slice, `lockOwnerForRevocation`) holds `users` FOR UPDATE and waits for that
  session row. `register` now takes `users` FOR SHARE as its first statement (the auth slice's documented order:
  owner row before session rows; SHARE is compatible with refresh rotation and conflicts with revocation), so
  register and logout serialize: 204 then revoked, or 401.
