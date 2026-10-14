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
  - auth-recovery's OTP-screen login check still shows "Status akun berubah. Masuk kembali untuk melihat statusnya."
    for those outcomes. Logging in again then opens the portal, so the two flows agree.
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
no test was changed.

### Open issues (mobile track, for Phase D)

- **System back skips the route matrix (foundation router).** The Android back button calls
  `routerDelegate.popRoute()` directly. Popping onto a base route that the member's current status no longer allows is
  not re-checked by the redirect. Example: an expired member deep-links to an event detail, then presses system back,
  and lands on the event list. That list then shows its own 403 handling: GET `/events`, MEMBERSHIP_REQUIRED, `/me`
  reload, redirect.
  - The app-bar arrow is fixed (B above), but the system back button still has the gap.
  - home-news-events reported the related case of pushed routes not being re-checked when status changes.
  - A global fix belongs in the router or a `BackButtonDispatcher` (foundation owner).
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

No new breakage was found, so the track needed no further fixes. These are the results of the resumed run:

| Command | Result |
| ------- | ------ |
| `kapdh-platform: pnpm install` | pass ("Already up to date") |
| `kapdh-platform: pnpm build --force` | pass (10/10 tasks, 0 cached). The Dart SDK was regenerated in `packages/contracts/dart/kapdh_api/lib/src`: 38 files, 0 written, 0 deleted, so the committed SDK is current. |
| `kapdh-platform: pnpm typecheck` | pass (15/15 tasks). No platform files changed in this track; run as an extra check. |
| `kapdh-platform: pnpm test` | not run. No mobile branch touches `kapdh-platform`, and the platform tree is identical to `main`. |
| `kapdh-mobile: flutter.bat pub get` | pass |
| `kapdh-mobile: flutter.bat analyze` | pass ("No issues found!") |
| `kapdh-mobile: flutter.bat test` | pass (871 tests, "All tests passed!") |
| `kapdh-mobile: dart.bat format --output=none --set-exit-if-changed lib test` | Only the pre-existing `lib/app/theme/kapdh_tokens.dart` is reported (exit 1). It is unchanged from `main`. |
