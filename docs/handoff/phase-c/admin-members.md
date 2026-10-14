# Phase C slice: admin-members

Final report after build, adversarial review (8 findings) and fixes (commit 3ba9174).

## Summary
I checked all 8 review findings. Each one was real, and I fixed all of them on branch worktree-wf_2dfc8f13-ce6-9 (commits a314dca, 2684d12, 3ba9174). Each fix has a test that would have caught the problem. To confirm, I ran the masters test against the old MastersPage and it failed on the stale label.

1. **Failed-precondition reload (medium).** main now has the real API (admin-members.service.ts, member-password-reset.service.ts, membership.kernel.ts). Against it I confirmed the two shapes the server sends for a 400 VALIDATION_ERROR when an action's precondition fails:
   - Suspend and unsuspend send `current` {suspended_at, account_status, version} with no field_errors.
   - PATCH and password-reset send a root error `field_errors._`.
   - New queries.ts helpers recognise both shapes: isPreconditionFailure (VALIDATION_ERROR 400 whose only field error, if any, is `_`) and reloadMember.
   - A new usePreconditionHandler, used by Suspend, Unsuspend, PasswordReset and now MemberEditDialog, closes the dialog and reloads detail, history and list. It then announces the reason in the focused status region.
   - The mock now matches the server's order, shapes and messages: deletion_pending is checked before already-suspended, and preconditionFailed() uses the kernel shape.
   - New mock controls: requestDeletion (users.status changes without a version bump) and exhaustOtpSends.
2. **Stale master edit form (medium).** The master detail query now has gcTime 0, and refreshLists removes masterKeys.details(kind). Each edit form now loads fresh data and uses the current version for If-Match.
3. **Background refetch failure (medium).** The full-page ErrorState now shows only when there is no data yet. On the detail page and the list grid, a failed background refetch shows a new inline RefreshFailedBanner with "Coba lagi". The page, the open dialog and the typed input all stay.
4. **Breadcrumb filters (low).**
   - The list page remembers its search in listMemory.ts (in memory plus sessionStorage, validated with parseMembersSearch).
   - The detail breadcrumb, the NotFound "Kembali ke daftar alumni" link and the masters breadcrumb now return to the list with those filters.
   - This needed an additive `search` on Breadcrumb in PageHeader.
5. **Edit pencil (low).** The card pencil is hidden for deletion_pending and deleted accounts. When `?edit` is requested but not allowed (missing members.manage, conflict of interest, or account being deleted), the detail page announces why and focuses the notice. The summary has no linked-admin id, so the conflict-of-interest case can only be detected on the detail page.
6. **Password-reset 429 (low).**
   - The dialog shows the server message once as an alert, plus a visual countdown that is not announced.
   - The confirm button is disabled but still focusable, via a new additive ConfirmDialog.confirmDisabled prop. While it is disabled, clicks do nothing.
   - After the countdown, a retry reuses the same Idempotency-Key.
   - The mock enforces 5 OTP sends per hour per email and returns retry_after_seconds.
7. **Cohort range (low).** latestCohort now uses the WIB year − 1996, the same formula as the server (30 in 2026). It drives the filter options and the edit form check ("Angkatan berupa angka 1 sampai N", input max). The mock checks cohort against the server's range.
8. **Tests (low).** The not-found test now starts with "PRD 4.5:". There are 11 new tests (members 10, masters 1); the admin suite is now 194 tests.

Full verification on the final tree is green: build, typecheck, lint, the admin tests and format:check.

## AC coverage
- [covered] Finding 1 / PRD 4.5, AC F15-4, contract '400 bila dilanggar dengan versi terkini': precondition failure reloads and shows latest state (both server shapes) for suspend, unsuspend, password reset and edit: members.test.tsx: 'PRD 4.5, AC F12-3: anggota mulai menghapus akun sebelum batasi disimpan → prasyarat 400 bentuk server; dialog ditutup, data terbaru dimuat dan diumumkan', 'PRD 4.5, F-14: anggota mulai menghapus akun saat formulir ubah terbuka → 400 galat akar; ...', 'AC F16-4, PRD 4.5: akun mulai dihapus sebelum pemulihan dikirim → 400 galat akar; ...', 'PRD 4.5: server tiruan menjawab prasyarat suspend/unsuspend dengan bentuk MembershipKernel; galat isian bukan prasyarat' (API-level check: no field_errors, `current` present, isPreconditionFailure true/false cases)
- [covered] Finding 2 / AC F15-4 master CRUD: reopened edit form uses fresh data and current If-Match version: masters.test.tsx 'AC F15-4: ubah master yang sama berturut-turut memakai data dan versi terbaru, bukan cache lama' (If-Match ['1','2'], label 'Dokter Umum' shown, then another admin's change 'Dokter Keluarga' loaded on reopen); fails against the pre-fix MastersPage
- [covered] Finding 3 / PRD 4.5: failed background refetch keeps the page and the open form, shows the error inline with retry: members.test.tsx 'PRD 4.5: refetch latar detail gagal → halaman dan formulir yang sedang diisi dipertahankan, galat sebaris dengan coba lagi', 'PRD 4.5: refetch latar daftar gagal → kartu tetap tampil dengan galat sebaris dan coba lagi'
- [covered] Finding 4 / F-15 guideline p16: going back from detail and masters keeps the list search and filters: members.test.tsx 'F-15: kembali dari detail dan halaman master lewat breadcrumb mempertahankan pencarian dan filter daftar' (router search {status: suspended, cohort: 22} restored, list query re-sent with the filters)
- [covered] Finding 5 / PRD 2.3, F-14, PRD 4.5: no pencil for accounts being deleted; a disallowed ?edit announces the reason: members.test.tsx 'PRD 2.3, F-14: ikon ubah tidak tampil untuk akun yang sedang dihapus; pada akun tertaut admin sendiri alasannya diumumkan' (notice focused, no dialog, filters q=Bayu kept on the way back)
- [covered] Finding 6 / PRD 2.5, PRD 5.2 RATE_LIMITED show_countdown, contract 429 on adminInitiateMemberPasswordReset: members.test.tsx 'PRD 2.5, AC F16-4: batas OTP email anggota (429 RATE_LIMITED) → hitung mundur, tombol mulai nonaktif sampai waktu tunggu habis' (alert and countdown, button aria-disabled, click does nothing, re-enabled after the wait, retry succeeds with the same Idempotency-Key)
- [covered] Finding 7 / PRD 3.5: cohort range matches the server (Jakarta year − 1996): members.test.tsx 'PRD 3.5: angkatan terbaru mengikuti tahun berjalan WIB seperti server, pada filter dan formulir ubah' (30 on 2026-10-12, 30 at 23:30 WIB 31 Dec, 31 at 00:30 WIB 1 Jan; no 'Angkatan max+1' option; the form rejects max+1 with the server-range message and sends no PATCH)
- [covered] Finding 8 / quality bar: test names start with an AC/PRD id; tests cover precondition, 429 and back-to-back master edits: 'PRD 4.5: anggota yang tidak ada menampilkan Data tidak ditemukan' renamed; 11 new tests listed above; the admin suite went from 183 to 194
- [covered] Original slice ACs (F-15 list/detail, AC F05-6, AC F10-4, AC F12-3..F12-5, AC F15-1, AC F15-4, AC F16-4): All 40 existing members/masters tests still pass unchanged (except the one rename)

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 turbo tasks, exit 0; re-run on the final tree after the last edit
- pass `pnpm typecheck`: 15/15 tasks, exit 0; re-run on the final tree
- pass `pnpm lint`: 9/9 tasks, exit 0. The first run found an unused `toasts` import in members.test.tsx; I removed it and re-ran to green.
- pass `pnpm --filter @kapdh/admin test`: 14 files, 194 tests passed (183 + 11 new), run on the final tree
- pass `pnpm format:check`: All matched files use Prettier code style
- fail `npx vitest run src/routes/members/masters.test.tsx -t berturut-turut (against the pre-fix MastersPage from 4b968b3)`: Expected failure, which proves the new test catches finding 2 (the reopened form showed the stale value). The fixed file was restored with git checkout HEAD.

## Contract changes


## Shared changes
- kapdh-platform/apps/admin/src/components/ui/ConfirmDialog.tsx (admin-foundation): additive optional prop `confirmDisabled?: boolean` (default false). It disables the confirm button but keeps it focusable (focusableWhenDisabled), and is used for the RATE_LIMITED countdown. Existing callers are unchanged.
- kapdh-platform/apps/admin/src/components/ui/PageHeader.tsx (admin-foundation): additive optional `search?: Record<string, unknown>` on Breadcrumb, passed to <Link> only when set (the target route's validateSearch still validates it). Existing breadcrumbs are unchanged.
- Carried over from the builder: api/mocks/auth.ts gained an export mockAdminRole(); the members area routes.tsx replaced the foundation placeholder.

## Open issues
- Mock results are not AC proof (PRD 7.3). The precondition and 429 shapes now match main's real implementation (admin-members.service.ts, member-password-reset.service.ts, membership.kernel.ts preconditionFailed). Server-side guarantees must still be proven by the API slices.
- When the server's precondition 400 uses the kernel shape (no field_errors), useApiMutation still shows its default error toast in addition to the page notice. The same toast-plus-notice pair already happens on VERSION_CONFLICT. Removing it would need a per-error toast option in the shared api/query.ts.
- Conflict of interest for the card pencil can only be detected on the detail page, because AdminMemberSummary has has_linked_admin but no admin id, and the admin profile has has_linked_alumni but no alumni id. The detail page announces the reason and does not open the form.
- Carried over from the builder: ROUTE_ACCESS lets members.manage-only admins open /members and /members/$userId, where the page shows ForbiddenState. Foundation may want to narrow ROUTE_ACCESS for these two paths to ['members.read'].
- Carried over from the builder: recent payments on the detail page link only to the /payments queue, because there is no per-payment route. A possible mock route collision exists if another area also registers GET /admin/members.

## Handoff notes
New and changed APIs in apps/admin/src/routes/members:
- **queries.ts**
  - `isPreconditionFailure(error)`: VALIDATION_ERROR, status 400, and the only field error (if any) is `_`.
  - `reloadMember(queryClient, userId)`: invalidates `['admin-member', userId]`, which also covers history, plus `['admin-members']`.
  - `masterKeys.details(kind)`: the prefix used to drop cached master details.
- **MemberActionDialogs.tsx** exports `usePreconditionHandler(member, onClose, onDone)`, which returns `(error) => boolean`. MemberEditDialog uses it too.
- **PasswordResetDialog** handles RATE_LIMITED with a countdown (local `useCountdown`; message uses `retry_after_seconds`, falling back to 60 s).
- **listMemory.ts**: `rememberMembersSearch` (called from the list page effect), `lastMembersSearch` and `forgetMembersSearch` (used in the members.test.tsx beforeEach).
- **RefreshFailedBanner.tsx**: an inline warning for a failed background refetch when data already exists.
- **labels.ts**: `latestCohort(now)` is the Jakarta year − 1996 (COHORT_BASE_YEAR), same as MembershipKernel.

Mock (api/mocks/members.ts):
- `preconditionFailed()` uses the kernel shape for suspend and unsuspend. PATCH and password-reset keep the root error `_` with the server's messages.
- Suspend checks deletion_pending before already-suspended, as the kernel does.
- Password reset enforces 5 OTP sends per hour per email (429 with retry_after_seconds).
- Cohort is checked against the server range.
- New controls: `mockMembers.requestDeletion(userId)`, which sets users.status without a version bump, and `mockMembers.exhaustOtpSends(userId, retryAfterSeconds)`.

The master edit dialog's detail query has `gcTime: 0`.
