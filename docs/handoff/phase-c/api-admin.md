# Phase C slice: api-admin

Final report after build, adversarial review (7 findings) and fixes (commit 9936d41f245dcee140c2c94ee4054095c7ac6717).

## Summary
I checked all 7 findings. I fixed 6 of them here, each with a test that fails on the old code. The 7th (shared queue formulas) is real but needs the payments and moderation slices, so it is left for integration and documented. An earlier fixer had done most of the work before it was interrupted (wip commit 9556dca). I checked that work, added the missing tests, fixed one core test it broke, and squashed everything into one commit, 9936d41 (fix(api-admin)). All required checks pass on the final tree.

Per finding:
1. (high) Invitation link. FIXED. AdminMailJob now builds the link with adminInvitationLink(), which gives `${ADMIN_ORIGIN}/invite#t=<token>` with the token in the URL fragment. Tests: jobs.e2e checks the exact link form, that the token matches the stored hash, and that the link has no `/invite/` path or `?token=` query. The invitationLink() helper in admins.e2e now rejects the old path and query forms. The topics.ts comment and the CHANGELOG were corrected.
2. (medium) Undeclared core edits. FIXED. All core edits are now listed in shared_changes. `Mailer.send` is now optional, so other Mailer implementations still compile; AdminMailJob fails clearly if it is missing, so the outbox retries and then marks the event dead instead of dropping the email. Test added in jobs.e2e.
3. (low) Two invitations racing for the same alumni. FIXED. The alumni users row is now locked FOR NO KEY UPDATE instead of FOR SHARE, so the two invitations run one after the other and the loser always gets 409 on `alumni_user_id`. New test in the Postgres lane (admin-governance.pg.test.ts): the test holds the row lock until both requests are waiting, then releases it. I confirmed this test fails with the old FOR SHARE lock (the 409 came back on `email`).
4. (low) Tampered list cursor. FIXED. AdminCursorSchema now checks `v` separately for each sort order, so a bad cursor gives 400 VALIDATION_ERROR on `cursor` instead of 500. admins.e2e covers 6 forged cursors and 4 valid hand-built ones.
5. (low) session.revoked sent on a permission change. FIXED. A role or permission change no longer sends session.revoked, because no session is revoked. Rights still drop on the next request, since permissions are read from the database on every request and permissions_version goes up. The realtime gateway only accepts mobile sessions, so admins have no sockets. Disabling and recovery still revoke all sessions. admins.e2e checks that disconnectUser is not called and the session stays valid.
6. (low) Downloads through the generic files path were not audited. FIXED. Core FilesService gains registerAccessHook(purpose, hook), which runs after the access policy allows and before the signed URL is created. AuditExportService registers a hook for `audit_export` that writes `audit.export.downloaded` for the export recorded in the matching `audit.export.completed` entry. An `audit_export` file with no completed entry now gets 404. The admin endpoint writes exactly one entry per access. Tests: in audit.e2e, the generic path writes one entry per access, refused access writes none, and the orphan file gets 404 (these fail with the hook switched off). The new files-access-hook.e2e checks that the hook runs only for allowed access and that a hook error blocks the URL.
7. (low) Shared queue formulas. NOT FIXED here, left for integration (see open_issues). In this worktree the payments and moderation modules are empty stubs, so their endpoints cannot be pointed at the shared formulas yet. To make integration straightforward, the CHANGELOG now lists the exported functions and spells out the business-day rules.

A core test needed adjusting: in test/files/files.e2e.test.ts, the audit_export policy test called storeGenerated directly and expected 200. Now that files without a completed entry are refused, the test first writes the `audit.export.completed` entry, as the worker does.

## AC coverage
- [covered] AC F16-1: jobs.e2e.test.ts: the invitation email link is exactly `${ADMIN_ORIGIN}/invite#t=<token>` and the token hashes to admins.invite_token_hash; there is no /invite/ path or ?token= query; adminInvitationLink() handles a trailing slash. admins.e2e invitationLink() rejects the path and query forms. admin-governance.pg.test.ts: two simultaneous invites for the same alumni give exactly one 201 and one 409 on alumni_user_id, one linked admin row, one admin login, one admin.invited audit entry. Earlier invite and alumni-separation tests still pass.
- [covered] AC F16-2: Unchanged from the builder: admins.e2e plus the Postgres-lane race tests for concurrent demote, disable and recover. Postgres lane 74/74.
- [covered] AC F16-3: admins.e2e: after permissions are revoked, the same token gets 403 on the next request, permissions_version goes up, and no session.revoked is sent (disconnectUser not called; session still valid). Disabling or recovering an admin still revokes sessions (401).
- [covered] AC F17-1: The download audit is written before the URL is issued; if the hook fails there is no URL (files-access-hook.e2e). A losing concurrent invite leaves no audit entry (Postgres lane).
- [covered] AC F17-2: audit.e2e: every access writes exactly one audit.export.downloaded entry, including GET /files/{fileId}/access (requester and Super Admin); refused access (missing audit.export, or another admin) writes none; an audit_export file with no completed entry gets 404. Earlier 403/404 permission tests still pass.
- [covered] AC F17-3: Unchanged: csv.test.ts and the audit.e2e CSV download test.
- [covered] AC F17-4: Unchanged: audit.e2e filters, total and export; Postgres-lane double-run export job test.
- [covered] AC F15-1: Unchanged: dashboard.e2e. The shared-formula concern is recorded in open_issues for integration.
- [covered] AC F15-3: Unchanged: settings.e2e.
- [covered] AC F15-4: Unchanged: settings and admins If-Match conflict tests.
- [partial] AC F03-5: Unchanged: existing payments keep their fee snapshot; creating a payment through the API belongs to the api-payments slice.
- [n/a] AC F16-4: Alumni password reset is in admin-members (api-membership slice).

## Verification
- pass `pnpm build`: 10/10 tasks.
- pass `pnpm typecheck`: 15/15 tasks. API typecheck re-run on the final tree after the last test edits: exit 0.
- pass `pnpm lint`: 9/9 tasks. API lint re-run on the final tree: exit 0. Contracts lint still prints the same 2 Redocly warnings as before.
- pass `pnpm test`: 15/15 tasks. API 41 files, 600/600 (builder had 593). Admin 143/143. The first run failed one core test (files.e2e, an audit_export file with no completed entry); I updated that test and the full re-run passed.
- pass `pnpm --filter @kapdh/api test:pg`: 11 files, 74/74 (73 plus the new concurrent-invite test). Exit 0. Vitest also reported that 2 Vite servers did not exit after the tests closed.
- pass `pnpm contracts:lint`: Exit 0, same 2 warnings as before.
- pass `pnpm format:check`: All matched files use Prettier code style.
- pass `Old-code checks (temporary, reverted)`: With the old FOR SHARE lock, the Postgres invite race test FAILED (409 on email instead of alumni_user_id). With the access hook switched off, 3 audit.e2e download-audit tests FAILED. Both temporary changes were reverted (git diff clean) before the final runs.

## Contract changes
- packages/contracts/CHANGELOG.md (section 'Fase C api-admin'): the invitation link form is corrected to `${ADMIN_ORIGIN}/invite#t=<token>`. A new 'Catatan perilaku untuk integrasi' block describes: every audit_export URL is audited through the files access hook; concurrent alumni invitations are serialized and the loser gets 409 on alumni_user_id; a permission change sends no session.revoked; the exported queue and business-day formulas and their exact weekend rules. No change to operations or schemas.

## Shared changes
- apps/api/src/core/adapters/mailer.ts (core): new MailMessage type; Mailer gains an OPTIONAL send(message), so other Mailer implementations still compile. SmtpMailer, DevLogMailer and MemoryMailer implement it; MemoryMailer adds messages and lastMessage(to).
- apps/api/src/core/outbox/topics.ts (core): new topic admin.invitation.requested {admin_id, invite_expires_at}, handled by AdminMailJob. admin.security_notice gains kind email_changed and an optional audit_id. JobRegistry rejects duplicate handlers, so other slices (for example admin-auth for password_changed) should publish to admin.security_notice rather than register their own handler.
- apps/api/src/core/files/files.service.ts (core): storeGenerated takes an optional tx; new deleteStoredObject(objectKey); new FileAccessHook type and registerAccessHook(purpose, hook), which accessFor runs after the policy allows and before the signed URL. Additive only; purposes with no hook behave as before.
- apps/api/src/core/db/locks.ts (core): ADVISORY_LOCK_NAMESPACES.auditExport = 47_110_003.
- apps/api/test/core/jobs.e2e.test.ts (core test, builder): the 'topic without handler' case picks an unhandled catalog topic at runtime.
- apps/api/test/files/files.e2e.test.ts (core test): the audit_export policy test now writes an audit.export.completed entry for the file before calling access, as the worker does. Assertions are unchanged.
- apps/api/test/files/files-access-hook.e2e.test.ts: new test file for FilesService.registerAccessHook.
- apps/api/test/pg/admin-governance.pg.test.ts: Postgres-lane file, now also covering concurrent alumni invitations. Lane infrastructure is unchanged.

## Open issues
- Finding 7 (shared queue formulas, AC F15-1, C7/C6) is real but needs other slices: in this worktree modules/payments and modules/moderation are empty stubs, so their endpoints cannot use the shared formulas yet. At integration, GET /admin/payments/summary, the overdue filter and review_due_at of adminListPayments, and AdminModerationQueueCounts must use paymentQueueSummary, reviewDueAtSql and addBusinessDaysSql, reportsVisibleTo and reportQueueSummary from modules/admin/queue-rules.ts and business-days.ts, or those functions move to one shared place (core or the owning module). A cross-module test should check that the dashboard counts equal /admin/payments/summary and the moderation queue counts for the same caller. The business-day rules (a weekend start counts as Friday at the same local time) are written in the CHANGELOG so the payments and moderation slices can match them.
- Core-owned, outside this slice: src/cli/bootstrap-admin.ts:44 still prints `${ADMIN_ORIGIN}/invite/<token>`, the form C1 forbids, which the admin web's /invite route (it reads the token from the hash) cannot use. The comment at src/core/identity/crypto.ts:41 shows the same form. The core-api or admin-auth owner should switch both to `/invite#t=<token>`.
- Integration (api-payments): PUT/GET /admin/settings/fees and PUT /admin/settings/payment-instructions are served by modules/admin. The payments slice must not register them as well.
- Integration (admin-auth): invitation preview and accept must check admins.invite_token_hash, invite_expires_at > now and status = invited. The worker creates a new token on every send, so only the link in the latest email works.
- Product (D1/D8): the server values in the CHANGELOG (72 h invite token lifetime, rate limits, 1 h export timeout, 24 h retention, 50,000-row limit, 3 job attempts, 7-day failed-delivery window) are proposals that need confirmation.
- Concurrent invitations now lock the alumni users row FOR NO KEY UPDATE for the short invite transaction (bcrypt runs before it), so a concurrent update to that users row, such as a login stamp, waits briefly. That update already had to wait under the old FOR SHARE lock, so behavior is effectively unchanged.

## Handoff notes
Final commit 9936d41 (fix(api-admin)) sits on top of the builder's f4008dc. It squashes the interrupted fixer's wip commit and my wip commits; nothing was pushed and the branch has no upstream.

Key files:
- kapdh-platform/apps/api/src/modules/admin/admin-mail.ts: adminInvitationLink().
- kapdh-platform/apps/api/src/modules/admin/admin-mail.job.ts: builds the email through deliver(), which fails clearly when Mailer.send is missing.
- kapdh-platform/apps/api/src/modules/admin/admins.schemas.ts: AdminCursorSchema, a discriminated union per sort order.
- kapdh-platform/apps/api/src/modules/admin/admins.service.ts: FOR NO KEY UPDATE on the alumni row in invite(); no realtime disconnect on a permission-only change.
- kapdh-platform/apps/api/src/modules/admin/audit-export.service.ts: onModuleInit registers the audit_export access hook (recordDownload). access() no longer writes its own audit entry; the hook writes exactly one.
- kapdh-platform/apps/api/src/core/files/files.service.ts: registerAccessHook().

Tests:
- kapdh-platform/apps/api/test/admin/audit.e2e.test.ts: downloadedEntries() helper and the generic-path audit tests.
- kapdh-platform/apps/api/test/files/files-access-hook.e2e.test.ts.
- kapdh-platform/apps/api/test/pg/admin-governance.pg.test.ts: concurrent alumni invite test, which holds the alumni row lock until pg_stat_activity shows 2 lock waiters.
