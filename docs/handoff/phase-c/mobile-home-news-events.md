# Phase C slice: mobile-home-news-events

Final report after build, adversarial review (8 findings) and fixes (commit 1ffaf3ce15b80f97fb05203ecc6d6d6b026e5a0e).

## Summary
All 8 findings are handled. 7 are fixed, each with tests. Finding 8 was already done: the builder's report lists that change under shared_changes.

On the final runs, flutter analyze reported no issues and flutter test passed 401 tests (379 before plus 22 new). pnpm install and pnpm build in kapdh-platform also passed.

Fixes:
1. **Home cache on logout (medium).** HomeCacheStore moved to lib/core/cache/home_cache_store.dart; home_repository.dart re-exports it. SessionController now clears it on logout, on server session revoke and on account switch. The listener in the autoDispose HomeController is removed. A GET /home response that arrives after the cache was cleared no longer writes it back (a counter that goes up on every clear).
2. **Reservation used the screen's ref after an await (medium).** submitReservation now takes a ReservationScope. It captures the ProviderContainer and GoRouter before the first await and reaches the messenger and navigator keys through them. If the screen is gone when the result arrives, the result is shown as a snackbar ('Bayar' or 'Lihat tiket' button) instead of being dropped. Tiket Saya is invalidated through the container. The same pattern was fixed in four other places:
   - news like (the global like publisher is captured before the await)
   - the external-link launcher in openContentLink and banners
   - ticket cancel (the controller now returns `(ticket, error)`)
   - error-presenter retry/reload callbacks (they run only while the screen is mounted)
3. **Pop race (low).** While the request is in flight, the confirmation screen hides its back button and blocks system back (PopScope). It pops with the result only when its route is still on top. Otherwise it shows the snackbar and removes only its own route (removeRoute). Event detail does the same check.
4. **Expired members could not open event detail (medium).** redirect.dart has a new RouteGroup.eventDetail for /events/:id, allowed for verified, expiring and expired. The event list stays active-only. Event detail shows MemberOnlyNotice on 403 MEMBERSHIP_REQUIRED. For non-active members, the back fallback and the 404 action point to Tiket Saya. The ticket's 'Lihat detail event' link now follows the route matrix, so expired members see it again.
5. **Locked Event tab copy (low).** For expired members the sheet now says paid tickets open in Tiket Saya and has a 'Lihat Tiket Saya' button; the text pointing to the Akun menu is gone. The unreachable expired-only action in EventsScreen is removed.
6. **Hold deadline passed before fresh status (low).** If the hold deadline has passed by server time but the server still says awaiting_payment, the ticket hides Bayar Sekarang, the cancel button and the policy text. It shows "jangan transfer" with a 'Muat ulang' button.
7. **Tests.** New tests cover every finding above. Added forbidden-state tests: Event, Tiket and Berita for expired and server-403 cases (MEMBERSHIP_REQUIRED and ACCOUNT_SUSPENDED), and the membership_required action bar. Every slice test name now starts with an AC or PRD id.

## AC coverage
- [covered] F08-1 (only published content whose time has come appears in the feed): news_test 'AC F08-1 feed berita terbit dari server…', 'AC F08-1 berita diarsipkan/belum terbit (404)…' (unchanged from builder; the server does the filtering).
- [covered] F08-2 (banner outside its date window hidden; unavailable target gets a clear message): home_screen_test AC F08-2 cases (unchanged). Banner external links now go through confirmAndLaunchExternal, which does not use ref after the await.
- [covered] F08-3 (repeated likes give at most one like; counter consistent): news_test existing AC F08-3 cases, plus 'AC F08-3 detail ditutup selagi like terkirim: tanpa galat, feed memakai keadaan akhir dari server' and 'AC F08-3 detail ditutup selagi like gagal: galat tetap disajikan tanpa galat Riverpod'.
- [covered] F08-4 (retry or helpful empty state; old cache shows its update time) + PRD 5.2 (logout wipes private data): home_screen_test existing AC F08-4 cases plus group 'Cache Beranda adalah data akun privat': 'PRD 5.2 logout saat Beranda terbuka menghapus cache Beranda…', 'PRD 5.2 logout anggota expired … tetap menghapus cache Beranda lama', 'PRD 5.2 sesi dicabut server (refresh ditolak) …', 'PRD 5.2 respons GET /home yang tiba sesudah cache dihapus tidak menulis ulang cache'; news_test 'AC F08-4 galat server…'.
- [covered] F09-1 (parallel requests never overbook; failed request leaves no hold): Client side: events_test 'AC F09-1 kuota habis saat mendaftar (409 EVENT_SOLD_OUT)…', 'AC F09-1 alasan server: belum dibuka, kuota penuh…'. The concurrency guarantee belongs to the API slice.
- [covered] F09-2 (unpaid reservation expires; seat released exactly once): tickets_test 'AC F09-2 hold habis…', 'AC F09-2 hold habis saat offline…' and new 'AC F09-2 batas hold lewat sebelum status terbaru: tidak menawarkan bayar/batal, jangan transfer' (no pay, cancel or policy; 'Muat ulang' recovers to expired). Expiry itself is done by the server.
- [covered] F09-3 (free event: ticket paid immediately with total 0 and a QR): events_test 'AC F09-3 event gratis…' and new 'PRD 4.5 event gratis: detail ditinggalkan selagi mendaftar, tiket terbit diumumkan dengan Lihat tiket'; tickets_test 'AC F09-3 tiket paid…'.
- [covered] F09-4 (rejected proof: ticket cancelled; re-registration makes a new ticket): tickets_test 'AC F09-4 bukti ditolak…' (unchanged).
- [partial] F09-5 (check-in recorded once): Member side only: tickets_test 'AC F09-5 sudah check-in…'. Scanning belongs to the admin check-in slice.
- [n/a] F09-6 (invalid QR scans rejected with an actionable reason): Admin scanner; not part of this mobile slice.
- [covered] F09-7 (cancelled event: QR invalid, participants notified, refunds): events_test 'AC F09-7 event dibatalkan…' and new 'AC F09-7 anggota expired membuka deep link event dibatalkan: detail terbuka, bukan halaman perpanjang'; tickets_test 'AC F09-7 event dibatalkan…'.
- [covered] PRD 2.2 (expired keeps paid tickets and the event detail of booked events; no member-only content for unverified/expired): events_test group 'Akses status (PRD 2.2, kontrak C5)': expired opens booked event from ticket (no participants, no reserve), expired 403 MEMBERSHIP_REQUIRED → MemberOnlyNotice + Perpanjang KTA, membership_required action bar, event list 403 → /me reload → /renewal, detail 403 ACCOUNT_SUSPENDED → /restricted, locked Event tab → Tiket Saya. tickets_test: expired ticket opens event detail, detail 403 ACCOUNT_SUSPENDED → /restricted, list 403 MEMBERSHIP_REQUIRED → /me reload → redirect. news_test: feed 403 MEMBERSHIP_REQUIRED and detail 403 ACCOUNT_SUSPENDED. test/app/redirect_test: expired allowed /events/ev-1, not /events.
- [covered] D5/D6 (hold countdown; self-cancel H-3 rule): tickets_test D5/D6 cases (unchanged), plus hold-passed state. Cancel now captures messenger, presenter and container before the await.
- [covered] PRD 3.9 / 4.3 / 4.4 / 4.5 (one seat; price confirmed; idempotent retry; status must be clear after a network drop): events_test existing PRD 3.9/4.3/4.4/4.5 cases plus group 'Reservasi saat layar ditinggalkan': 'PRD 4.3 reservasi berbayar terkirim: konfirmasi tidak dapat ditinggalkan, hasil tetap ke pembayaran' (back hidden, system back blocked), 'PRD 4.5 konfirmasi dilepas router saat respons tiba: tanpa galat, hold diumumkan dengan tombol Bayar' (the R3c StateError case), 'PRD 4.5 layar lain terbuka di atas konfirmasi saat respons tiba: detail event tidak ikut tertutup' (the R3d wrong-pop case).

## Verification
- pass `kapdh-platform: pnpm install`: Exit code 0.
- pass `kapdh-platform: pnpm build`: 10/10 tasks succeeded (turbo cache); the contracts TS/Dart SDK is generated. No platform files changed.
- pass `kapdh-mobile: flutter.bat pub get`: Got dependencies (also runs implicitly before analyze and test).
- pass `kapdh-mobile: flutter.bat analyze`: No issues found, on the final tree.
- pass `kapdh-mobile: flutter.bat test`: Final full run: 401 tests passed (379 before plus 22 new). One earlier full run had a single failure in a foundation test, test/core/session_controller_test.dart 'sinyal MEMBERSHIP_REQUIRED dari request mana pun…'. That test waits only 10 ms of real time. It passed on its own and in the next two full runs (399 and 401).
- pass `kapdh-mobile: dart format --output=none --set-exit-if-changed lib test`: Only lib/app/theme/kapdh_tokens.dart is reported. It is already unformatted on main and is a foundation file; I left it unchanged. All slice and changed shared files are formatted at page width 120.

## Contract changes


## Shared changes
- kapdh-mobile/lib/core/cache/home_cache_store.dart (new, core): HomeCacheStore and homeCacheStoreProvider moved here from features/home/home_repository.dart, which re-exports them. clear() now increments an epoch, and save(ifEpoch:) skips the write if the cache was cleared since.
- kapdh-mobile/lib/core/session/session_controller.dart: _wipePrivateData (logout, refresh rejected or session revoked, failed restore) and the account-switch branch of _acceptMe now also clear HomeCacheStore (PRD 5.2). Additive: one getter and three calls.
- kapdh-mobile/lib/app/redirect.dart: new RouteGroup.eventDetail. routeGroupOf maps '/events/<id>' to it, and the matrix allows it for verified, expiring and expired (contract C5 getEvent is nonsuspended; the server returns 403 to non-holders). '/events' (the list) stays active-only.
- kapdh-mobile/test/app/redirect_test.dart (foundation test): representative '/events/ev-1' is now RouteGroup.eventDetail, the expected matrix adds eventDetail for verified, expiring and expired, and the expired case asserts '/events/ev-1' is allowed.
- kapdh-mobile/lib/app/app_shell.dart: in the locked-tab sheet for expired members, the 'menu Akun' sentence is gone. The Event tab now says paid tickets open in Tiket Saya and adds a 'Lihat Tiket Saya' button (key locked-tab-tickets) that pushes /tickets. Also adds the dart:async import.
- kapdh-mobile/test/features/system/system_screens_test.dart (foundation test, from the builder and still present): in '503 MAINTENANCE dari request mana pun…', /home now returns a valid Home on first load and switches to 503 afterwards (suddenMaintenance flag), because Home now calls GET /home.

## Open issues
- Partly rejected: finding 8 (foundation test change not reported). The builder's report already lists system_screens_test.dart under shared_changes. The change is needed (Home now calls GET /home on load) and stays listed in this report's shared_changes.
- Finding 5: the 'Tiket Saya' row in the Akun menu was not added; the Akun screen belongs to account-notifications. The copy no longer mentions the Akun menu, so no product gap remains. The account slice may add the row anyway.
- Finding 6, optional part not done: no automatic re-check when connectivity returns. connectivityOnlineProvider lives in app_services and is not active in widget tests (enableSessionServices: false). The member can tap 'Muat ulang' or pull to refresh.
- Foundation router behaviour, for the foundation owner or integrator: a route pushed on top of a base route that is still allowed is not checked against the route matrix again when status changes. Example: /tickets pushed over /home stays open after the member becomes unverified. A route opened with go() is redirected correctly. Slice screens still handle 403 themselves (error state plus /me reload).
- When an expired member deep-links to /events/<id> and presses back, they land on /renewal (their home route) instead of the locked Event tab. This is intended, and a test covers it.
- test/core/session_controller_test.dart 'sinyal MEMBERSHIP_REQUIRED…' (foundation) uses a 10 ms real-time delay and failed once under full-suite load. It passed on its own and in the next two full runs. It may be flaky; the foundation owner could replace the delay with polling.
- Still open from the builder: /payments/:paymentId shows the UnderConstruction placeholder on this branch (owned by onboarding-payments-kta). The paid confirmation screen is still a Navigator.push route, not a go_router route.

## Handoff notes
Key changes for integrators and other slices:

- **Reservation flow (lib/features/events/reservation.dart):** create `ReservationScope.of(context)` before the first await and pass it to `submitReservation(scope, …)`.
  - Use `openReservationResult(scope, done)` only when the calling screen's route is still current.
  - Otherwise use `announceReservationResult` or `announceDetachedOutcome`.
  - `scope.detailOf(eventId)` returns the event-detail controller only if it already exists; it never creates one.
  - `showReservationRetry(scope, onRetry?)`: pass null onRetry when the calling screen is gone.
- **ReservationScreen:** blocks back (PopScope plus hidden back button) while busy. When the result arrives while it is not on top, it removes its own route with removeRoute.
- **TicketDetailController.cancel:** now returns `TicketCancelResult ({TicketDetail? ticket, ApiException? error})`.
- **Ticket detail when the hold deadline has passed:** shown when `ServerClock.now() >= hold_expires_at` and status is still awaiting_payment. It shows key `ticket-hold-passed` with a `ticket-hold-reload` button, and hides `ticket-pay`, `ticket-cancel` and the policy text.
- **Links (links.dart):** `showMessengerSnackBar(key, msg, action:, duration:)` and `confirmAndLaunchExternal(context, ref, uri)` capture the providers they need before awaiting.
- **Home cache:** lives in core. Any future cache holding private account data should be cleared in `SessionController._wipePrivateData` the same way.
- **Route matrix:** `RouteGroup.eventDetail` is new. Any code that switches exhaustively over RouteGroup must handle it (the analyzer is clean on this branch).
- **Commits:** a51eaa6 and f912caf (wip), 1ffaf3c (final).
