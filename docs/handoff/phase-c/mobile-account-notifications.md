# Phase C slice: mobile-account-notifications

Final report after build, adversarial review (8 findings) and fixes (commit 202be20).

## Summary
I checked all 8 review findings. All 8 were real and all 8 are fixed; none were rejected. Each fix has a test that fails on the old code. I proved this by putting the pre-fix lib files back, running the tests (all 17 new or updated tests failed), and then restoring the fixes. Commits: 5067e57 (checkpoint) and 202be20 (final), on top of ffdb036.

1. **(high) Profile edit, 409 conflict, "Pakai isian saya"** (kapdh-mobile/lib/features/account/profile_edit_screen.dart). A new `_rebase(latest)` first records what the user actually changed compared with the version they opened: text fields, profession, skills and the avatar choice. It then refills the form from the latest version and puts only those changes back. The next save sends just the user's own changes, with If-Match set to the latest version. The text fields are now listed in one place (`_textFields`), used both to fill the form and to detect changes.
2. **(medium) App-bar back arrow skipped the "Buang perubahan?" guard** (kapdh-mobile/lib/design/app_scaffold.dart, a shared file). `_back` now calls `router.routerDelegate.popRoute()`, the same path the system back button takes, so PopScope is respected. It falls back to `fallbackLocation` only when nothing can close.
3. **(medium) Attempts counter on the deletion-status portal** (kapdh-mobile/lib/features/status/deletion_status_check.dart). The screen now keeps its own `_attemptsLeft`. It starts from the challenge and is reset on resend. After a 400 it takes the number from the server message (`attemptsLeftFrom`), or drops by one if the message has no number. A 410 sets it to 0, and the code boxes are cleared. At 0, the code boxes and the "Periksa status" button are disabled and the text tells the user to request a new code. Resend stays available.
4. **(medium) Maintenance shown as a membership-status lock in the Akun menu** (kapdh-mobile/lib/features/account/account_screen.dart and widgets/account_section.dart). A new `pausedByMaintenance()` checks for menu items the user's status allows but maintenance blocks (change password, delete account). Those items show "Ditunda selama pemeliharaan" with a maintenance icon. Tapping one opens a maintenance sheet with the server message, the estimated end time, and a button to `/maintenance?from=<route>`, which offers retry and support and continues to the item once maintenance ends. Items locked by status still use the status sheet.
5. **(medium) Suspended members could not open their inbox** (kapdh-mobile/lib/app/redirect.dart, a shared file, plus restricted_screen.dart and notifications_screen.dart). The notifications route group is now allowed for suspended members, following contract C7 (`member_access: any`). The restricted portal has a "Notifikasi" entry with the unread badge. When an inbox item's link points somewhere the user's status does not allow, the app opens it with `go`, so the redirect replaces the current page instead of stacking a page on top of the inbox. KTA, community, payments and other account settings stay blocked for suspended members.
6. **(low) Unread badge never refreshed** (kapdh-mobile/lib/features/notifications/notification_unread_count.dart; kapdh-mobile/lib/app/app.dart, a shared file). The badge controller now reloads the count every time the realtime connection becomes connected. It also reloads when the app returns to the foreground: `_onResume` triggers this when the user is signed in and the badge is in use (`ref.exists`).
7. **(low) Client-only password rule** (kapdh-mobile/lib/features/account/change_password_screen.dart). I confirmed that neither PRD 2.5 nor auth.yaml changePassword contains a "must differ from the current password" rule, so I removed it. The server's `field_errors.new_password` still shows on the field.
8. **(low) Unhandled error when loading the latest version fails during a conflict** (profile_edit_screen.dart). The fallback GET /me is now wrapped in error handling. A failure shows an error with "Coba lagi", which loads the latest version again and then offers the conflict choice. `_onConflict` also returns early if the screen is gone (the retry button can be tapped after the screen has closed).

## AC coverage
- [covered] AC F15-4 / PRD 4.5 (version conflict; no lost update when keeping own edits): profile_edit_screen_test.dart 'AC F15-4 PRD 4.5: "Pakai isian saya" hanya menerapkan field yang diubah; perubahan perangkat lain tidak tertimpa' (other device's city/instagram/skills kept, PATCH If-Match 4 body {bio, profession_id}); existing 'Muat terbaru' test still passes
- [covered] PRD 4.5 (error states have a specific message and action: conflict fallback GET fails): profile_edit_screen_test.dart 'PRD 4.5: konflik tanpa versi terbaru dan GET /me gagal menampilkan galat dengan coba lagi; isian utuh' (no uncaught exception, SnackBar 'Coba lagi' reloads the latest version, then rebase and save)
- [covered] PRD 4.5 (important forms keep non-secret input: app-bar back respects 'Buang perubahan?'): profile_edit_screen_test.dart 'PRD 4.5: panah kembali app bar pada formulir yang berubah menanyakan "Buang perubahan?"'; layout_states_test.dart 'AppScaffold: panah kembali menghormati PopScope halaman seperti tombol kembali sistem (PRD 4.5)'
- [covered] PRD 2.5 / PRD 2.2 (session-less deletion check OTP: 5 attempts, limited challenge): status_portals_test.dart 'kode salah menampilkan sisa percobaan dari server' (now asserts 'Sisa percobaan 3 dari 5' and no '5 dari 5'), 'PRD 2.5: kode salah tanpa angka dari server mengurangi sisa percobaan satu', 'PRD 2.5: percobaan habis menonaktifkan kode dan meminta kode baru'
- [covered] PRD 4.5 (maintenance read-only mode: explain estimate, retry and support, not membership status): account_screen_test.dart 'PRD 4.5: saat pemeliharaan, menu khusus perubahan dijelaskan sebagai pemeliharaan, bukan status akun' (paused semantics, estimate text, no 'Selesaikan iuran' or 'Bayar iuran', leads to /maintenance?from=%2Faccount%2Fpassword; status locks still use the status sheet)
- [covered] AC F13-2 / contract C7 (suspended members can still open the official inbox): status_portals_test.dart 'AC F13-2: kotak masuk resmi terbuka dari portal; tujuan deep link tetap diperiksa status'; notification_open_screen_test.dart 'AC F13-2: notifikasi keamanan untuk anggota suspended terbuka di kotak masuk'; redirect_test.dart matrix + 'suspended hanya portal pembatasan, legal, hapus akun dan kotak masuk resmi (AC F13-2)'
- [covered] AC F13-3 (change in rights re-checked when opening the deep link): notification_open_screen_test.dart 'AC F13-3: status berubah (suspended) — notifikasi diperiksa server, tujuan dialihkan ke portal' (GET /notifications/{id}, marked read, payments target redirected to /restricted); redirect_test 'AC F13-3: gerbang ketukan push ...' updated
- [covered] F-13 / contract C7 getNotificationUnreadCount (refresh on foreground and after reconnect): notification_unread_count_test.dart 'F-13: lencana belum dibaca dimuat ulang saat aplikasi kembali ke latar depan (kontrak C7)' and 'F-13 ARCHITECTURE §4.9: lencana dimuat ulang setiap kali realtime tersambung kembali'
- [covered] AC F02-4 / PRD 2.1 (password change: policy beyond PRD 2.5 belongs to the server): change_password_screen_test.dart 'AC F02-4 PRD 2.1: kebijakan di luar PRD 2.5 milik server; klien tidak menambah aturan sendiri' (same password is submitted; server field_errors.new_password shown)
- [covered] Builder ACs for the slice (F-02, F-10, F-13, F-14, PRD 2.2 portals, N-11): All earlier slice tests still pass in the full run (428/428)

## Verification
- pass `cd kapdh-platform && pnpm install --frozen-lockfile`: exit 0
- pass `cd kapdh-platform && pnpm build`: Tasks: 10 successful, 10 total (all from cache); working tree unchanged afterwards
- pass `cd kapdh-mobile && flutter.bat pub get`: Got dependencies
- pass `cd kapdh-mobile && flutter.bat analyze`: No issues found (final run after the last edit and formatting)
- pass `cd kapdh-mobile && flutter.bat test`: 01:13 +428: All tests passed! Final run on the committed tree; 416 earlier tests plus 12 new
- pass `Regression proof: pre-fix lib files restored temporarily (git show ffdb036:...), then the new tests run`: Batch 1 (profile edit, AppScaffold, deletion check, unread count, app.dart): 9 new tests failed as expected. Batch 2 (redirect, restricted, account screen and tile, change password, inbox): 8 new or updated tests failed as expected. Fixes restored with git checkout; final tree is green.
- pass `dart.bat format <19 touched files>`: Only the touched files were formatted. dart format --set-exit-if-changed over lib/test also flags lib/app/theme/kapdh_tokens.dart, which I did not change; it was not touched.

## Contract changes


## Shared changes
- kapdh-mobile/lib/design/app_scaffold.dart: AppScaffold._back is now async and calls GoRouter.routerDelegate.popRoute(), the same path as the system back button, so page PopScope guards are respected. It falls back to router.go(fallbackLocation) only when nothing could close. Without GoRouter it uses Navigator.maybePop as before.
- kapdh-mobile/lib/app/redirect.dart: the suspended matrix entry now also allows RouteGroup.notifications (inbox and the /notifications/<id> push-tap gate), per contract C7 member_access any (AC F13-2). Deep-link targets still go through the matrix.
- kapdh-mobile/lib/app/app.dart: _onResume also refreshes notificationUnreadCountProvider when the session is authenticated and the provider already exists (contract C7 getNotificationUnreadCount).
- kapdh-mobile/test/app/redirect_test.dart: the expected suspended matrix includes notifications; the suspended test now checks inbox allowed and account settings and network denied; the push-tap gate test expects suspended to be allowed.
- kapdh-mobile/test/design/layout_states_test.dart: added a test that the AppScaffold back arrow respects PopScope.

## Open issues
- No findings were rejected; all 8 were confirmed and fixed.
- The builder's open issue about the AppScaffold back arrow skipping the 'Buang perubahan?' guard is now resolved by the shared app_scaffold.dart change.
- Still open from the builder (not in this fix scope): blocked_users_screen.dart and my_reports_screen.dart are placeholders owned by the network-chat slice; deep-linking to OS notification settings needs a plugin that is not in pubspec; the deletion-status portal keeps its data only in memory; the push-tap gate relies on the server's FCM payload carrying notification_id (contract C7).
- app_services.dart shouldConnectRealtime still excludes suspended members, so they get no live notification.created events. Their inbox and badge load over HTTP when opened and on resume. Turning realtime on for suspended would need a server-side decision (AC F11-6 disconnects restricted sockets), so I left it unchanged.
- dart format reports lib/app/theme/kapdh_tokens.dart as unformatted. This was already the case before this slice; I left it alone.

## Handoff notes
Fixes are on branch worktree-wf_43c6809b-584-6: checkpoint commit 5067e57, final commit 202be20.

The integrator should merge three shared changes with the foundation and auth slices; each is small:
- **kapdh-mobile/lib/design/app_scaffold.dart**: back arrow now uses popRoute.
- **kapdh-mobile/lib/app/redirect.dart**: suspended members may open the notifications route group.
- **kapdh-mobile/lib/app/app.dart**: refresh the unread badge on resume.

New APIs other slices can use:
- `pausedByMaintenance(GateStatus, SessionState, location)` in features/account/account_screen.dart tells whether a route is blocked only by maintenance read-only mode.
- `AccountMenuTile` takes a new `paused` flag: the tile shows a maintenance hint instead of the lock.
- `notificationUnreadCountProvider` now refreshes on its own whenever realtime connects or reconnects. The home bell should keep using this provider rather than a second counter.

Any test that overrides `realtimeClientProvider` should register `ref.onDispose` for the client. test/features/notifications/notification_unread_count_test.dart has a controllable socket-factory pattern for driving connect and disconnect.
