# Phase C slice: mobile-onboarding-payments-kta

Final report after build, adversarial review (9 findings) and fixes (commit 326f106).

## Summary
All 9 review findings checked out as real and are fixed. None were rejected. The fixes are in 5 commits on top of 1839790 (36c1d83, c0d1680, 33d7403, 9bcf486, 326f106). Each fix has a regression test, and I temporarily removed each fix to confirm its tests then fail.

1. **(high) Stale create key:** a stored Idempotency-Key could make the server replay an instruction that had since been cancelled. Fixed in three places:
   - **When "Memeriksa status" finds the open payment:** the new `PaymentsRepository.resolveCreate(type)` releases `payment.create.<type>`. The new payment screen calls it on both the start and the check path before opening the payment.
   - **After a successful cancel:** `cancel()` releases the create key for that payment's type.
   - **Defensive retry:** if a create returns a cancelled or rejected_final payment (a replay of an old key), it retries once with a new key.
2. **(medium) KTA not re-synced when the server is reachable again:**
   - **Reconnect trigger:** a new `realtimeReconnectedProvider` fires when the realtime connection comes back. The KTA screen re-syncs on it while it is showing cached data or is offline-unavailable.
   - **Backoff retry:** while it shows cached or unavailable data, the screen also retries on its own: 15 s, 30 s, 1 min, 2 min, then every 5 min. It skips retries in the background, and the timer is cancelled when the screen closes or the card is online again.
   - **Why both:** connectivity changes alone are not enough. The network can be up while the server is unreachable, and realtime may not reconnect for an account that was just suspended.
   - **Result:** a member suspended while offline loses the active card, the cache becomes restricted, and the app redirects to /restricted.
3. **(medium) KTA photo left on disk after logout:**
   - **Dedicated cache:** the photo now uses its own cache (`KtaAvatarCache`, flutter_cache_manager) instead of the default image cache. It holds at most 4 photos, each kept up to 7 days.
   - **Cleared with the card:** `KtaCacheStore.clear()` now runs an `onClear` hook that empties this cache. That covers logout, revoked session, account change, restricted status, and a card that is too old or expired to show offline.
   - **After a restart:** a marker in secure storage makes sure the cache is still emptied, even when the app was restarted before logout.
4. **(medium) Expired members had no read-only mode during maintenance:** /renewal is no longer in `isMutationOnlyRoute`. Only /payments/new/* stays mutation-only, so `readOnlyLanding` for an expired member is now /renewal.
5. **(low) Failed refreshes were silent:**
   - **Notice:** a new `RefreshFailedNotice` (warning box with "Coba lagi", announced to screen readers) appears when a refresh the user asked for fails while old data is still shown.
   - **Where:** payment status, payment history, renewal and Biaya KTA.
   - **Background reloads:** realtime, resume and session-change reloads still fail silently.
6. **(low) Rejection hidden while replacing a proof:** if the payment stage changes while the member is replacing a proof, edit mode closes and a change is announced, so the needs_fix screen shows the admin's note. The picked file and note are kept. The re-upload view now also shows "Catatan dari pengurus".
7. **(low) 200% overflow on the offline-unavailable KTA state:** that state now uses its own layout with a full-width "Sinkronkan" button (the label wraps) and pull-to-refresh.
8. **(low) Unused `KtaAction.hint`:** removed. The reason "Perpanjang" is disabled now always appears in the visible message: either the opening date, or "Perpanjangan belum dibuka." when the server sends no date.
9. **(low) History badges went stale:**
   - **Triggers:** the history list now reloads quietly on payment/membership realtime notifications, on app resume, and when returning from a payment detail.
   - **Merge:** a quiet reload merges the newest first page with pages already loaded, so items are not duplicated and the cursor stays valid.
   - **No overlap:** it does not run while the next page is loading.

## AC coverage
- [covered] AC F03-1: new_payment_screen_test covers:
- an instruction cancelled after a status check gets a new key and pay-2;
- a cancelled replay is retried once with a new key.

The earlier tests (POST without amount, idempotent retry, existing open payment) still pass.
- [covered] AC F03-2: payments_screen_test: returning from the payment status screen reloads the history badge. The earlier proof/PUT tests still pass.
- [covered] AC F03-3: payment_detail_screen_test:
- a rejection that arrives during 'Ganti bukti' closes edit mode and shows the rejection note;
- the note is still visible in the 'Unggah ulang bukti' view;
- the picked file is kept and can be sent.
- [covered] AC F03-4: Covered in tests:
- new_payment_screen_test: no create key is left in secure storage after the status check;
- payment_detail_screen_test: cancelling releases the leftover create key;
- the earlier unknown-outcome and same-key tests still pass.
- [n/a] AC F03-5: Server side; the client still shows the payment's snapshot amount.
- [covered] AC F05-1: Earlier tests are unchanged. kta_screen_test: the photo loads through the KTA photo cache with the key kta-avatar-user-1-file-avatar-1.
- [covered] AC F05-2: kta_screen_test: the cached card is retried automatically and keeps its Offline label until the server answers; a realtime reconnect brings the card back online.
- [covered] AC F05-3: Covered in tests:
- kta_avatar_cache_test: the photo cache is emptied on logout, account change, restricted status, KtaCacheStore.clear and a card cache older than 7 days;
- kta_screen_test: an unavailable card turns online by itself once the server is reachable;
- kta_screen_test: the unavailable states have no overflow at 200% text.
- [covered] AC F05-4: kta_screen_test: the network drops while the session stays authenticated, then the backoff retry gets a suspended card. The app redirects to /restricted and the cache becomes restricted. Realtime reconnect test included; payment_updates_test covers the connection-state transitions.
- [covered] AC F05-5: Earlier test unchanged and passing.
- [n/a] AC F05-6: Admin and server work.
- [covered] AC F07-1: Earlier renewal_screen_test unchanged and passing.
- [covered] AC F07-2: Covered in tests:
- redirect_test: during maintenance an expired member can read /renewal, /kta and /payments, /payments/new/renewal still goes to maintenance, and readOnlyLanding is /renewal;
- renewal_screen_test: an expired member goes through 'Lanjut dalam mode baca' to /renewal with the end date, and paying goes to maintenance with no POST.
- [n/a] AC F07-3: Server side.
- [n/a] AC F07-4: Server side.
- [covered] AC F07-5: kta_screen_test: when the server sends no opening date, Perpanjang is disabled and the message says 'Perpanjangan belum dibuka.' Earlier tests unchanged.
- [covered] PRD 4.5 screen states (error after load, maintenance): A failed refresh shows RefreshFailedNotice with Coba lagi on payment status (500), history (network), renewal (network) and Biaya KTA (500). A failed realtime reload stays silent. The expired read-only mode during maintenance is tested.
- [covered] N-11 (200% text, screen reader): kta_screen_test: three unavailable states at 200% text with no overflow. RefreshFailedNotice is a live region, and stage changes during edit mode are announced.

## Verification
- pass `kapdh-platform: pnpm install`: exit 0
- pass `kapdh-platform: pnpm build`: Exit 0, 10/10 tasks; Turbo replayed them from cache. The generated Dart SDK is in packages/contracts/dart/kapdh_api/lib/src.
- pass `kapdh-mobile: flutter.bat pub get`: Got dependencies. pubspec.lock only changes flutter_cache_manager 3.4.5 from transitive to direct main.
- pass `kapdh-mobile: flutter.bat analyze`: No issues found.
- pass `kapdh-mobile: flutter.bat test`: All 441 tests passed (412 before these fixes).
- pass `kapdh-mobile: dart format --set-exit-if-changed on all changed files plus lib/features and test/features`: Formatted 99 files (0 changed).
- pass `Mutation checks (temporarily removing each fix, then restoring it)`: Each new test failed without its fix:
- key release on the open-payment path;
- KTA retry and reconnect;
- edit-mode exit;
- refresh notice;
- history realtime and return-from-detail reloads.

All fixes were restored and the full suite then passed.

## Contract changes


## Shared changes
- kapdh-mobile/lib/app/redirect.dart: `isMutationOnlyRoute` no longer lists RouteGroup.renewal. /renewal is a read screen and expired members' home route, so it stays readable during maintenance. /payments/new/* stays mutation-only (finding 4).
- kapdh-mobile/test/app/redirect_test.dart and test/features/system/system_screens_test.dart: the mutation-only examples now use /payments/new/renewal instead of /renewal. The `from=` example uses /account/password. New expired read-only expectations added.
- kapdh-mobile/lib/core/cache/kta_avatar_cache.dart (new core file): `KtaAvatarCache` and `ktaAvatarCacheProvider`. A dedicated flutter_cache_manager cache for the member's own KTA photo, kept up to 7 days, plus a secure-storage marker.
- kapdh-mobile/lib/core/cache/kta_cache_store.dart: new optional constructor parameter `onClear`, called by `clear()`. Backward compatible.
- kapdh-mobile/lib/core/session/session_controller.dart: `ktaCacheStoreProvider` passes `onClear: () => ref.read(ktaAvatarCacheProvider).clear()`. Every existing KTA cache wipe (logout, invalidation, account change, restricted, invalid cache) now empties the photo too.
- kapdh-mobile/pubspec.yaml + pubspec.lock: `flutter_cache_manager: ^3.4.5` is now a direct dependency. It was already locked at 3.4.5 through cached_network_image, so no new package or version; only the lock marker changed to direct main.

## Open issues
- Finding 2 note: KtaScreen does not listen to connectivityOnlineProvider. Subscribing would start the connectivity_plus EventChannel in every widget test that renders /kta (MissingPluginException reported through FlutterError). It uses the realtime reconnect signal plus the backoff retry instead; this also covers captive portals and suspended accounts whose socket does not reconnect.
- Finding 6 design choice: edit mode closes only when the stage changes. A higher proof_version with no stage change (proof replaced on another device) keeps the replace view with the new version. This keeps the existing AC F04-4 behaviour ('Bukti ke-2 akan diganti' after PROOF_VERSION_CONFLICT).
- Other images loaded through cached_network_image elsewhere in the app (directory and chat avatars) still use DefaultCacheManager (30 days, not cleared on logout). They are outside this slice and are other members' public photos, but the integrator may want the same treatment.
- Builder open items carried over unchanged: no separate minimum-profile step (PRD F-01 / AC F01-2 data diri covers it; the product owner should confirm); the brightness tip is text only (raising brightness automatically needs a new plugin and an ADR); floating snackbars can briefly cover the BrandSheetScaffold bottom bar (fixing it needs a foundation design change). The fourth builder item (renewal route mutation-only) is now resolved by finding 4.

## Handoff notes
Additions since the builder report (all under kapdh-mobile):

**New APIs and providers**
- `PaymentsRepository.resolveCreate(MembershipPaymentType)`: releases the `payment.create.<type>` Idempotency-Key once the outcome is known. Behaviour around it:
  - `cancel()` calls it after a successful cancel.
  - `createInstruction()` retries once with a new key if the response is a cancelled or rejected_final payment (a replay of an old key).
- `realtimeReconnectedProvider` in features/payments/payment_updates.dart: a `Stream<void>` that fires each time the realtime connection becomes connected again. Override it in tests.
- `connectedTransitions(ValueListenable<RealtimeConnectionState>)`: the testable helper behind that provider.
- `ktaAvatarCacheProvider` / `KtaAvatarCache` in core/cache/kta_avatar_cache.dart: `imageFor(url, cacheKey:)` and `clear()`. In tests, override it with `RecordingAvatarCache` from test/features/kta/kta_fakes.dart, which never opens the real cache.
- `KtaCacheStore(store, onClear:)`: clearing the KTA cache always clears the KTA photo too.

**Widgets and keys**
- `RefreshFailedNotice` in features/payments/widgets/payment_layout.dart has the default key `refresh-failed`. Use it on any screen where a refresh the user asked for fails while old data is still shown.

**KtaScreen behaviour**
- Retries the sync automatically while it shows the offline or unavailable view: `retryDelays` = 15 s, 30 s, 1 min, 2 min, then every 5 min. No retries in the background; the timer is cancelled on dispose.
- Widget tests that pump fake time while the offline view is shown will trigger GET /me/card.
- The unavailable state keeps the key `kta-offline-unavailable` and now uses a scrollable layout with a full-width 'Sinkronkan' button.

**PaymentsScreen behaviour**
- Listens to `paymentUpdatesProvider` and app resume, and refreshes after a pushed payment detail is popped.
- Override `realtimeNotificationsProvider` in tests that need control over it.

**Test fixtures**
- `openKta` in kta_screen_test.dart: new `reconnects` and `avatars` parameters.
- `openHistory` in payments_screen_test.dart: new `updates` parameter.
- `openPayment` in payment_detail_screen_test.dart: new `store` parameter.
- `openRenewal` in renewal_screen_test.dart: new `config` parameter.
