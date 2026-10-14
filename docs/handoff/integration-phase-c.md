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
