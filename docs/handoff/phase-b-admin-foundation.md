# Phase B handoff: admin-foundation

Foundation notes after build, adversarial review (20 findings) and fixes. Phase C slice owners build on this.

## Summary
I checked all 20 review findings (two were duplicates) and fixed every one; none were rejected. The admin suite now passes: 12 files, 138 tests, on 3 runs. The branch head is b8cd7e2 and contains no `wip:` commits.

**Git history.** The branch had two WIP commits. I rebuilt it as three proper commits:
- 721a66d has the same file tree as the builder's 946180d, which already included WIP 86d7947.
- ff8f3c0 has the same tree as 071803b.
- b8cd7e2 is the fix commit. It also contains the unfinished WIP c3cfe56, now completed.

Only this branch contained those commits, there is no remote, and the old commits stay in the reflog.

**Findings and fixes:**
- **1/11 (WIP failing tests, critical).** I kept the WIP design: toasts go into `aria-live` containers that are always present, and paging buttons stay focusable when disabled (`aria-disabled`). I updated the tests to match. Toasts are now found with new helpers `toasts()`/`findToast()`. Tests that asserted "no toast" used to pass vacuously with `queryByRole("alert")`; they now check the toast containers.
- **2 (focus fell to `<body>` after a version conflict or stale proof).** The decision panel now notices when the payment changes after a reload. It announces "Bukti transfer diganti alumni (versi N). Centang dana dan alasan dikosongkan..." or "sudah diputus admin lain" in its live region. If focus was lost, it moves focus to the panel heading. This also covers the 60 s polling path.
- **3 (editor toolbar tab stop could land on a disabled button).** Buttons that are temporarily unavailable now use `aria-disabled` and stay focusable, as in the WAI-ARIA toolbar pattern. Native `disabled` is used only when the whole editor is disabled.
- **4 (gold focus ring on white for the mobile Menu button).** The button is no longer inside a dark-surface wrapper, so it gets the green ring. In a real browser at 375 px I measured `rgb(26,75,23)` on a white header.
- **5 (server field errors not announced).** The first field with an error now gets focus. If no field can take focus, a toast says "Periksa isian yang ditandai. ...". On the payments screen, focus moves to the reason field after the confirm dialog closes.
- **6/18 (PDF proof without mime; expired signed URLs).**
  - New `previewKind()` decides how to preview: it uses mime if present, then the data-URL type, then the file extension in the URL.
  - If an image fails while its URL is still valid, the preview shows a neutral "Buka berkas" frame without asking for a new URL.
  - Cache lifetime now follows `expires_at`, and a background timer renews the URL 30 s before it expires.
  - Clicking "Buka" on an expired URL fetches a new one first.
  - The contract gap (no proof mime in the API) is listed under open issues.
- **7 (focus trap counted `tabindex=-1` elements).** The trap now uses only real Tab stops (new `getTabbable`).
- **8 (delete row action).** The danger icon button is now solid red with a white icon, as in guideline p13.
- **9 (payments page title).** An admin with only `settings.manage` now sees the title "Metode & Biaya Pembayaran". Each tab has its own description.
- **10 (mobile menu ARIA).**
  - `aria-controls` is set only while the drawer is open.
  - The drawer is named "Menu navigasi" through a new `Sheet` `ariaLabel` prop.
  - The logo inside the drawer is decorative.
- **11/12/13/16 (session handling).** I added `src/api/session-tokens.ts`:
  - A failed refresh is classified. A definite 4xx (other than 408/429) is "rejected" and ends the session. Network errors, 5xx, 429 and timeouts are "unavailable": the admin stays signed in, and the refresh is retried with backoff and again when the browser comes back online.
  - Refresh is serialized across tabs with Web Locks, and new tokens and logouts are shared with other tabs through BroadcastChannel.
  - Logout now ends the local session at once and revokes the server session in the background with the captured token. If the server has not confirmed within 8 s, a warning is shown; network, 5xx and 429 are no longer reported as success.
  - The revoke will not touch a new login made in the same tab.
  - A two-tab test against a fake rotating server shows the lock prevents reuse detection. A control test without the lock does trigger it.
- **14 (background header lost on retries).** The background marker now lasts through React Query's automatic retries. Refetch when the browser comes back online is now marked as background.
- **15 (reauth dialog).**
  - When `/auth/reauth` returns 401, the dialog checks the session with GET `/admin/me`. If the token was just replaced, it sends the request once more; if the session ended, it closes the dialog.
  - A pending reauth request is cancelled when the session ends.
- **17 (empty later page in DataTable).** A later page that becomes empty now shows "Halaman ini sudah kosong" with a button to go back to the previous page.
- **19 (editor link and image rules).**
  - Links are limited by `isAllowedUri` and `shouldAutoLink` to `https://` and `mailto:`; the deprecated `validate` option is gone.
  - Images must use https when content is loaded or pasted.
  - Pasted images without alt text are removed.

**Browser check.** I ran a mock-mode dev server on :5287. Session restore works through `navigator.locks` with no console errors. Logging out in tab 2 sent tab 1 to the login page with "Sesi berakhir", which confirms the cross-tab logout in a real browser.

## Handoff notes
ADMIN SESSION/TOKENS (apps/admin/src/api)
- session-tokens.ts: class SessionTokens({ requestRefresh, locks?, channel?, leewayMs?, retryDelaysMs? }).
  - RefreshResult kinds: ok | rejected (definite 4xx except 408/429) | unavailable (network, 5xx, 429, 408, 15 s timeout) | superseded.
  - classifyRefreshFailure(status) maps a failed status to one of these.
  - Uses lock name "kapdh-admin-refresh" and BroadcastChannel "kapdh-admin-session". Both are disabled when MODE=test; tests inject fakes.
- client.ts exports:
  - setAccessToken(token|null, expiresAt?) and setSessionOwner(adminId).
  - onSessionExpired(handler): called only on rejected. onLoggedOutElsewhere(handler(reason)).
  - hasFreshAccessToken(margin), refreshAccessToken().
  - probeSession(): 'valid' | 'renewed' | 'ended' | 'unavailable'.
  - beginLogout(reason) returns a LogoutHandoff; revokeSession(handoff) returns Promise<boolean>.
  - ensureFreshAccessToken and revokeCurrentSession were removed.
  - When refresh is unavailable after a 401, the middleware throws ApiError NETWORK instead of ending the session.
  - An explicit Authorization header on a request is never overwritten.
- session.tsx logout(reason): ends the local session immediately, then revokes in the background. It shows toast.warning(LOGOUT_UNCONFIRMED_MESSAGE) if the server has not confirmed within LOGOUT_CONFIRM_TIMEOUT_MS (8000). A logout from another tab ends this tab with reason 'idle' or 'expired'.

QUERY LAYER (api/query.ts)
- refetchInBackground(queryClient, queryKey): use it for any automatic refetch. The background flag lasts through React Query retries.
- useApiQuery sets refetchOnReconnect:false and refetches in the background on window 'online'. createAppQueryClient also sets refetchOnReconnect:false.
- applyFieldErrors(setError, error) now returns { applied, root, focused, firstMessage } and focuses the first field. useApiMutation shows a toast 'Periksa isian yang ditandai. <msg>' only when no field got focus.
- api/files.ts: useFileAccess uses expires_at for staleTime and renews the URL 30 s before expiry in the background. isAccessExpired(access) and ACCESS_RENEW_MARGIN_MS are exported.

UI
- Toasts have no role per item. Errors render in an aria-live="assertive" container and other tones in an aria-live="polite" one; each toast carries data-toast="<tone>".
- Button has prop focusableWhenDisabled (aria-disabled plus data-soft-disabled). DataTable paging buttons use it.
- DataTable shows the 'Halaman ini sudah kosong' state when pageIndex>0 and the page is empty.
- Sheet has prop ariaLabel. Brand has prop decorativeLogo.
- lib/focus.ts: getTabbable(container). The focus trap uses Tab stops only.
- IconButton tone 'danger' is solid red.
- RichTextEditorImpl exports sanitizePastedHtml(html). Toolbar items use aria-disabled.
- PaymentDecisionPanel: announces reloads in role=status (warning tone) and moves focus to the heading when focus was lost. onDecided(message, version).
- FilePreview exports previewKind(mime, url).

TESTS
- src/test/utils.tsx adds toasts(tone?) and findToast(tone, text). Do not query toasts by role=alert/status.
- mockAuth.failRefresh('network'|status|null, times?) makes /auth/refresh fail. mockAuth.holdLogout() returns release().
- RTE tests stub Range.getClientRects/getBoundingClientRect for ProseMirror under jsdom.
- When writing patch scripts on this Windows/Git Bash host, save them as files from an editor instead of a Bash heredoc: backslashes inside a Bash heredoc get collapsed.

## Shared changes
- Rewrote the history of branch worktree-wf_dd0a0393-234-9 (local only, no other branch contains these commits). WIP commits 86d7947 and c3cfe56 are gone. 946180d and 071803b were recreated with identical trees as 721a66d and ff8f3c0, then the fix commit b8cd7e2 was added. The builder's reported hashes 946180d/071803b no longer appear on the branch.
- kapdh-platform/apps/admin/src/api/mocks/auth.ts: new test controls mockAuth.failRefresh(mode, times) and mockAuth.holdLogout(). /auth/refresh calls are now recorded in authRequests.

## Open issues
- Contract gap, for the payments and files contract owners: neither AdminPaymentDetail nor FileAccess carries a proof mime type. FilePreview now guesses the type from the data-URL type or the URL extension, and falls back to a neutral 'Buka berkas' frame. Exposing proof_mime (or mime on FileAccess) would let a PDF proof render as 'Dokumen PDF' every time.
- Cross-tab token adoption is best-effort: browsers do not guarantee whether a BroadcastChannel message arrives before the next tab gets the Web Lock. Correctness does not depend on it, because refreshes are always serialized. In the worst case one extra rotation happens. If the API team adds a short grace window for the replaced session, even that goes away.
- The dev:mock session lives in sessionStorage, which is per tab, so the mock cannot model a cookie shared by all tabs. Cross-tab behaviour is covered by unit tests with a fake rotating server and by a manual BroadcastChannel check.
- Carried over from the builder: payments still runs on the mock until /admin/payments*, /admin/settings/fees and /files exist in apps/api. /login/enroll and /invite/$token are still placeholders. The Telegraf font licence is still pending. ESLint react-hooks and jsx-a11y plugins are still not configured repo-wide.
