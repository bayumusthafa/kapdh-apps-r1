# Phase C slice: mobile-network-chat

Final report after build, adversarial review (12 findings) and fixes (commit 64d6322).

## Summary
I checked all 12 review findings for the mobile-network-chat slice. All 12 were real, and each is now fixed and covered by a test. To prove the new tests would have caught the bugs, I ran them against the old code (2430e3d): all 19 new widget tests failed there, one for every finding. The new outgoing_message_test case and the redirect_test changes use symbols that only exist in the fixes, so they cannot compile against the old code. The 20th new test is a guard for the new fix and passes on old code by design.

Fixes, in finding order:
1. **Room-list reload storm**: messages for a room of the other kind no longer reload the list.
   - A shared room-kind registry (`chatRoomKindRegistryProvider` in `chat_list_controller.dart`) is filled from list pages and from the room screen.
   - Background reloads are batched: at most one runs and one waits (`requestRefresh`).
   - Member and invitation changes reload only the group list.
2. **Send rejected with 403/404 and no event**: the room controller notices the new rejection through the outgoing message's error code (`failureCode` / `rejectedByRoomAccess` in `outgoing_message.dart`) and calls `refreshRoom()`.
   - On 403 the composer is replaced by the correct notice (peer_unavailable, blocked or room_closed).
   - On 404, `refreshRoom` gets 404 for the room, so the screen shows "Percakapan tidak tersedia" and the queue is cleared.
   - "Kirim ulang" is hidden while the room cannot accept messages; the hint reads "Ketuk untuk membuang."
3. **Chat image accessibility**: the bubble no longer hides everything below it from screen readers; only its text parts are excluded.
   - `ChatImageView` is its own screen-reader item: "Foto", a button that opens the photo.
   - "Muat ulang foto" is reachable as a button.
4. **Message action sheets at 200% text**: the message, image-picker and outgoing-message sheets are now scroll-controlled and scrollable.
5. **/account/reports unreachable for expired and suspended members**: it now has its own route group, `RouteGroup.accountReports`.
   - It is allowed for unverified, verified, expiring, expired and suspended members.
   - /account/blocked stays active-only.
6. **Invite picker**: it loads the next page automatically when fewer than 10 selectable people are shown (up to 5 pages).
   - It shows a "Muat lebih banyak" / error footer, and no longer shows a false "Alumni tidak ditemukan".
7. **"Atur ulang filter"**: it now also clears the search box. Typing a 1-letter keyword is still kept as typed.
8. **Phone number**: tapping it now opens tel: (plain Text with link role and a 48 dp target). A long press copies it.
9. **Time and send-status line**: it now wraps instead of overflowing at 200% text.
10. **Group permission changes**: promote, demote (with a warning when you demote yourself) and removing the group photo now ask for confirmation first.
11. **Automatic paging after an error**: older history, room lists and the invite picker no longer reload on scroll after a failed load. Only "Coba lagi" retries.
12. **Jejaring tab badge**: the bottom-nav Jejaring tab shows unread rooms plus pending invitations, with the counts in the tooltip.
    - Until Jejaring is opened, `chatBadgeCountsProvider` loads the counts itself with GET /chat/rooms?limit=1. It does this when realtime connects and on relevant chat events, batched the same way as the lists, and only for active members.
    - Once the lists are open, they update the badge.

## AC coverage
- [covered] Finding 1 (N-02/N-04 cross-kind list reload): test/features/network/network_screen_test.dart 'N-02, N-04: pesan grup tidak memuat ulang tab Pesan; rentetan pesan room baru digabung' (5 group messages -> 0 extra direct and group fetches; 5 messages for an unknown room -> 1..2 fetches per list). Fails on the old code.
- [covered] Finding 2 (AC F12-1, N-09, AC F11-4: 403/404 on send): chat_room_screen_test 'AC F12-1, N-09: kirim ditolak 403 tanpa event ...' (exactly one extra room GET, notice shown, composer hidden, no Kirim ulang, discard works) and 'AC F11-4: kirim ditolak 404 ...' (Percakapan tidak tersedia, queued message gone); outgoing_message_test 'AC F12-1, F11-4: 403/404 menandai penolakan akses room ...'
- [covered] Finding 3 (N-11 image semantics): chat_room_screen_test 'N-11: foto pesan dapat dibuka dan dimuat ulang lewat pembaca layar' (ChatImageView isSemantics(label Foto, isImage, isButton, hasTapAction); 'Muat ulang foto' is a button with a tap action; tapping it runs the after= sync; the bubble label is unchanged)
- [covered] Finding 4 (N-11 action sheet at 200%): chat_room_screen_test 'N-11: lembar tindakan pesan orang lain ... Laporkan pesan' and '... pesan sendiri ... Hapus pesan' (textScale 2, no exceptions, last action reachable)
- [covered] Finding 5 (moderation.yaml listMyReports member_access any): moderation_screens_test 'AC F12-2, PRD 2.2: anggota expired tetap membuka Laporan Saya' and 'PRD 3.12: anggota suspended melihat hasil banding ...' (blocked list still redirects to /restricted); redirect_test matrix updated, with expired and suspended asserts
- [covered] Finding 6 (F-11 picker paging): chat_group_screens_test 'F-11: pemilih undangan memuat halaman berikut bila hasil di layar semuanya sudah anggota' (cursor requests c-2, c-3; Zainal and Nur shown)
- [covered] Finding 7 (F-10 reset clears search box): network_screen_test 'kosong: pesan dan atur ulang filter' now asserts an empty TextField and no clear icon; guard test 'F-10: kata kunci 1 huruf tidak dikosongkan saat filter lain berubah'
- [covered] Finding 8 (F-10/N-11 phone tap): member_profile_screen_test 'F-10, N-11: ketuk nomor telpon membuka panggilan; tekan lama menyalin' (launched tel:+6281200000001, link semantics, height >= 48, clipboard copy and snackbar)
- [covered] Finding 9 (N-11 BubbleMeta overflow): chat_room_screen_test 'N-11, AC F11-2: status kirim milik sendiri pada teks 200 % tidak meluap' (Terkirim plus a failed reply) and 'N-11: "Dibaca N" di grup pada teks 200 % tidak meluap'
- [covered] Finding 10 (PRD 4.5 confirm permission changes): chat_group_screens_test 'PRD 4.5: ubah peran dan hapus foto grup wajib dikonfirmasi; batal tidak mengirim apa pun' (cancel sends no PATCH, self-demote warning, photo removal confirmed); existing admin test updated to confirm
- [covered] Finding 11 (PRD 4.5 no auto paging after error): chat_room_screen_test 'PRD 4.5: riwayat lama gagal dimuat ...', network_screen_test 'PRD 4.5: halaman room berikut gagal ...', chat_group_screens_test 'PRD 4.5: pemilih undangan - halaman berikut gagal ...' (exactly 1 request until 'Coba lagi', then 2)
- [covered] Finding 12 (F-11 nav badge): network_screen_test 'F-11: lencana tab Jejaring (unread + undangan) tampil sebelum Jejaring dibuka dan mengikuti event' (badge 3 then 4, tooltip text, limit=1, own message makes no request, no separate badge request once the lists are open) and 'PRD 2.2: anggota expired tidak memuat lencana chat'

## Verification
- pass `kapdh-platform: pnpm install`: Lockfile up to date
- pass `kapdh-platform: pnpm build`: Exit 0, 10/10 cached (FULL TURBO); contracts TS/Dart generated. No platform files changed.
- pass `kapdh-mobile: flutter.bat pub get`: Got dependencies
- pass `kapdh-mobile: flutter.bat analyze`: No issues found (final run, after replacing the deprecated containsSemantics with isSemantics)
- pass `kapdh-mobile: flutter.bat test`: +435: All tests passed (415 before + 20 new)
- pass `kapdh-mobile: new tests against the old lib (git checkout 2430e3d -- kapdh-mobile/lib, then restored from HEAD)`: Bug-catching check: all 19 new widget tests failed on the old code (one or more per finding). Only the 1-letter guard test passes there, by design.
- pass `kapdh-mobile: dart.bat format --set-exit-if-changed on all changed lib/test files`: 0 changed

## Contract changes


## Shared changes
- kapdh-mobile/lib/app/redirect.dart (foundation): new RouteGroup.accountReports for /account/reports. It is in _memberBase (unverified/verified/expiring/expired) and also allowed for suspended, following moderation.yaml listMyReports/getMyReport member_access any. /account/blocked stays RouteGroup.accountCommunity (active members only).
- kapdh-mobile/test/app/redirect_test.dart (foundation test): matrix updated for accountReports; added expired and suspended asserts for /account/reports (allowed) and /account/blocked (redirected).
- kapdh-mobile/lib/app/app_shell.dart (foundation): additive badge on the Jejaring NavigationDestination, from chatBadgeCountsProvider.total (unread_room_count + pending_invitation_count). The tooltip names both counts. No badge when the tab is locked.

## Open issues
- Finding 5 follow-up for account-notifications (owner of status portals): the restricted portal (lib/features/status/restricted_screen.dart) has no link to /account/reports, and there is no createAppeal UI. Suspended members can now open Laporan Saya through the moderation/appeal notification deep link (/account/reports) or any push to that route. A visible portal link should be added by the portal owner; I left it out to avoid conflicting edits.
- Finding 12 note: before Jejaring is first opened, the badge is filled by GET /chat/rooms?limit=1 when realtime connects and on relevant events (another member's message, my own read cursor, my membership changes). Requests are batched (one running, one waiting). If the realtime socket never connects, the badge stays at 0 until Jejaring is opened.
- Carried over from the builder: the iOS Info.plist camera/photo texts do not mention chat images (foundation-owned platform file); presence.ping is sent only while Jejaring or a chat room is open; the N-02 p95 latency target and server-side enforcement need API/PG-lane and load tests; signed image URLs are refreshed only when loading fails or on reconnect.

## Handoff notes
New and changed APIs, all under kapdh-mobile:

- **`lib/features/chat/chat_list_controller.dart`**
  - `chatRoomKindRegistryProvider` (`ChatRoomKindRegistry.remember` / `kindOf`), filled by list pages and by `ChatRoomController`.
  - `ChatRoomListController.requestRefresh()`: batched silent reload. Use it instead of `refresh(silent: true)` for event-driven reloads.
  - `ChatBadgeCounts.total`.
  - `ChatBadgeCountsController`: loads its own counts until the lists are open, and only for verified or expiring members with an authenticated session.
- **`lib/features/chat/outgoing_message.dart`**: `OutgoingMessage.failureCode` and `rejectedByRoomAccess` (failed with FORBIDDEN or NOT_FOUND). The code is cleared on retry and on `heldLocally`.
- **`ChatRoomController`**: listens to the outbox and calls `refreshRoom()` on a new 403/404 send rejection. `refreshRoom` already turns a 404 into gone and clears the queue.
- **Room screen**: retry is offered only when the room can accept messages and membership has not lapsed (`_canRetry`).
- **`ChatBubble`**: no longer uses `excludeSemantics`. Its text parts are wrapped in `ExcludeSemantics`, and the image keeps its own screen-reader item. Any image widget passed to `ChatBubble` should define its own semantics.
- **Tests that mock the clipboard**: in this environment `Clipboard.setData` only completes in tests if `SystemChannels.platform` is mocked. See `member_profile_screen_test`.

Commits on the branch: 716c2b0 (fixes WIP), 600099d (tests WIP), 64d6322 (final fix commit).
