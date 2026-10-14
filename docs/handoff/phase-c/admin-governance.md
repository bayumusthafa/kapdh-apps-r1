# Phase C slice: admin-governance

Final report after build, adversarial review (11 findings) and fixes (commit b560f99).

## Summary
I checked all 11 review findings and every one was real. I fixed 10 of them, and each fix has a test that fails on the old code. The 11th (the overdue payments link) can only be partly fixed from this slice, because the payments page has no filter for it yet.

Verification all passed: pnpm build, typecheck, lint and format:check, plus the admin suite at 21 files and 243 tests (232 before). Because I changed a contract file, I also ran the contract lint, the contracts tests (39), the Dart SDK check and the API suite (404 tests); all passed.

Fixes, in order of severity:
1. **High, F-12 group reports.** On a group report, warn and suspend could never be submitted against the real API. The page looked for the member to act on in the evidence messages, but group-report evidence has no messages.
   - I made the smallest additive contract change: a new operation, GET /admin/reports/{reportId}/subject-candidates. It lists members and former members who actually joined the group. It leaves out deleted accounts and the admin's own linked alumni account, and follows the same conflict-of-interest rules as the report detail.
   - The mock now matches the contract (group evidence has no messages). The page picks the member from this list with a search box; members who are already suspended cannot be chosen for suspend.
   - If the list cannot load, the page says so and the report can still be dismissed.
   - The confirm dialog names the chosen member. When "replace the reported message with a placeholder" is ticked, the dialog states that this cannot be undone and asks for the two-step confirmation.
2. **AC F16-2.** When the server refuses a role or permission change (for example, the last active Super Admin), the confirm dialog now closes and focus moves to the role field that shows the error.
3. **/login/enroll.** "Batalkan aktivasi" now asks for a two-step confirmation that explains a new invitation from a Super Admin will be needed. The browser also warns before reload or tab close while the enrollment token is in memory or backup codes are on screen.
4. **Dashboard.**
   - A failed 60-second refresh keeps the last data, the queues and the Riwayat Transaksi search text, and shows a "Gagal memperbarui dasbor" notice with a retry button. The full error screen appears only when there was never any data.
   - The queue cards now hold up at 200% text: the grid is sized in rem, labels wrap, and the stat values can break. I checked in the dev:mock browser at 375, 1024 and 1280 px, at both 100% and 200% text: no horizontal page scroll and nothing spills out of the cards. The 375 px check also found an overflow in the "Total Transaksi" card value, which I fixed.
   - The card markup is now valid (dl > div > dt + dd) and the card titles are h3 under the "Perlu tindakan" h2.
   - open_count is now labelled "Laporan aktif (terbuka + ditinjau)", and the menu badge reads "laporan aktif".
5. **Audit export download.** The page no longer calls window.open after a network request, which a popup blocker could stop without anyone noticing. "Siapkan unduhan" fetches a fresh signed URL, then shows an "Unduh berkas" link that gets focus and a status message. The link disappears when the URL expires after 10 minutes. The page never claims a download started.
6. **/invite third-party fonts.** The Google Fonts links are gone. Poppins is now bundled from @fontsource/poppins 5.2.7. In the browser, /invite made no requests to other sites and the font files came from the admin's own origin.

## AC coverage
- [partial] AC F12-3 / F12-4: warn and suspend on group reports (high finding): Client side is covered in moderation.test.tsx: the 'AC F12-3: laporan grup (bukti tanpa pesan…)' test checks that the fixture has messages: [], the server-provided candidate order, that Bayu and Hasan are left out, the request query {limit:'50'}, the full resolve body with subject_user_id, and that the dialog names the member. The 'AC F12-4: suspend laporan grup…' test checks that already-suspended members are disabled and that the search q is sent. A third test checks that when the list is unavailable, warn cannot be submitted but dismiss still works. Partial because the API does not implement the new candidates operation yet.
- [covered] AC F12-3 / PRD 4.5: remove_message confirmation: In moderation.test.tsx, 'AC F12-3: peringatan wajib catatan…' now checks that the 'Akibat tambahan' list states the placeholder replacement cannot be undone, and that the confirm button stays disabled until the acknowledgement is ticked.
- [covered] AC F16-2: rejected change closes the dialog and focuses the error: admins.test.tsx 'AC F16-2: … dialog konfirmasi tertutup, galat tampil dan difokuskan pada isian peran' checks: no alertdialog remains, focus is on a radio inside the Peran group, the role is unchanged and exactly one PATCH was sent. The test failed before the fix.
- [covered] AC F02-2 / PRD 4.5: cancelling activation and the reload guard: onboarding.test.tsx: cancelling now needs the confirm dialog (focus starts on 'Lanjutkan aktivasi'); after cancelling, /login/enroll is no longer reachable. A separate test checks the beforeunload event is blocked during the QR step and while backup codes show, and is released after entering the Dashboard.
- [covered] F-15 / PRD 4.5: dashboard data kept when a refresh fails: dashboard.test.tsx 'PRD 4.5: polling yang gagal mempertahankan data terakhir…': a failed poll keeps the stats, the Pembayaran card and the search text 'ridwan', and shows the role=status notice; 'Coba lagi' recovers it. Another test checks the full error state when the first load fails.
- [covered] N-11 / WCAG 1.3.1 and 1.4.4: dashboard markup and 200% text: dashboard.test.tsx checks that every dt/dd sits directly in dl or dl > div, that the card titles are h3 with only one h2 in the section, and that the grid uses a rem-based auto-fit template. Layout itself was measured in the dev:mock browser at 375, 1024 and 1280 px (100% and 200% text): page scrollWidth equals clientWidth and nothing overflows the cards.
- [covered] AC F15-1 / C6 rule c: dashboard and moderation counts read the same: dashboard.test.tsx reads 'Laporan aktif (terbuka + ditinjau)' and checks it equals open + in_review; the badge test uses 'laporan aktif'.
- [covered] AC F17-2 / F17-4: audit export download: audit.test.tsx 'AC F17-4: …': the download link has the signed URL, target=_blank and rel='noopener noreferrer', gets focus and a status message; window.open is never called; there is no 'dimulai' toast; the link disappears after 10 minutes and the button returns.
- [covered] F-16 (admin-auth /invite: no third-party sources): New src/index-html.test.ts: index.html has no external link, script, img or frame and no fonts.googleapis/gstatic; the referrer meta is no-referrer; main.tsx imports the @fontsource Poppins weights. In the browser, /invite made no third-party requests and loaded the woff2 files from its own origin.
- [partial] F-15 / AC F15-1: 'Lewat batas N' link to /payments?stage=awaiting_review&overdue=true: The /payments route (payments page area) has no stage or overdue search params, on this branch or on the payments page branch. The dashboard now links to /payments?tab=verify and explains how overdue rows are marked there; a test checks the href. Recorded as an integration blocker.

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 tasks; the admin Vite build bundles the poppins-*.woff2 files; dist/index.html has no Google Fonts.
- pass `pnpm typecheck`: 15/15 tasks.
- pass `pnpm lint`: 9/9 tasks, including the contracts lint (redocly valid; the 2 files ambiguous-path warnings were already there before my change).
- pass `pnpm --filter @kapdh/admin test`: 21 files, 243 tests passed.
- pass `pnpm format:check`: All matched files use Prettier code style.
- pass `pnpm --filter @kapdh/contracts test`: 39 tests passed.
- pass `pnpm contracts:test-dart (with /c/flutter/flutter/bin on PATH)`: The generated Dart SDK analyzes clean and its fixture tests pass with the new operation.
- pass `pnpm --filter @kapdh/api test`: 31 files, 404 tests. Run to confirm the contract addition does not break the API's contract-to-route tests.
- pass `Manual layout and network check in the dev:mock browser (vite --mode mock, port 5287)`: Signed in by setting the mock's own session flag in sessionStorage, not by typing credentials. Dashboard at 375, 1024 and 1280 px, 100% and 200% text: no horizontal page scroll and nothing overflows the queue cards (the 375 px / 200% stat card overflow was found here and fixed). Group report detail at 375 px shows the candidate list without overflow. /invite: no third-party requests and Poppins loads from its own origin.
- not_run `pnpm --filter @kapdh/api test:pg / flutter analyze`: No API, database or mobile source files changed.

## Contract changes
- admin-moderation.yaml (owned by api-moderation; additive only): new operation GET /admin/reports/{reportId}/subject-candidates (operationId adminListReportSubjectCandidates). Access: { audience: admin, permissions: [moderation.read, moderation.resolve] }; parameters reportId, q (1-100 characters), cursor, limit. Responses: 200 AdminModerationSubjectCandidatePage, 400 for a report that is not an active group report, 401, 403 if the caller's linked account is the reporter, 404 if it is the reported party (including a joined member of the group).
- admin-moderation.yaml: new schemas AdminModerationRoomMemberStatus (enum joined, left, removed); AdminModerationSubjectCandidate (allOf AdminModerationTargetMember plus required room_status and room_role, which uses ChatMemberRole); AdminModerationSubjectCandidatePage ({items, next_cursor}). No existing operation or field changed.
- packages/contracts/CHANGELOG.md: new subsection 'admin-governance: calon subjek laporan grup', placed before '## 0.2.0'.

## Shared changes
- packages/contracts/openapi/domains/admin-moderation.yaml (owner api-moderation): the additive operation and schemas above. The path is inserted after the resolve operation and the schemas are appended at the end of the file, away from the lines main changed, so the merge should not conflict.
- packages/contracts/CHANGELOG.md: one new subsection before '## 0.2.0'.
- apps/admin/package.json and pnpm-lock.yaml: new dependency @fontsource/poppins 5.2.7 (exact version, OFL-1.1, no install scripts). If another branch also changed the lockfile, run pnpm install after the merge.
- apps/admin/index.html: Google Fonts preconnect and stylesheet removed. apps/admin/src/main.tsx imports @fontsource/poppins/{400,500,600,700}.css.
- apps/admin/src/nav.ts: the screen-reader badge text NAV_BADGE_LABEL.reports_open changed from 'laporan terbuka' to 'laporan aktif' (this slice added that badge).
- Still in the branch from the builder (unchanged): test-setup asyncUtilTimeout; the nav, Sidebar and useNavBadges badges; mocks/dashboard.ts reuses the payments mock routes; additions to the auth session and mocks/auth; PasswordRules; MfaPage backup-code format; the /invite and /login/enroll routes.

## Open issues
- Integration blocker (api-moderation): the API on main does not implement GET /admin/reports/{reportId}/subject-candidates yet. Suggested implementation: reuse everJoinedRoom from room-membership.ts; leave out deleted accounts and auth.linkedAlumniUserId; apply the same visibility rules as detail (404) and the reporter-conflict rule (403); return 400 for a report that is not an active group report; order group admins first, then joined members, then former members, then by name; audit moderation.report_viewed; use @Audience('admin') with @RequirePermission('moderation.read','moderation.resolve'). Until it exists, the admin page explains that the list is unavailable and group reports can only be dismissed. Real-API warn and suspend on group reports, and the server conflict and audit behaviour, are not proven.
- Integration blocker (payments page): the /payments route and VerificationTab accept only tab (and, on the payments branch, payment and adjustment). They need additive stage=awaiting_review and overdue=true search params that apply the adminListPayments filters. Then the dashboard's 'Lewat batas review' row can link to /payments?stage=awaiting_review&overdue=true, as admin-dashboard.yaml requires (a one-line change in DashboardPage PaymentsQueue). For now it links to /payments?tab=verify, where overdue rows are marked.
- Outside this slice: apps/web (Astro public site) still loads Google Fonts in src/layouts/Base.astro. That does not affect /invite, which is served by apps/admin.
- Still open from the builder: ARCHITECTURE §7 lists /invite/$token, but the implementation follows the contract's /invite#t=<token>, so the doc needs updating. Payment-instructions editing on Settings may duplicate the payments page. The payments mock has no paid payments and ignores sort. All UI evidence runs against mocks that follow the final schemas, which is not AC proof against a real API.

## Handoff notes
I resumed from the builder's commit 8755da7. Fix commits, in order: 42df593 moderation group subject and remove_message confirmation; 21d1f67 admin detail closes the dialog on error and focuses the field; af22da4 enrollment cancel confirmation and reload guard; 01047af dashboard stale data, 200% text, markup and labels; fd88e3f audit download link; b560f99 self-hosted Poppins. Everything is committed and the working tree is clean.

Key files, all under C:/Users/Admin/KAPDHAPPS/.claude/worktrees/wf_2dfc8f13-ce6-12/kapdh-platform:
- **Contract:** packages/contracts/openapi/domains/admin-moderation.yaml (the subject-candidates operation and the AdminModerationSubjectCandidate* schemas).
- **Moderation mock:** apps/admin/src/api/mocks/moderation.ts. Group evidence now has messages: []. It has room memberships for room ...a010, a members state map, and the candidates route. New controls: mockModeration.setCandidatesUnavailable(bool) and mockModeration.member(id). visibleToCaller now also hides a group report from an admin whose linked account is a joined member of that group.
- **Moderation page:** apps/admin/src/routes/moderation/ReportDetailPage.tsx. New SubjectField, candidateLabel and REMOVE_MESSAGE_CONSEQUENCE; query key [admin-reports, subject-candidates, id, q]; SUBJECT_CANDIDATE_LIMIT = 50.
- **Admin detail:** apps/admin/src/routes/admins/AdminDetailPage.tsx. useDetailMutation gained an onFailed hook; AccessCard focuses the first invalid field after the dialog closes.
- **Enrollment:** apps/admin/src/routes/auth/EnrollPage.tsx (ConfirmDialog plus the beforeunload guard).
- **Dashboard:** apps/admin/src/routes/dashboard/DashboardPage.tsx (stale notice in a role=status region, QueueHeader as h3, valid dl grid, StatValue) and apps/admin/src/api/mocks/dashboard.ts (mockDashboard.setFailing).
- **Audit:** apps/admin/src/routes/audit/AuditPage.tsx (prepareDownload and the ready link that expires after 10 minutes).
- **Fonts:** apps/admin/index.html, apps/admin/src/main.tsx, and the new test apps/admin/src/index-html.test.ts.
