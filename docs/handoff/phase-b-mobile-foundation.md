# Phase B handoff: mobile-foundation

Foundation notes after build, adversarial review (17 findings) and fixes. Phase C slice owners build on this.

## Summary
I checked all 17 review findings. All were real, and all are fixed in commit d5ffc32 on the same branch. On the final run, `flutter analyze` reported no issues and `flutter test` passed all 304 tests (up from 258). No APK or IPA was built, as the task said.

**OTP and token timing (findings 1 and 3)**
- A new `ServerClock` reads server time from each response's `Date` header (plus `Age` for cached responses). The OTP screen and the refresh coordinator now use it instead of the device clock.
- OTP: a 7-hour-fast device clock no longer disables the six boxes or the Verifikasi button.
  - When server time is unknown, only the server decides that a code has expired.
  - A slow clock can lock the resend button for at most 60 seconds from when the challenge appears. A code always counts as expired 10 minutes after it appears (PRD 2.5).
- Tokens: the saved token pair also records when it expires on the device's clock. A device 20 minutes fast now triggers one refresh instead of one per request.
- If the skew cannot be measured, proactive refresh is switched off for that pair and only the 401 path refreshes.

**Realtime (finding 2)**
- Calling `start()` while a token fetch or refresh is pending no longer opens a second socket.
- `stop()` cancels any connect still in flight, so no socket is created after logout.

**Push (findings 4 and 7)**
- The device's push registration is now remembered in secure storage, so it survives restarts.
- The FCM token is deleted every time a session ends, including logout from the offline state and a session that fails to restore at startup.
- If deletion fails offline, it is kept as pending and retried when the app opens or the connection returns.
- Tapping a local notification that starts the app now opens its deep link.

**Startup storage failure (finding 5)**
- A failed secure-storage read is no longer cached by `TokenStore`.
- The splash now shows "Data sesi belum dapat dibaca" with "Coba lagi", which recovers without deleting tokens.

**Maintenance (finding 6)**
- Maintenance is now read-only mode. Read screens the user's status allows stay open with a "Pemeliharaan" banner.
- Routes that only change data go to `/maintenance`, which has a new "Lanjut dalam mode baca" button.
- A rejected save now shows a snackbar.

**Other fixes**
- **Config (finding 8):** a release build without `KAPDH_ENV` set to staging or production, or with a non-https API, stops on a configuration-error screen.
- **Design (findings 9–15):**
  - The dashed upload border is now visible.
  - Login no longer overflows at 200% text with the keyboard open.
  - OTP errors are announced to screen readers.
  - The inactive KTA card shows a gold padlock.
  - The app bar uses a left arrow.
  - The Offline/Pemeliharaan banners sit under every screen's app bar instead of above the bottom navigation, with no doubled banner.
  - The password counter shows "n/8".
- **Platform (findings 16–17):**
  - App Links no longer capture `/apply` or `/apps`.
  - KAPDH launcher icons are generated from the logo (adaptive on Android, no alpha on iOS) by `tool/generate_launcher_icons.ps1`.
  - The iOS launch screen and the Android 12+ splash are dark green.

I checked the new login, upload-tile and realtime tests by temporarily undoing those fixes; the tests failed without them and pass with them.

## Handoff notes
**New APIs**
- `serverClockProvider` returns a `ServerClock`:
  - `now()`: estimated server time, UTC.
  - `deviceNow()`: device time.
  - `isSynced`, `offset`, `toDeviceTime(serverInstant)`, `observe(serverTime)`, `observeDateHeader(date, age:)`.
- Server timestamps (`expires_at`, `resend_available_at`, `access_expires_at`) must be compared with `ServerClock.now()`. Relative waits such as `retry_after_seconds` are measured with `deviceNow()`.
- `ServerTimeInterceptor` is the first interceptor on both the app Dio and the bare (refresh) Dio.

**Tokens**
- `StoredTokens.received(pair, serverClock)` must be used for freshly issued pairs. It records `deviceExpiresAt` (expiry on the device's clock) and sets `clockSkewSuspected` when no `Date` header is available.
- `StoredTokens.fromPair` assumes the device and server clocks agree; it is kept for tests and old data.
- JSON keys: `access_expires_at_device` and `clock_skew_suspected`.

**Session**
- `SessionIssue.storage` is a new value. The splash shows "Data sesi belum dapat dibaca" with "Coba lagi".

**Routing and maintenance**
- `isMutationOnlyRoute(path)` and `readOnlyLanding(RedirectState, Uri)` are in `redirect.dart`.
- During maintenance, read routes the status allows stay open; routes that only change data go to `/maintenance?from=`.

**Banners and design system**
- `AppBannerScope` (design/app_scaffold.dart) is filled by `AppStatusBanners` (app/app_banners.dart) with `MaintenanceBanner` and/or `OfflineBanner`.
- `AppScaffold` shows that banner under the app bar unless `banner:` is passed (which overrides it) or `showGlobalBanner: false` is set.
- Screens that do not use `AppScaffold` must render `AppBannerScope.of(context)` themselves.
- `MaintenanceBanner({until, onDetails})` is in design/offline_banner.dart.
- `DashedBorderPainter` is public; UploadTile uses it as a `foregroundPainter`.
- `BrandSheetScaffold(scrollable: true)`: the header scrolls with the body. In this mode `body` must be a Column, not a scroll view. Login uses it.
- `passwordCounter(PasswordCheck)` returns `(text, problem)`.

**Push**
- `PushService(... store: SecureStore)`, `onSignedIn(userId)`, `onSignedOut()` (idempotent), `retryPendingUnregister()`.
- `PushRegistrationStore` uses key `kapdh.push_registration.v1`.
- `sessionServicesProvider` calls `onSignedOut` on every transition into anonymous, and `retryPendingUnregister` when connectivity returns.

**Realtime**
- RealtimeClient tracks in-flight connects (`_pending`/`_generation`). `start()` is safe to call on every session change.

**Config**
- `ApiConfig.resolve(rawEnv:, rawBase:, releaseMode:)` throws `ApiConfigException`. On that error, bootstrap runs `ConfigErrorApp`.

**OTP**
- Constants `otpValidity` (10 min) and `otpResendCooldown` (60 s) are defined in otp_screen.dart.

**Icons**
- `kapdh-mobile/tool/generate_launcher_icons.ps1 -Root <kapdh-mobile>` regenerates the Android and iOS icons (Windows PowerShell with System.Drawing).

**Tests**
- To simulate server time in tests, call `container.read(serverClockProvider).observe(serverTime)`, or return a `{'date': HttpDate.format(...)}` header from FakeResponse.json.

## Shared changes
- kapdh-mobile/test/support/app_harness.dart: pumpApp(store:) now takes any SecureStore (it was MemorySecureStore)
- kapdh-mobile/test/support/fakes.dart: added FlakySecureStore(inner, failures:, failingKey:), which fails reads to simulate Keystore/Keychain errors
- ErrorPresenter: MAINTENANCE is now a SnackbarPresentation (it was silent)
- RefreshCoordinator constructor: `clock:` was replaced by `serverClock: ServerClock?`
- PushService constructor now requires `store: SecureStore`, and `onSignedIn` takes a userId argument
- createBareDio/createAppDio now require `serverClock:`
- AppShell no longer renders OfflineBanner; banners come from AppStatusBanners via MaterialApp.builder into AppBannerScope

## Open issues
- Not done for finding 5: deleting an unreadable token key after repeated read failures. Doing so would log the user out on a transient Keystore problem; the splash retry is the recovery path instead.
- Push unregister relies on deleting the FCM token on the device, plus POST /auth/logout when online. There is still no DELETE /devices in the contract. A logout that fails offline leaves the server session to expire by TTL.
- The app gate leaves maintenance mode only through the maintenance screen's 'Coba lagi', on app resume (recheckIfStale), or on a fresh /public/config. There is no periodic recheck while users browse in read-only mode.
- The list of data-change-only routes (`isMutationOnlyRoute`: auth, /payments/new/*, /renewal, /account/password, /account/delete, /chat/new-group) must be extended by feature slices when they add similar routes.
- The launcher icons are generated from assets/logo-kapdh.png on #0E280C. They should be replaced with official design files when available. The Android 13 monochrome themed icon and the notification icon are still release follow-ups.
- The Gradle and Xcode resource changes are unverified until CI builds them.
