# Phase C slice: public-web

Final report after build, adversarial review (9 findings) and fixes (commit fd6428e).

## Summary
I checked all 9 review findings. All 9 were real, and all 9 are fixed, each with tests. Before any fix was applied, I ran the new tests against the original code from commit eb91af9, and every new test failed there.

A previous fixer had partly fixed the source in commit 6ea37ea but never updated or added tests, and 7 tests were failing. I reviewed that work and kept it. I also finished delete-account-page.ts, removed one unused export (api.ts `failureCode`) and wrote all the tests.

**What changed, by finding:**

1. **Shared 429 wait (medium, fixed).** Each action in the delete-account flow now has its own wait: send code, resend, verify and confirm. A 429 on resend only disables the resend button, and its countdown shows in that button's label. The Verify button stays enabled while the code already sent is still valid. A 429 on verify no longer blocks resend. The message names the button that is limited and says that the code already sent still works.
2. **409 IDEMPOTENCY_CONFLICT on confirm (medium, fixed).**
   - api.ts now reads `retry_after_seconds` from the error body for any status. The `Retry-After` header is still only trusted on 429.
   - "Still processing" (a 409 with `retry_after_seconds`) keeps the same Idempotency-Key. After the server's wait it retries automatically, up to 3 times, so the request number from the first request is shown.
   - A new key is used only after VERSION_CONFLICT, or after an IDEMPOTENCY_CONFLICT with no wait (the key was already used for a different payload).
   - Also added: pressing Batal after a confirm whose outcome is unknown no longer says "Akun Anda tidak berubah".
3. **Countdown re-read by screen readers (medium, fixed).** The role=alert message is written once and states the wait length in words ("50 menit"). The per-second countdown now lives in a separate `[data-wait]` element with aria-live=off. On the legal pages, the retry button was moved outside the role=status region.
4. **Disabled button with no reason after going back (low, fixed).** Going back to the email step clears the resend and confirm waits. When a step's main button is still blocked, the message is shown again with the time left, plus the visible countdown. Nothing is written into a hidden alert any more.
5. **Errors mapped by HTTP status only (low, fixed).** Errors now go through the shared error catalog in @kapdh/shared (`failureAction`). Only a real VALIDATION_ERROR shows "QR tidak valid", and only a real NOT_FOUND shows "Belum diterbitkan". An HTML or text 400 or 404 from a proxy shows the unreachable state with retry.
6. **New QR scan dropped while a check was running (low, fixed).** Each KTA check has a sequence number, so a hashchange always starts a new check and the old token's result is thrown away.
7. **Maintenance banner and kontak page (low, fixed).** The maintenance banner now shows the support email and WhatsApp and has a "Periksa lagi" button. /kontak shows "Kontak terbaru belum dapat dimuat" with "Coba lagi" when the config fails to load. If a later reload fails, the last good config is kept.
8. **Wrong button named in confirm messages (low, fixed).** `describeFailure` takes the label of the button actually on screen, so pending_otp registrations see "Batalkan pendaftaran dan hapus data".
9. **In-page anchors pointing at nothing (low, fixed).** Valid ids (`/^[A-Za-z][A-Za-z0-9_-]{0,99}$/`) are copied with an `isi-` prefix, on non-image elements, first occurrence only. Matching `#` links are rewritten to the prefixed id. A link whose target doesn't exist becomes plain text.

**Checks:** web tests went from 139 to 169, all passing. `pnpm build`, `typecheck`, `lint` and `format:check` all pass, and so does the full `pnpm test`.

## AC coverage
- [covered] Finding 1: 429 wait kept separately for each action (resend vs verify) - PRD 2.5, auth.yaml resendOtp: delete-account-page.test.ts: 'PRD 2.5: 429 kirim ulang hanya menahan Kirim ulang; Verifikasi tetap dapat dipakai...', 'PRD 2.5: 429 verifikasi (batas per IP) menahan Verifikasi saja...', '429 pada konfirmasi menahan tombol konfirmasi saja...'; delete-account.test.ts 'N-11/PRD 4.5: pesan 429 statis menyebut tindakan yang dibatasi dan lama jeda'
- [covered] Finding 2: 409 IDEMPOTENCY_CONFLICT keeps the same key, honours retry_after, and the request number is shown (AC F14-1, PRD 4.3): delete-account-page.test.ts: 'AC F14-1/PRD 4.3: 409 masih diproses setelah jaringan putus mempertahankan key, mengulang otomatis, lalu nomor permintaan tampil' (exact scenario from the review: keys [k1,k1,k1] -> done), 'pengulangan otomatis dibatasi 3 kali', '409 IDEMPOTENCY_CONFLICT tanpa jeda ... key baru', 'Batal setelah konfirmasi yang hasilnya tidak diketahui...'; delete-account.test.ts 'PRD 4.3: 409 IDEMPOTENCY_CONFLICT masih diproses...'; api.test.ts 'PRD 4.3: retry_after_seconds di body dibaca untuk 409...'
- [covered] Finding 3: N-11 live regions not re-announced every second: delete-account-page.test.ts 'N-11: selama hitung mundur role=alert tidak ditulis ulang setiap detik...' (MutationObserver: 0 mutations in 5 s, one when the wait ends); info-page.test.ts 'N-11: hitung mundur 429 tidak mengubah wilayah live tiap detik; tombol coba lagi di luar role=status'
- [covered] Finding 4: no disabled button without a visible reason after restart (PRD 4.5): delete-account-page.test.ts 'PRD 4.5: setelah 429 kirim ulang, Ubah alamat email membuka langkah email dengan tombol aktif tanpa teks di alert tersembunyi', 'PRD 4.5: jeda verifikasi yang masih berjalan saat kembali ke langkah kode dijelaskan lagi (alert + hitung mundur)'
- [covered] Finding 5: PRD 5.2 single error catalog; HTML 400/404 is never a verdict (AC F06-3/F06-4, F-08): kta-verify.test.ts 'AC F06-3/F06-4 (PRD 5.2): 400 tanpa body Error kontrak ... tetap coba lagi'; info-page.test.ts 'PRD 5.2: 404 tanpa body Error kontrak ... tidak terjangkau dengan coba lagi'; api.test.ts failureAction tests; delete-account.test.ts 'PRD 5.2: perilaku mengikuti kode galat kontrak, bukan status saja'
- [covered] Finding 6: KTA hashchange while a request is in flight (AC F06-3): kta-page.test.ts 'AC F06-3: QR yang diperbarui dipindai saat verifikasi lama berjalan (hashchange)...', 'AC F06-3: jawaban token lama yang datang SEBELUM token baru juga tidak ditampilkan', 'hashchange ke tautan rusak saat request berjalan...'
- [covered] Finding 7: maintenance banner support channel + retry; /kontak error + retry (PRD 4.5, 8.3): config-page.test.ts 'PRD 4.5: banner maintenance memuat rentang estimasi, retry dan kanal dukungan', 'memeriksa ulang yang gagal tidak menghapus banner...', 'PRD 4.5/8.3: /kontak gagal memuat konfigurasi -> pesan ... dan coba lagi yang berhasil', 'markup Base.astro dan kontak.astro memuat kait...'
- [covered] Finding 8: confirm messages name the button actually shown (pending_otp): delete-account.test.ts 'F-14: pesan konfirmasi menyebut tombol yang benar-benar tampil'; delete-account-page.test.ts 'F-14: pendaftaran pending_otp: pesan galat konfirmasi menyebut tombol Batalkan pendaftaran dan hapus data'
- [covered] Finding 9: in-page anchors in legal pages work (F-08, PRD 3.8): sanitize.test.ts 'F-08: daftar isi dalam halaman (href=#x) menunjuk id berawalan isi- dan tidak bentrok dengan id halaman', updated attribute/anchor tests
- [covered] AC F06-1..F06-4, AC F14-1, F-08 slice ACs (regression): All existing builder tests still pass (169/169 in @kapdh/web)

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 tasks; web post-build check 'Gerbang CSP lulus untuk 11 halaman'
- pass `pnpm typecheck (kapdh-platform)`: 15/15 tasks; @kapdh/web astro check 0 errors (40 files) + tsc
- pass `pnpm lint (kapdh-platform)`: 9/9 tasks; contracts:lint prints 2 warnings, unrelated to this slice (contracts not touched)
- pass `pnpm --filter @kapdh/web test`: 14 files, 169 tests (was 139)
- pass `pnpm format:check (kapdh-platform)`: All matched files use Prettier code style
- pass `pnpm test (kapdh-platform, extra regression)`: 15/15 tasks
- pass `New tests run against the original eb91af9 sources`: Every new behaviour test failed on the original source (16 in kta/info/sanitize/config, 12 in the delete-account page), confirming they catch the reported bugs. The source was then restored.
- pass `pnpm install --frozen-lockfile --prefer-offline`: Lockfile matches the manifests after adding @kapdh/shared to @kapdh/web

## Contract changes


## Shared changes
- kapdh-platform/apps/web/package.json now depends on @kapdh/shared (workspace:*), for the single error catalog required by PRD 5.2. kapdh-platform/pnpm-lock.yaml gained the matching link entry under the apps/web importer; no other lockfile changes. infra/Dockerfile.web builds with `pnpm --filter @kapdh/web... build`, so shared is built first automatically.
- kapdh-platform/apps/web/src/layouts/Base.astro: the maintenance banner gained support email/WhatsApp links and a 'Periksa lagi' button marked [data-config-retry]; both are filled by config-page.ts.

## Open issues
- No findings were rejected: all 9 were confirmed and fixed.
- Still open from the builder: nginx-web.conf has not been run through `nginx -t` (no nginx or Docker on this host), and the flows have not been tested end to end against the real merged account, content and membership APIs.
- Separating 'still processing' from 'key already used for a different payload' depends on the server sending retry_after_seconds only for the first case. That is how core-api idempotency.service.ts behaves today. If that changes, update describeFailure in apps/web/src/scripts/delete-account.ts.

## Handoff notes
**Delete-account page (apps/web/src/scripts/delete-account-page.ts):**
- 429 waits are kept per action in `state.waits` (challenge, resend, verify, confirm). The step-to-action map is `PRIMARY_ACTION`.
- The role=alert box is written only by showAlert/clearAlert, plus one 'Silakan coba lagi sekarang' when a wait ends. Never write to it from tick() every second.
- The per-second countdown goes in `[data-wait]` (aria-live=off) and in the resend button label.
- Confirm runs through `submitConfirm()`. On a 409 'still processing' it keeps the same key and retries automatically up to `MAX_AUTO_CONFIRM_RETRIES` (3).
- `state.confirmUncertain` makes the Batal notice careful wording when the outcome of a confirm is unknown.

**Shared error handling (apps/web/src/scripts/api.ts):**
- `failureAction()` maps every failure through @kapdh/shared ERROR_UI. Business verdicts require the matching contract error code.
- `requestJson` now reads `retry_after_seconds` from the body for any status, but trusts the `Retry-After` header only on 429.

**Other modules:**
- `waitMessage()`, `actionLabel()` and `CONFIRM_LABEL_DEFAULT` are exported from delete-account.ts, and `describeFailure(step, failure, { confirmLabel })` takes the label of the button on screen.
- The sanitizer copies anchor ids with the prefix `isi-` (`ANCHOR_PREFIX`).
- The KTA page discards results from stale checks using a sequence number.
