# Phase C slice: admin-events

Final report after build, adversarial review (8 findings) and fixes (commit 1c54d9d).

## Summary
I checked all 8 review findings. Each one was real, and each is now fixed with a test that fails on the old code. Everything is in one commit, 1c54d9d ("fix(admin-events): ..."), on top of the builder's 060a824. The admin suite now has 204 tests, all passing (197 before).

1. **Camera rescan (QrScanner.tsx):** a QR that stays in front of the camera is no longer sent again. Each time the same code is read, the 2-second window (SAME_CODE_ABSENT_MS) starts over, including while a request is still running. The same code is only sent again after it has been out of view for 2 s.
2. **Category version conflict (EventCategoriesSheet.tsx):** the edit form now keeps the category version it was opened with and uses it for the diff and If-Match. On a VERSION_CONFLICT, or when a newer version shows up in the reloaded list, a focused role=alert banner shows the latest values with a "Muat versi terbaru" button. Simpan stays disabled until the admin reloads. A category deleted by another admin closes the editor.
3. **Save during cover upload (EventCoverField.tsx, EventForm.tsx):** the cover field now reports when an upload is running. Saving is blocked during the upload and a role=alert message appears ("Gambar cover masih diunggah..."). Once the upload finishes, the save includes cover_file_id.
4. **Handheld scanner losing codes (CheckinPage.tsx):** this needed a redesign.
   - The submit button no longer goes into its loading state. That state was cancelling the Enter key from handheld scanners.
   - The code field is cleared as soon as a code is sent, so the next scan cannot be appended to the old code.
   - A code scanned while a check-in is still running goes into a queue (oldest first). Queued codes are sent one after another once the previous result is known. Repeat scans of a code already sent or waiting are announced instead of being sent twice.
   - A "Pemindaian sebelumnya" list keeps the last results visible, so a result replaced by the next scan is not lost.
   - When the connection drops (result unknown), the code goes back to the front of a paused queue instead of into the field. Pressing Check-in with an empty field, scanning the same code again, or pressing "Kirim ulang sekarang" resends it with the same Idempotency-Key.
5. **Price lock (eventFormModel.ts, EventForm.tsx, EventActions.tsx):** the price lock is gone, because the binding contract (adminUpdateEvent) allows price changes that apply only to new reservations. When an event already has tickets, the form shows a hint, and saving a new price opens a "Ubah harga tiket?" confirmation explaining that existing tickets and payments keep the price they were bought at. The cancel-event dialog now describes each refund as the total that ticket holder paid, not the current event price.
6. **Failed background reload (EventDetailPage.tsx):** the full-page error now appears only when there is no data yet. A failed reload keeps the page and the open edit form, and shows a role=alert banner with a "Coba lagi" button.
7. **Repeated identical results not announced (CheckinPage.tsx):** the result card now includes "Pemindaian ke-N, pukul HH.mm.ss <zona>" inside the live region. Two identical results in a row therefore have different text and are announced again.
8. **Focus lost after actions (EventDetailPage.tsx, EventActions.tsx):** after a form save or a publish/close/reopen, focus moves to the event status line in the page header (tabIndex=-1, with a hidden "Status event:" prefix for screen readers). Before, it fell to the page body.

New mock controls in src/api/mocks/events.ts, all cleared by reset(): holdCheckins, holdCoverUploads, failDetailReads, editCategoryElsewhere, category().

## AC coverage
- [covered] AC F09-5 (check-in saved once with officer; second scan shows Sudah check-in without adding to the count): checkin.test.tsx: existing 'AC F09-5:' tests plus new ones. 'kamera: QR yang terus ditahan ... tidak dikirim ulang': Date.now is stubbed and the same QR decoded every 600 ms for about 10 s, giving 1 POST and the card stays success. After a 2.1 s absence, a new scan gives already_checked_in. 'pemindai genggam: kode ... diantrekan dan dikirim, tidak hilang': with mockEvents.holdCheckins, the field is empty after the first Enter. The second code is queued ('1 kode antre'), a duplicate is reported, then 2 POSTs are sent in order, the count reaches 3 of 6, and the first result stays visible under 'Pemindaian sebelumnya'.
- [covered] AC F09-6 (other event, pending, expired, cancelled or outside the window is rejected with an actionable reason): The existing checkin.test.tsx 'AC F09-6:' tests still pass. New test 'N-11: dua hasil sama berturut-turut tetap mengubah teks region live': two identical not_found results produce different region text ('Pemindaian ke-1/ke-2, pukul ...').
- [covered] AC F09-7 (event cancelled: all QR codes invalid, participants notified, refunds recorded, history kept): events.test.tsx 'AC F09-7' now expects per-ticket refund wording ('refund penuh sebesar total yang dibayar pemegangnya ... 7 hari kerja'). After a price change, the cancel dialog no longer shows the new price as the refund amount (asserted in the PRD 4.4 test).
- [covered] AC F15-2 (delete or lowering quota below held+paid is refused; cancel flow instead): The existing events.test.tsx AC F15-2 tests still pass. The client-side price lock was removed because the contract allows price changes.
- [covered] AC F15-4 (stale form gets a version conflict and a reload offer, no silent overwrite): events.test.tsx new test 'AC F15-4: kategori diubah admin lain saat formulir ubah terbuka ...': the 409 shows a focused alert with 'Versi terbaru: Tour Religi'. The input keeps 'Wisata Alumni', Simpan is aria-disabled and a second click sends no PATCH. 'Muat versi terbaru' loads the latest values, and the next save sends If-Match 2. The existing event-form AC F15-4 test still passes.
- [covered] PRD 4.4 / AC F03-5 (price snapshot; price may change for new reservations per contract adminUpdateEvent): events.test.tsx 'PRD 4.4, AC F03-5: harga event bertiket dapat diubah ... setelah konfirmasi': the field is editable and shows the hint. The 'Ubah harga tiket?' dialog shows 'dari Rp60.000 menjadi Rp75.000' and that existing tickets keep their price. No PATCH is sent before confirming; after confirming the PATCH body is {price: '75000.00'}. eventFormModel.test.ts: toUpdateRequest sends the price for an event that has tickets.
- [covered] N-10 / F-15 cover upload (guideline p14 'Gambar'): events.test.tsx 'N-10, F-15: simpan ditahan selama gambar cover masih diunggah': with mockEvents.holdCoverUploads, Save shows the role=alert COVER_UPLOAD_WAIT message, no PATCH is sent and the form stays open. After release, the PATCH includes cover_file_id and the location change, and the holder-notification toast appears (AC F13-6).
- [covered] PRD 4.5 (network loss / reload failure keeps state): events.test.tsx 'PRD 4.5: muat ulang detail yang gagal tidak mengganti halaman': with mockEvents.failDetailReads(1) and an invalidated detail query, the banner appears, the edited title stays, and 'Coba lagi' clears the banner with the edit intact. checkin.test.tsx PRD 4.3 tests: after a dropped connection, scanning the same code again, or pressing Check-in with an empty field, resends with the same Idempotency-Key and the check-in is recorded once.
- [covered] N-11 (focus after actions, live announcements): events.test.tsx 'N-11: setelah terbitkan atau simpan perubahan, fokus pindah ke status event': after publishing and after saving the edit form, the event status line has focus, not the page body.
- [covered] AC F15-1 / negative authorization: The existing events.test.tsx and checkin.test.tsx AC F15-1 and AC F16-3 tests still pass unchanged.
- [n/a] x-kapdh-access decorator parity test per controller: This slice is admin web only; there are no API controllers.

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 tasks successful (admin rebuilt).
- pass `pnpm typecheck`: 15/15 tasks successful.
- pass `pnpm lint`: 9/9 tasks successful.
- pass `pnpm --filter @kapdh/admin test`: 15 files, 204 tests passed on the final run after the last code change. The full suite also passed (204) on the run before the unknown-result queue redesign, and checkin.test.tsx passed 26/26 after it. Before my changes, a baseline run of only the events tests had one timeout in the first test, which loads its page code on demand, while the machine was ~60% loaded by other parallel builds. It did not recur.
- pass `pnpm format:check`: All matched files use Prettier code style.
- not_run `Manual browser check (vite --mode mock)`: Not run in this fix round. Starting a dev server for the preview needs a local preview configuration outside this worktree, which I may not edit. The new UI was checked through jsdom tests only: queue status, Pemindaian sebelumnya list, category stale banner, price confirm dialog and reload banner.

## Contract changes


## Shared changes


## Open issues
- Finding 5 conflicts with the slice task text ('price locked once tickets exist'). I followed the binding contract adminUpdateEvent: price may change and applies only to new reservations (the snapshot rule in PRD 4.4 and AC F03-5, plus the C5 expected_price decision). The admin UI now allows the change behind a confirmation. If the product owner really wants a lock, it has to be added to the contract and enforced by the server.
- Finding 1's optional suggestion was not implemented on purpose: keeping the success card when already_checked_in comes back for a ticket this session just checked in. Hiding a real 'already used' warning (for example a shared screenshot of a QR shown a few minutes later) would be unsafe. The 2-second window already prevents the false re-scan.
- Carried over from the builder: possible mock route clash. src/api/mocks/events.ts serves /admin/content/event-categories (GET/POST/PATCH/DELETE). If the admin-content slice adds the same routes to mocks/content.ts, content.ts loads first and wins. Keep one copy. The new mockEvents.editCategoryElsewhere/category controls only reach the events.ts copy, so the AC F15-4 category test in events.test.tsx would need the content.ts mock to support the same flow if that copy wins.
- Carried over: there is no deep link to a single payment (/payments only takes ?tab=), so 'Putuskan di Verifikasi Pembayaran' opens the queue.
- Carried over: the scanner lists only events whose check-in window opens within 24 hours and has not ended (contract adminListCheckinEvents). Worth confirming with the product owner.
- Manual browser check of the new UI pieces was not run in this pass (see verification).

## Handoff notes
Final commit: 1c54d9d on branch worktree-wf_2dfc8f13-ce6-11. It is one "fix(admin-events)" commit on top of the builder's 060a824; my wip commits were squashed into it.

Files changed (all in kapdh-platform/apps/admin/src):
- routes/events/: QrScanner.tsx, CheckinPage.tsx, EventCategoriesSheet.tsx, EventCoverField.tsx, EventForm.tsx, eventFormModel.ts, EventActions.tsx, EventDetailPage.tsx
- Tests: checkin.test.tsx, events.test.tsx, eventFormModel.test.ts
- Mock: api/mocks/events.ts

API and behaviour changes:
- QrScanner exports SAME_CODE_ABSENT_MS = 2000, replacing DUPLICATE_SCAN_WINDOW_MS. Nothing outside the slice used the old name.
- toUpdateRequest(base, values) no longer takes { lockPrice }.
- EventForm exports COVER_UPLOAD_WAIT.
- EventCoverField has a new optional onUploadingChange prop.
- EventActions has a new optional onStatusChanged prop.
- ScanResultCard now takes { entry: ScanEntry | null, event } instead of { outcome, seq, event }.

How the check-in page now works:
- One request runs at a time; the field is cleared on submit.
- Codes submitted while a request runs go into a queue and are sent one after another.
- When a result is unknown (dropped connection), the code goes to the front of a paused queue. Pressing Check-in with an empty field, scanning the same code again, or a new scan resumes the queue; the held code is resent with the same Idempotency-Key.
- The result card's live region includes the scan number and time.

New mock test controls on mockEvents, all cleared by reset(): holdCheckins() and holdCoverUploads() each return a release function; failDetailReads(n), editCategoryElsewhere(id, patch), category(id).

For the API events slice: nothing new beyond the builder's notes. The admin UI now sends price in adminUpdateEvent PATCH for events that have tickets, exactly as the contract allows.
