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
  - New test `test/admin/queue-consistency.e2e.test.ts`: for the same caller, dashboard payments = the payments
    summary endpoint = total of `stage=awaiting_review&overdue=true`, moderation/badge = `/admin/reports` counts (linked
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

## 7. admin-events

No textual conflicts; `pnpm-lock.yaml` auto-merged (`@zxing/browser` 0.2.1 and `@zxing/library` 0.23.0 for the
camera scanner) and `pnpm install` left it unchanged. `flow.test.tsx` (foundation) only gained a longer wait for the
heavier lazily loaded check-in page. Verified after the merge: admin typecheck, lint and build, `@kapdh/admin` test
31 files 355/355. Integration fix in a follow-up commit:

- `apps/admin/src/api/mocks/content.ts` + `mocks/events.ts` (dev:mock banner targets). admin-content's banner target
  picker searches `GET /admin/events`, which only the events mock serves, but the content mock validated and resolved
  event targets against its own private three-event map. After both merged, an admin with `events.manage` who picked
  any event from the list got "Event tujuan tidak ditemukan." on save. Each side wanted to keep its own fixtures
  (content tests use `CONTENT_IDS.event*`, events tests use `MOCK_EVENT_IDS`). Chosen: events mock exports a read-only
  `peekEventForMocks(id)` (title, status, category ref from its own categories); content's new `eventTarget(id)`
  checks its own map first, then the events mock, for both `validateTarget` and `bannerTarget`. The availability rule
  (open or closed) is unchanged. New test `banners.test.tsx` "AC F08-2: event dipilih dari daftar event admin (area
  events) ...": failed before the fix (no success toast), passes after.
- New guard `apps/admin/src/api/mocks/routes.test.ts`: the mock router answers with the FIRST matching route in
  alphabetical file order, which is how the content/events event-category collision the two slices warned about would
  have hidden one side. The test fails when two area mocks register the same method + path template or when any route
  is shadowed by one loaded earlier (checked by adding a temporary duplicate file: both assertions failed and named
  both files). Passes on the merged tree. (Review follow-up, section 9: the guard now reads the router's own table
  instead of a copy of its loading logic.)

## 8. admin-governance

### Conflicts

- `pnpm-lock.yaml` / `apps/admin/package.json` (`@fontsource/poppins`): public-web pinned 5.3.0 for the site,
  admin-governance pinned 5.2.7 for the admin (both to stop loading Google Fonts). Chosen: one version, 5.3.0, for
  both apps (same OFL-1.1 package, no dependencies or install scripts, ships the same `400/500/600/700.css` entry
  points that `apps/admin/src/main.tsx` imports), so the monorepo bundles one Poppins build. Took the lockfile from
  `HEAD` and re-ran `pnpm install`; the only lockfile change is the admin importer entry. `index-html.test.ts`
  (governance) still passes: it checks the `@fontsource/poppins/<weight>.css` imports, not the version.

### Semantic integration

- `apps/admin/src/routes/dashboard/dashboard.test.tsx`: three tests encoded the payments mock as it was on the
  governance branch's base (no paid payments; Siti's payment `…a1` at proof version 1). admin-payments' final mock
  (merged earlier) has four paid fixtures (Rp210.000 gross: two Rp75.000 tickets, a Rp50.000 ticket approved after
  its event was cancelled, a Rp10.000 renewal) and gives Siti a rejected proof v1 plus a replacement v2 (AC F03-3).
  The dashboard mock already sums every paid payment of the payments mock plus its own history, which is the
  contract rule ("jumlah bruto seluruh payment paid, sebelum penyesuaian/refund"), so the displayed Rp505.224 is
  right. Kept each test's intent and adjusted only its setup/expectations: the totals are named constants with their
  derivation (Rp505.224, and Rp565.224 after the test approves Siti's Rp60.000), and the approve step reads the
  payment's current `proof_version`/`version` from `GET /admin/payments/{id}` instead of assuming 1. (Review
  follow-up, section 9: the named constants were replaced by totals derived from the payments mock.)
- Contract addition `GET /admin/reports/{reportId}/subject-candidates` (admin-moderation.yaml, owned by
  api-moderation) and its CHANGELOG subsection merged cleanly (subsection kept after the api-admin one, before
  `## 0.2.0`). `contracts:lint` valid (the 2 known warnings), contracts test 39/39, `contracts:test-dart` passes.
- `mocks/dashboard.ts` reads the payments mock through its exported `routes` (no route of its own under
  `/admin/payments*`); the new mock-router guard confirms no collisions across the 14 area mocks.
- Verified after the merge: `pnpm build` 10/10, admin typecheck and lint, `@kapdh/admin` test 41 files 459/459.

### Integration blockers the slice handed over (fixed in follow-up commits)

- **API `GET /admin/reports/{reportId}/subject-candidates`** (`apps/api/src/modules/moderation`). The contract
  operation merged without a server, which broke the merged tree: the moderation access test
  (`test/moderation/admin-queue.e2e.test.ts`, every moderation operation has exactly one handler with matching
  `x-kapdh-access`) failed with `adminListReportSubjectCandidates` missing (checked by running the pre-fix test
  against the merged contract), and in production every group report could only be dismissed. admin-governance
  wanted the list as the only way to pick `subject_user_id`; api-moderation owns the rules it must follow. Chosen:
  implemented in `AdminReportsService.subjectCandidates` with api-moderation's own rules rather than new ones:
  `everJoinedRoom` (the predicate `validateDecision` uses), deleted accounts and the caller's linked alumni left out,
  `ModerationVisibility.isReportedParty` → 404, reporter conflict → 403 (same checks and order as `resolve`), not an
  active group report → 400 `VALIDATION_ERROR`; ordering group admins, joined members, former members, then
  `lower(full_name)` with the byte-wise `~<~` comparison the network directory uses, keyset cursor bound to `q`;
  items built with the module's `toTargetMember`. The read and its `moderation.report_viewed` audit (via
  `subject_candidates`, counts only, no member ids) run in one transaction before the response; refusals write no
  audit, as for detail. Controller: admin audience, permissions `moderation.read` + `moderation.resolve`. Tests (`admin-reports.e2e.test.ts`, 3 new): membership/role/order and exclusions, a
  listed former member accepted by `resolve`, audit without the list; `q` by name and member-number prefix, paging,
  cursor bound to `q`, 101-char `q` → 400; 404/403/400/permission cases with no audit. The access test lists the
  new operation. CHANGELOG subsection updated (no longer "belum diimplementasikan").
- **Dashboard "Lewat batas review" link** (`apps/admin/src/routes/payments/{routes.tsx,VerificationTab.tsx}`,
  `routes/dashboard/DashboardPage.tsx`). admin-dashboard.yaml requires the overdue row to open
  `/payments?stage=awaiting_review&overdue=true` with the same count; the payments page (admin-payments) accepted
  only `tab`, `payment`, `adjustment`, so governance linked to `?tab=verify` and explained the badges instead.
  Chosen: additive `stage`/`overdue` search params on `/payments` (validated like the others; unknown values
  ignored) that initialise the verification queue's filters; a new "Batas review" select (Semua / Lewat batas review
  / Belum lewat batas) shown for the "Menunggu" status sends adminListPayments' `overdue` filter, which the payments
  mock already implements; a user change of status or this filter drops the link params from the URL. The dashboard
  row now carries "Lihat yang lewat batas" to exactly `/payments?stage=awaiting_review&overdue=true`; the existing
  "Buka antrean verifikasi" footer link (`?tab=verify`) and its test are unchanged. Tests: dashboard "F-15, AC
  F15-1: 'Lihat yang lewat batas' ..." (href, navigation, the list request filters, "Menampilkan N dari N" with N =
  the card's value) and payments "F-15: ?stage=awaiting_review&overdue=true ..." (first request already filtered,
  N = summary `overdue_count`, switching back, `on_time`, and the filter hidden and not sent for other statuses).
- `docs/ARCHITECTURE.md` §7 listed `/invite/$token`; the contract and both slices use `/invite#t=<token>` (token in
  the fragment, never sent to a server). The route list now says so (governance open issue).

## 9. Review follow-up (fix round on the integrated tree)

A review of the integrated tree raised four low-severity findings. All four were checked against the code and are
real; all four are fixed. No finding was rejected.

- **Dashboard event links led to a not-found page in dev:mock** (`apps/admin/src/api/mocks/{dashboard,events}.ts`).
  This was the same cross-mock event-identity problem as the banner targets in section 7, but in the dashboard.
  admin-governance's dashboard mock had its own five events (`0199e000-…-e5..e9`, e.g. "Seminar AI untuk
  Mahasiswa"). admin-events' mock answers `GET /admin/events/{eventId}` only for `MOCK_EVENT_IDS`
  (`0199e100-…-e1..e6`, e.g. "Seminar AI untuk Alumni"). `DashboardPage` links every "Event mendatang" and
  "Penjualan Tiket" row to `/events/$eventId`, so in dev:mock each link opened a 404 detail page. The governance
  side wanted dashboard-shaped data (ticket sales, upcoming events, tickets sold). The events side owns the events
  and the seat-count rules (the read projection: expired holds are not counted as held). Chosen: the events mock
  exports a read-only `peekEventStatsForMocks()`. It returns each event's id, title, status, schedule, location and
  its paid, held, available, awaiting-review and checked-in counts, computed with the same `seatCounts` and
  `projectedStatus` that its list and detail use. The dashboard mock builds `events` and `upcoming_events` from it
  and applies the admin-dashboard.yaml rules itself:
  - "Tiket Terjual" counts paid tickets in all events.
  - "Penjualan Tiket" lists every event except drafts, ordered by `starts_at` descending, at most 10.
  - "Event mendatang" lists open or closed events that start within the next 30 days, ordered by `starts_at`
    ascending, at most 10.

  The dashboard's own event fixtures are removed. The historical sample transactions keep their `event_title` text,
  which is not linked. New test in `dashboard.test.tsx`, "F-15: setiap tautan event di dasbor menunjuk event yang
  dikenal area Event dan membuka detailnya". For every `/events/<id>` link in both sections, it checks that the
  events mock knows the id and that the title matches. It then clicks the first link and checks for the event
  detail `h1` and the URL. Before the fix it failed on the first row ("Mancing Bareng Alumni (0199e000-…-e5):
  expected undefined"); it passes after. The existing tests keep their intent, with event names taken from the events
  mock (`mockEvents.event(MOCK_EVENT_IDS.seminar).title`) instead of the old dashboard titles:
  - The super-admin test sees the seminar as a link under "Event mendatang", and the cancelled Pramuka event is not
    listed there.
  - The cancelled event is listed under "Penjualan Tiket", and the draft Mancing event is not.
  - The check-in-only admin sees the seminar title without a link.

- **Hard-coded "Total Transaksi" totals** (`apps/admin/src/routes/dashboard/dashboard.test.tsx`). Section 8 had
  made `PAID_TOTAL = "Rp505.224"` and `PAID_TOTAL_AFTER_APPROVE = "Rp565.224"` named constants. Any change to an
  admin-payments fixture would have broken three dashboard tests that do not own that data. Chosen: the test
  derives the total from the contract rule (gross of all paid payments). The rule is
  `sum(GET /admin/payments?status=paid&limit=100 amounts) + sum(mockDashboard.historicalTransactions())`, using
  BigInt cents. The test asserts that the list has a single page, is not empty and contains only `paid` payments,
  then formats the total with `formatRupiah`. `mockDashboard.historicalTransactions()` is a new read-only accessor
  for the dashboard's legacy sample. The approval test also keeps its "total grows" intent explicitly: after it
  approves Siti's payment, the gross equals the gross before approval plus that payment's `amount`. "Tiket Terjual"
  is derived the same way, as the sum of `paid_quantity` over `GET /admin/events`, instead of the literal `"333"`.
- **Router guard copied the router's loading logic** (`apps/admin/src/api/mocks/{index,routes.test}.ts`). The guard
  repeated `index.ts`'s `import.meta.glob` patterns and its alphabetical sort. If the router changed, the guard
  would have kept checking the old order. Chosen: `index.ts` now builds and exports `mockRouteTable` (each compiled
  route with its source file, in match order) and `matchMockRoute(method, path)`. `mockFetch` uses the same
  function. The guard imports both, so it checks the exact table and matcher that dev:mock uses. It also gained two
  checks:
  - no test file or router helper is loaded as an area;
  - every route matches its own sample path, so a route that can never be reached is reported even when no other
    route wins.

  I confirmed it still catches collisions: a temporary `aaa-probe.ts` with `GET /admin/dashboard` and
  `GET /admin/events/{anything}` made both the duplicate check and the shadowing check fail, and both failures named
  the two files. The probe was then deleted.

- **Duplicated deleted-account label** (`apps/admin/src/routes/events/{labels.ts,CheckinPage.tsx,EventTicketsTab.tsx}`).
  The events area defined its own `ANONYMOUS_HOLDER = "Akun dihapus"`, while payments, dashboard, moderation and
  notifications use `DELETED_ACCOUNT_LABEL` from `lib/labels.ts`. Chosen: `ANONYMOUS_HOLDER` is removed, and the
  check-in page and ticket tab import `DELETED_ACCOUNT_LABEL`. The rendered text is unchanged and the events and
  check-in tests pass unchanged.

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

## Final verification (final tree, after the section 9 review follow-up)

Run from `kapdh-platform` on the tree with the section 9 fixes (the follow-up commit on top of `0b63b12`). Every
result below was observed in this round. The test run used `--force`, so no turbo cache was replayed.

| Command                                            | Result                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                                       | pass, 10/10 tasks                                                                                                                          |
| `pnpm typecheck`                                   | pass, 16/16 tasks                                                                                                                          |
| `pnpm lint`                                        | pass, 9/9 tasks (only the 2 known redocly `no-ambiguous-paths` warnings)                                                                   |
| `pnpm exec turbo run test --concurrency=1 --force` | pass, 16/16 tasks: api 109 files 1351, admin 41 files 463, web 169, worker 54, contracts 39, config 24, storage 33, database 23, shared 16 |
| `pnpm --filter @kapdh/api test:pg`                 | pass, 23 files, 153 tests (exit 0)                                                                                                         |
| `pnpm contracts:lint`                              | pass, valid (2 known warnings); event schemas valid                                                                                        |
| `pnpm contracts:test-dart`                         | pass, analyze clean and fixture tests pass                                                                                                 |
| `pnpm format:check`                                | pass                                                                                                                                       |
| `pnpm --filter @kapdh/worker test:pg` (extra)      | pass, 3 files, 11 tests (exit 0)                                                                                                           |

Admin went from 461 to 463 tests: the new dashboard event-link test and the router guard's new check that test files
and router helpers are not loaded as areas. Both PG lanes print `TypeError: done is not a function` from
`embedded-postgres@17.6.0-beta.15` (`dist/index.js:349`) after the summary, while the embedded server shuts down.
All tests have passed by then and the exit code is 0. None of the follow-up changes touch the API, the worker or
their test harness.

## Still open after this track (carried from the slice reports, not integration conflicts)

- Ops/infra: `infra/Dockerfile.worker` never built as an image and `infra/nginx-web.conf` never run through
  `nginx -t` (no Docker/nginx on this machine); BullMQ Lua paths not exercised against a real Redis (staging smoke
  test: enqueue/dedup, stalled jobs, backpressure across instances).
- `test/core/worker-package.e2e.test.ts` has a 30 s timeout that the worker slice saw flake under heavy load (it
  passed in every run here).
- The PG lanes (api, worker) print `TypeError: done is not a function` from `embedded-postgres@17.6.0-beta.15` while
  shutting down. It appears after all tests pass and the exit code is 0. Worth checking when that pre-release
  dependency is next upgraded.
- Product decisions: admin-events allows ticket-price changes behind a confirmation (contract `adminUpdateEvent`)
  instead of the task text's price lock; check-in scanner lists only events whose window opens within 24 h.
- Admin UI gaps: D13 `adminRecordPayment` has no screen; `nav.ts` labels `/payments` "Verifikasi Pembayaran" for a
  settings-only admin; `ROUTE_ACCESS` lets members.manage-only admins open member pages that then show Forbidden;
  no deep link to a single payment from members/events; precondition 400s show the default toast next to the page
  notice; admin-payments reads `conflict_of_interest` through one extra payment-detail request (an additive field
  on `AdminPaymentAdjustment` would remove it); the post conflict notice cannot name the last editor (no
  `updated_by` on `AdminPost`).
- Client evidence for the admin and web slices runs against mocks (PRD 7.3); end-to-end runs against the merged
  API are still to do.

# Phase C integration record

## Track: mobile

Integrator worktree branch `worktree-wf_6321bb4f-ec1-2`, branched from `main` at `fe5482d` (schema, contracts, core
and every Phase C API slice already merged). The five Flutter slice branches were merged one at a time with
`git merge --no-ff` in the order below. After each merge the tree was checked with `flutter.bat analyze` and the full
`flutter.bat test` before continuing. All five branches touch only `kapdh-mobile/**`, and `main` had no
`kapdh-mobile` commits after their common base `7a0be1e`. So the only conflicts were between the mobile slices.

| # | Branch | Slice | Merge commit | Integration fix commit | Tests after (all passed) |
| - | ------ | ----- | ------------ | ---------------------- | ------------------------ |
| 0 | `main` | baseline | `fe5482d` | | 309 |
| 1 | `worktree-wf_2dfc8f13-ce6-13` | mobile-onboarding-payments-kta | `13fcc54` (clean) | | 441 |
| 2 | `worktree-wf_2dfc8f13-ce6-14` | mobile-home-news-events | `8e472ee` | `3f41c32` (test harness) | 533 |
| 3 | `worktree-wf_2dfc8f13-ce6-15` | mobile-network-chat | `030593d` | | 659 |
| 4 | `worktree-wf_43c6809b-584-6` | mobile-account-notifications | `a85ba44` | `e725d71` (AppScaffold back) | 778 |
| 5 | `worktree-wf_43c6809b-584-7` | mobile-auth-recovery | `d7f240e` | | 871 |

Merge 2 initially had 1 failing test (532 passed), and merge 4 had 1 failing test (777 passed). Both failures are
explained in "Integration breakages" below. The test counts are the sum of the slices' own reports: 309 baseline plus
132, 92, 126, 119 and 93 new tests.

`pubspec.yaml`/`pubspec.lock` changed only on mobile-onboarding-payments-kta: `flutter_cache_manager` became a direct
dependency at the version that was already locked. No other branch touched them, so no lockfile resolution was needed.
`flutter.bat pub get` was run after each merge.

### Conflict resolutions

#### 1. `kapdh-mobile/lib/core/session/session_controller.dart` (merge 2)

- **onboarding-payments-kta** imported `core/cache/kta_avatar_cache.dart`: `ktaCacheStoreProvider` passes an
  `onClear` hook that empties the KTA photo cache.
- **home-news-events** imported `core/cache/home_cache_store.dart`. `_wipePrivateData` and the account-switch branch
  of `_acceptMe` now clear the Home cache.
- **Chosen:** both imports. Only the import lines conflicted, and each side's wipe calls merged cleanly. Logout,
  session revoke, failed restore and account switch now clear the KTA card, the KTA photo, the Home cache, the /me
  snapshot and the idempotency keys (PRD 5.2, AC F05-3, AC F08-4).

#### 2. Route matrix in `kapdh-mobile/lib/app/redirect.dart` and `kapdh-mobile/test/app/redirect_test.dart` (merges 3 and 4)

Each slice added its own route group or permission to the `_allowed` matrix, and the conflicts were all in the
`expired` and `suspended` entries.

- **home-news-events:** new `RouteGroup.eventDetail` (`/events/:id`), allowed for expired. Contract C5 `getEvent` is
  `nonsuspended`, so an expired member can still open the event detail of a ticket they hold.
- **network-chat:** new `RouteGroup.accountReports` (`/account/reports`). It is in `_memberBase` and also allowed for
  suspended, because moderation.yaml `listMyReports`/`getMyReport` are `member_access: any`. `/account/blocked`
  stays `accountCommunity`, for active members only.
- **account-notifications:** suspended members may open `RouteGroup.notifications` (contract C7 `member_access: any`,
  AC F13-2). `/notifications/<id>` (the push-tap gate) is mapped to the same group.
- **Chosen:** the union.
  - expired = `_memberBase` (now including `accountReports`) + `renewal` + `tickets` + `eventDetail`.
  - suspended = `restricted` + `accountReports` + `accountDelete` + `notifications`.
  - The expected matrix in `redirect_test.dart` is the same union.
  - The suspended test keeps both sides' assertions: `/account/reports` allowed, `/account/blocked` redirected,
    `/notifications` allowed, `/account/notifications` and `/network/members/...` redirected. It is now named for
    both permissions.
- **Untouched by the merges:**
  - onboarding-payments-kta removed `renewal` from `isMutationOnlyRoute`.
  - account-notifications made `deletionStatus` reachable anonymously and readable during maintenance.
  - auth-recovery allows challenge links (`/forgot/otp?challenge=`) while signed in and from splash.

  All three are in separate parts of the file, merged cleanly, and keep their tests.

#### 3. `kapdh-mobile/lib/features/auth/login_screen.dart` (merge 5)

- **account-notifications (owner of the status portals, F-14):** for login results `deletion_pending` and
  `account_disabled` (no session, contract C1), the screen no longer shows an inline `_RestrictedAccountNotice`.
  Instead it calls `deletionPortalProvider.showLoginResult(result, email:)` and goes to `/deletion-status`. That portal
  works without a session and offers the OTP status re-check and support contacts. Its tests (`login_screen_test`
  'akun deletion_pending: portal status penghapusan tanpa sesi', 'Akun tidak aktif' → `/deletion-status`) expect this.
- **auth-recovery:** left the inline notice from the base unchanged and added the following:
  - the one-time `LoginNotice` from recovery flows;
  - the email field pre-filled from `authEmailHintProvider`;
  - in-memory activation credentials for the unknown-outcome OTP recovery;
  - the underlined 48 px `_ForgotPasswordLink` (guideline p5);
  - the cooldown hint "Sambil menunggu… Lupa Password" (PRD 2.5).
- **Chosen:** all of auth-recovery's additions, with account-notifications' portal handoff in place of the inline
  notice. `_restricted`, `_RestrictedAccountNotice` and the `SupportSection` import are removed, because the portal
  now does that job.
  - The portal receives the `email` captured before the await (auth-recovery's pattern) instead of re-reading the
    text field.
  - auth-recovery's OTP-screen login check originally kept showing "Status akun berubah. Masuk kembali untuk melihat
    statusnya." for those outcomes. The review found that this costs the user an extra login. It is now handed to
    the same portal; see review fix G below.
  - Every test from both sides passes.

### Integration breakages (tests that encoded an assumption another slice invalidated)

#### A. KTA 200 % test left a pending Timer once Home became a real screen (after merge 2), fix `3f41c32`

**Symptom.** `kta_screen_test` 'N-11: teks 200 % pada KTA yang tidak dapat tampil offline…' failed every run with
"A Timer is still pending even after the widget tree was disposed". The stack ran from
`ConsumerStatefulElement.unmount` to Riverpod `_DefaultVsync.scheduleDispose`.

**Cause.**
- That test calls `pumpApp` three times in one test.
- `pumpApp` pumped `UncontrolledProviderScope(container: …)` without a key, so Flutter updated the existing scope
  element instead of mounting a new one.
- The second and third containers therefore never got the scope's Flutter vsync, and Riverpod fell back to a
  zero-duration `Timer` for autoDispose cleanup.
- Before merge 2, Home was a placeholder. After it, `HomeScreen` (the autoDispose `HomeController`) stays mounted in
  the shell's indexed stack. Tearing the tree down then scheduled that Timer after the test ended.

**Chosen fix.** In `test/support/app_harness.dart`, `pumpApp` now keys the scope with `ObjectKey(container)`, so each
call mounts a fresh scope that has its own vsync. The test keeps its original intent: three cache situations in one
test at 200 % text. Its assertions are unchanged.

#### B. Expired member's app-bar back from a deep-linked event detail showed the forbidden event list (after merge 4), fix `e725d71`

**What each side wanted.**
- **account-notifications** changed `AppScaffold._back` from `GoRouter.pop()` to `routerDelegate.popRoute()`, so the
  app-bar arrow respects a page's `PopScope` the way the system back button does. That protects the "Buang
  perubahan?" guard (PRD 4.5). Tests: `layout_states_test` 'AppScaffold: panah kembali menghormati PopScope…' and the
  profile-edit back test.
- **home-news-events**, `events_test` 'AC F09-7 anggota expired membuka deep link event dibatalkan…': back from
  `/events/event-1` must land on the status home route (`/renewal`) with no GET `/events`. The event list is
  active-only (PRD 2.2).

**Why it broke.** `GoRouter.pop()` also calls `restore(currentConfiguration)`, which re-runs the redirect.
`routerDelegate.popRoute()` does not. So after the change the member landed on `/events`.

**Chosen fix.** `_back` still uses `popRoute()`. When the pop really closed a page (the delegate's configuration object
changed), it then calls `router.restore(newConfiguration)`, the same as `GoRouter.pop()`. When `PopScope` blocks the
pop, the configuration is unchanged and nothing is restored, so the guard dialog stays put. Both sides' tests pass and
no test was changed. After the review this rule moved into a shared helper that the system back button also uses
(review fix E).

### Review fixes (after the integration review)

An integration review of `74884c9` reported six findings. All six were checked against the merged tree and all six
were real. Each fix below keeps both slices' behaviour and tests. The new tests for C, for E (the `events_test`
system-back test) and for G were also run against the unfixed code, with the old file put back temporarily. All of
them failed there, so they cover the gap they were written for.

#### C. Home bell and quick-access tile used a second, stale unread counter (home-news-events vs account-notifications)

- **home-news-events** showed `quick_access.unread_notification_count` from GET /home on the Home bell and on the
  "Notifikasi" quick-access tile.
- **account-notifications** built `notificationUnreadCountProvider` as the single unread counter. Realtime
  `notification.created`, the inbox, mark-read and mark-all-read update it, and so do realtime reconnect and app
  resume. Its handoff says the Home bell should use this provider, not a second counter.
- **What went wrong after the merge.** Home stays mounted in the shell's indexed stack, and nothing updated its GET
  /home number. After "Tandai semua dibaca" in the inbox and "Kembali", the Akun badge showed 0 while Home still
  showed "3 belum dibaca".
- **Chosen:** one counter.
  - `home_screen.dart`: the bell and the quick-access tile watch `notificationUnreadCountProvider`. The GET /home
    number is used only while the provider is still null, for example offline with the Home cache.
  - The gated Home (unverified and expired, no GET /home) now also shows the shared count. Contract C7
    `getNotificationUnreadCount` is `member_access: any`.
  - `home_controller.dart`: after a successful network GET /home, the controller passes the server's number to the
    provider with `set()`, so a pull-to-refresh on Home also updates the Akun badge. Numbers from the Home cache are
    never used for this.
- **Tests** (`home_screen_test`):
  - bell, mark all read, back: Home is cleared and GET /home is not called again;
  - a realtime `notification.created` raises the Home bell;
  - an expired member sees the shared count without GET /home.

  All existing Home tests pass unchanged.

#### D. Two providers for the same `notification.created` stream (onboarding-payments-kta vs account-notifications)

- **What each side had.**
  - onboarding-payments-kta defined `realtimeNotificationsProvider`; KTA and payment refresh listen to it.
  - account-notifications defined `notificationCreatedEventsProvider`; the badge and the inbox listen to it.
  - The two provider bodies were identical. Tests replaced one provider or the other, so a fake event never reached
    both consumers.
  - The "became connected" detection was also written five times: in the payments slice, the unread counter, the two
    chat-list controllers (badge and room list) and the chat room controller.
- **Chosen:**
  - `notificationCreatedEventsProvider` is the only source of `notification.created`. `paymentUpdatesProvider` is now
    built from it, `realtimeNotificationsProvider` is removed, and the KTA, payments and payment-detail tests override
    `notificationCreatedEventsProvider` instead. All their test streams were already broadcast streams, so two
    listeners on one stream work. This replaces the advice in `phase-c/mobile-onboarding-payments-kta.md` to override
    `realtimeNotificationsProvider`.
  - The connection-transition detection now lives once, in `lib/core/realtime/connection_transitions.dart`:
    - `listenConnectedTransitions` is synchronous, so it keeps the exact timing of the four controllers that had
      their own listener: the unread counter, the chat badge, the chat room list and the chat room.
    - `connectedTransitions` is the stream form, used by `realtimeReconnectedProvider`.
- **Tests:**
  - The `connectedTransitions` tests moved to `test/core/connection_transitions_test.dart`, which also gets a test for
    the synchronous form.
  - `payment_updates_test` checks that only payment and membership notifications pass the filter.
  - New `payment_detail_screen_test` 'F-13, ARCHITECTURE §4.9: satu event notification.created…': one fake event
    makes the payment reload and sets the badge to the event's `unread_count`.

#### E. System back skipped the route matrix (home-news-events vs account-notifications, completes fix B)

- **Problem.** Fix B re-runs the redirect only for the app-bar arrow. The Android back button goes through the
  router's `RootBackButtonDispatcher` and calls `routerDelegate.popRoute()`, so it still did not re-run the redirect.
  An expired member who deep-linked to an event detail landed on `/renewal` with the arrow but on `/events` with
  system back. Before this fix that was listed as an open issue.
- **Chosen.** New file `lib/core/ui/back_navigation.dart`:
  - `popThenRedirect(router, pop)` holds the rule from fix B: after a pop that really closed a page, call
    `router.restore(newConfiguration)`. A pop blocked by `PopScope`, or one that only closed a dialog or sheet,
    leaves the configuration unchanged and nothing is restored.
  - `RedirectingBackButtonDispatcher` is a `RootBackButtonDispatcher` that applies `popThenRedirect` around its
    normal callback.
  - `redirectingRouterConfig(router)` builds the router config with that dispatcher. `routerConfigProvider`
    (router.dart) provides it and `KapdhApp` uses it. Delegate, parser and route-information provider are still
    GoRouter's own.
  - `AppScaffold._back` keeps `routerDelegate.popRoute()` and calls the same helper, so the two back paths share one
    rule. It also still works under a plain GoRouter config, as in `layout_states_test`.
- **Tests:**
  - New `events_test` 'AC F09-7, PRD 2.2: tombol kembali sistem…' (`tester.binding.handlePopRoute()` lands on
    `/renewal` without GET `/events`). The original arrow test now shares its setup with this one and has the same
    assertions as before.
  - New `test/core/back_navigation_test.dart`:
    - redirect after a page closes;
    - a base route that is still allowed stays the destination;
    - `PopScope` keeps the page and runs no redirect;
    - a dialog closes without a redirect.
  - The existing system-back tests in `forgot_password_flow_test` and `otp_screen_test` (PopScope while busy) pass
    unchanged.

#### F. Reservation-to-payment tests never loaded the payment (home-news-events vs onboarding-payments-kta)

- **Problem.** The events and tickets tests were written while `/payments/:id` was still a placeholder. After the
  merge it is onboarding-payments-kta's real `PaymentDetailScreen`, which calls GET `/me/payments/{id}`.
  - The tests stubbed nothing for that call, so the harness answered 404 and the payment screen showed a not-found
    error.
  - The tests passed anyway, because they only checked the location.
- **Chosen.**
  - New fixture `ticketPaymentDetailJson` in `event_fixtures.dart`: a full `PaymentDetail` of type ticket, waiting for
    its first proof.
  - `events_test` 'PRD 3.9 event berbayar…' (reserve, then payment) and `tickets_test` 'D5 reservasi menunggu bukti…'
    ("Bayar Sekarang", then payment) stub `/me/payments/payment-9`. They now also check that:
    - no error state is shown;
    - the ticket title is shown;
    - the hold deadline "Kirim bukti sebelum 13 Okt 2026, 14.00 WIB" is shown;
    - proof upload is enabled (`ProofUploadSection.onPick` is not null).
  - The original assertions are unchanged.

#### G. OTP recovery login dropped the deletion/disabled result (auth-recovery vs account-notifications)

- **Problem.** With credentials in memory, the OTP screen checks an unknown outcome by logging in. When that login
  answered `deletion_pending` or `account_disabled`, the screen did not pass the result on:
  - it showed a generic `LoginNotice`;
  - it sent the user to `/login` to enter the password again;
  - the portal's request number and completion estimate were lost.
- **Chosen.** `otp_screen.dart` now does what `login_screen.dart` does:
  - calls `deletionPortalProvider.showLoginResult(result, email: account.email)`;
  - clears the activation credentials (the password leaves memory);
  - keeps the email hint, so the login screen is pre-filled if the user goes there later;
  - goes to `/deletion-status` and ends the OTP flow (`clearFlow`).

  `/deletion-status` is allowed for anonymous sessions, so the redirect keeps the portal.
- **Tests:** two new `otp_screen_test` cases.
  - `deletion_pending`: the portal shows the request number and estimate, with one login request, no session, no
    challenge and no credentials in memory.
  - `account_disabled`: the "Akun tidak aktif" portal.

#### H. Verification wording

The previous verification table said the regenerated Dart SDK proved "the committed SDK is current". The generated
sources in `packages/contracts/dart/kapdh_api/lib/src/` are gitignored (`kapdh-platform/.gitignore:13`), and none of
them is tracked. The table below now says that the generated, gitignored SDK on disk matches the current contracts.

### Open issues (mobile track, for Phase D)

- **Status changes on open pushed routes (foundation router).** Both back paths now re-run the redirect when a page
  closes (fixes B and E). One case reported by home-news-events is still open: a pushed page that is already open is
  not re-checked when the member's status changes while it is showing. The screen's own 403 handling still applies
  (MEMBERSHIP_REQUIRED, `/me` reload, redirect).
  - Predictive back is not enabled: there is no `enableOnBackInvokedCallback` in the Android manifest and no
    `PredictiveBackPageTransitionsBuilder`. If it is enabled later, the gesture's commit path must also go through
    `RedirectingBackButtonDispatcher`.
- **Restricted portal has no "Laporan Saya" link.** network-chat reported that suspended members can reach
  `/account/reports` only through notification deep links. account-notifications added the `AppealSection` (create an
  appeal and see its status) and a "Notifikasi" entry to the restricted portal, which covers the appeal flow. A
  visible link to `/account/reports` is still a product decision for the portal owner.
- **Event participant avatars are cached on disk.** onboarding-payments-kta noted that `RemoteImage` (public content
  plus event participant avatars) uses the default `cached_network_image` disk cache (30 days, not cleared on logout).
  After integration, directory and chat avatars use `Image.network` (memory only), and the member's own KTA photo uses
  the dedicated `KtaAvatarCache`. Whether participant avatars should move to a cache that is cleared on logout is for
  the Phase D privacy audit.
- **Pre-existing formatting.** `lib/app/theme/kapdh_tokens.dart` is still reported by `dart format
  --set-exit-if-changed`. It was unformatted on `main` before Phase C and none of these merges touched it. Every file
  changed during integration is formatted.
- The slices' own open issues are listed in their `docs/handoff/phase-c/mobile-*.md` reports and are unchanged by the
  integration. The one exception is home-news-events' "'Tiket Saya' row in the Akun menu", which is now present:
  account-notifications' `account_screen.dart` has a "Tiket saya" tile.

### Verification (final tree)

The integrator session was interrupted after the notes commit `df23f70`. The resumed session re-ran the whole final
verification on that tree before closing the track. Checks performed at that point:

- `main` was still at `fe5482d`, so the branch did not need re-basing or a new merge from `main`.
- All five slice branch tips are ancestors of `HEAD`:
  - `326f106` (ce6-13)
  - `1ffaf3c` (ce6-14)
  - `64d6322` (ce6-15)
  - `202be20` (584-6)
  - `8df3c4c` (584-7)
- `git diff main..HEAD` outside `kapdh-mobile/**` touches only this document.
- The working tree was clean after the build and every check.

That run found no new breakage. These are its results, on tree `df23f70`, before the review:

| Command | Result |
| ------- | ------ |
| `kapdh-platform: pnpm install` | pass ("Already up to date") |
| `kapdh-platform: pnpm build --force` | pass (10/10 tasks, 0 cached). The contracts build regenerated the Dart SDK in `packages/contracts/dart/kapdh_api/lib/src`: 38 files, 0 written, 0 deleted. So the generated SDK on disk, which is gitignored and not committed, matches the current contracts. |
| `kapdh-platform: pnpm typecheck` | pass (15/15 tasks). No platform files changed in this track; run as an extra check. |
| `kapdh-platform: pnpm test` | not run. No mobile branch touches `kapdh-platform`, and the platform tree is identical to `main`. |
| `kapdh-mobile: flutter.bat pub get` | pass |
| `kapdh-mobile: flutter.bat analyze` | pass ("No issues found!") |
| `kapdh-mobile: flutter.bat test` | pass (871 tests, "All tests passed!") |
| `kapdh-mobile: dart.bat format --output=none --set-exit-if-changed lib test` | Only the pre-existing `lib/app/theme/kapdh_tokens.dart` is reported (exit 1). It is unchanged from `main`. |

#### After the review fixes (C to H)

The full verification was run again on the tree with fixes C to H. Checks repeated first:

- `main` is still at `fe5482d`.
- The five slice tips listed above are still ancestors of `HEAD`.
- Outside `kapdh-mobile/**`, the fixes change only this document. `kapdh-platform` is still identical to `main`.

| Command | Result |
| ------- | ------ |
| `kapdh-platform: pnpm install` | pass ("Already up to date", lockfile unchanged) |
| `kapdh-platform: pnpm build` | pass (10/10 tasks, all from cache) |
| `kapdh-platform: pnpm build --force` | pass (10/10 tasks, 0 cached). The contracts build printed "38 berkas (0 ditulis, 0 dihapus)", so the generated, gitignored SDK on disk matches the contracts. No tracked file changed. |
| `kapdh-platform: pnpm typecheck` / `pnpm test` | not run. No platform file changed. |
| `kapdh-mobile: flutter.bat pub get` | pass ("Got dependencies!") |
| `kapdh-mobile: flutter.bat analyze` | pass ("No issues found!") |
| `kapdh-mobile: flutter.bat test` | pass (884 tests, "All tests passed!"). That is 871 plus 13 new: 3 Home, 1 payment detail, 4 back navigation, 1 events system back, 2 OTP, 1 synchronous connection-transition test and 1 payment-update derivation test. The 2 existing `connectedTransitions` tests moved from `payment_updates_test` to `connection_transitions_test`. |
| `kapdh-mobile: dart.bat format --output=none --set-exit-if-changed lib test` | Only the pre-existing `lib/app/theme/kapdh_tokens.dart` is reported (exit 1). Every file changed by the review fixes is formatted. |
