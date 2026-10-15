# Phase C slice: admin-payments

Final report after build, adversarial review (8 findings) and fixes (commit b67ddee1309b667d75db32d964c18fbafb6b3e72).

## Summary
All 8 review findings were real. Each one is fixed and has a test that fails without the fix. Everything is committed on worktree-wf_2dfc8f13-ce6-8 (commits 9fe2128, 848cd61 and b67ddee). The full slice check passes: build, typecheck, lint, format:check, and the admin tests (18 files, 190 tests; before the fixes it was 175).

1. **Reason errors gave no feedback (medium).** In "Batalkan instruksi" (PaymentDecisionPanel) and "Batalkan" on an adjustment (AdjustmentPanel), a rejected reason now moves focus to the reason field. Its aria-describedby then reads the error out, the same as in the reject flow. This applies to both the client check and a server VALIDATION_ERROR. Focus moves only after the request has finished, because the field is disabled while it is running.

2. **Focus fell to <body> (medium).**
   - The cross-tab links "Buka" and "Buka pembayaran asal" now move focus to the heading of the panel that opens. VerificationTab and AdjustmentsTab request focus whenever ?payment= or ?adjustment= changes.
   - After a method is deleted, focus goes to the "Tambah metode" button. The same happens if the delete returns NOT_FOUND.

3. **Missing loading, empty, error and forbidden tests (medium).**
   - The new states.test.tsx has 10 tests. They cover loading, error with a working "Coba lagi", empty and search-empty, and an API 403 showing "Akses ditolak" partway through a session. Screens covered: queue, decision panel, methods, fees, adjustments list and adjustment panel.
   - To make this possible, mocks/payments.ts gained test controls: `fail` (inject an error), `hold` (keep a request loading), `clearMethods` and `linkOwnerToAdmin`. Exported routes pass through these controls first.

4. **Tab counts were bare numbers for screen readers (low).** Tabs now read, for example, "Verifikasi Pembayaran, 23 menunggu verifikasi" and "Penyesuaian, 3 penyesuaian menunggu proses". This needed a small additive `countLabel` on TabItem in the shared Tabs.tsx (listed below).

5. **Saving an unchanged method still asked for reauth and sent a PUT (low).** "Simpan metode" is now disabled when the form matches the saved version, compared the way the server would trim it. The submit handler also refuses an unchanged save. (Since ADR-025, 15 October 2026, saving a method no longer asks for reauth at all; the guard against an unchanged save remains.)

6. **Adjustment buttons ignored conflict of interest (low).** I did not change the contract. The panel now reads `conflict_of_interest` from the payment detail endpoint, which the server computes and which the contract says covers adjustments too. For a linked admin, "Tandai selesai", "Ubah" and "Batalkan" are hidden and a PRD 2.3 note is shown. While that check loads, the panel shows "Memeriksa pembayaran asal...". If the check fails, the buttons are still shown and the server still enforces the rule.

7. **Removing a saved refund account had no confirmation (low).** Unticking it in "Ubah" now opens a two-step confirmation ("Hapus rekening tujuan refund?") before the PATCH is sent. Cancelling sends nothing.

8. **"Tandai refund selesai" referred to an account that wasn't shown (low).** When no account is recorded, the dialog now shows a warning and the confirmation no longer says "di atas". The wording covers both an account not yet sent and one hidden from this admin.

To keep the existing tests stable, adjustment tests now wait for the process buttons to appear. openPayments in testing.tsx also waits up to 10 s for the page heading, because the lazily loaded page is slow to import on first load when the suite runs in parallel.

## AC coverage
- [covered] N-11 / PRD 4.3, 4.5: a rejected cancel reason is announced (focus moves to the reason field): payments.test.tsx 'PRD 4.3: batalkan instruksi tanpa bukti ...' and adjustments.test.tsx 'D2, PRD 4.5: batalkan penyesuaian ...' now assert that the reason field has focus and aria-invalid
- [covered] N-11 / PRD 4.5: focus does not fall to <body> after cross-tab links or deleting a method: adjustments.test.tsx 'N-11, PRD 4.5: tautan antartab memindah fokus ke judul panel ...'; methods.test.tsx 'F-15, PRD 4.5: hapus metode ...' asserts focus on 'Tambah metode'
- [covered] BUILD_PLAN acceptance evidence: loading, empty, error, forbidden and success states on every payments screen: states.test.tsx (10 tests): queue loading/success and 'Pilih pembayaran' placeholder; queue error and retry; queue empty and search-empty; queue 403; decision panel loading/error/retry and 403; methods loading/error/retry, 403 and both empty states; fees loading/error/retry and 403; adjustments list loading/error/retry, empty, search-empty, 403 and 'Pilih penyesuaian'; adjustment panel loading/error/retry and 403
- [covered] N-11: tab counts make sense to screen readers: payments.test.tsx 'F-04, N-11: antrean ...' asserts the tab names 'Verifikasi Pembayaran, 23 menunggu verifikasi' and 'Penyesuaian, 3 penyesuaian menunggu proses'
- [covered] AC F15-3: saving an unchanged method does not ask for reauth and sends no PUT: methods.test.tsx 'AC F15-3: ubah tanpa perubahan tidak meminta reautentikasi dan tidak mengirim PUT' (renamed to 'AC F15-3: ubah tanpa perubahan tidak mengirim PUT' when ADR-025 removed reauth from payment methods)
- [covered] PRD 2.3: an admin linked to the payment owner cannot process its adjustments: adjustments.test.tsx 'PRD 2.3: penyesuaian atas payment milik alumni tertaut tidak dapat diproses admin tersebut'
- [covered] PRD 4.5, D2: removing a saved refund account needs a two-step confirmation: adjustments.test.tsx 'PRD 4.5, D2: menghapus rekening tujuan tersimpan lewat Ubah wajib konfirmasi dua langkah' (cancel sends no PATCH; confirm sends PATCH {refund_destination:null} with If-Match)
- [covered] D6, D2: completing a refund with no recorded account shows a warning and the statement does not refer to an account: adjustments.test.tsx 'D6, D2: refund tanpa rekening tercatat diperingatkan saat ditandai selesai ...'
- [covered] Earlier slice ACs (F-04, AC F04-2/3/4, F03-3, F03-5, F15-1, F15-3, F15-4, D6): All earlier tests in payments, methods, fees, adjustments and the mock-conformance tests still pass (admin suite: 190 of 190)

## Verification
- pass `pnpm build (kapdh-platform)`: 10 of 10 tasks successful
- pass `pnpm typecheck (kapdh-platform)`: 15 of 15 tasks successful
- pass `pnpm lint (kapdh-platform)`: 9 of 9 tasks successful
- pass `pnpm format:check (kapdh-platform)`: All matched files use Prettier code style
- pass `pnpm --filter @kapdh/admin test`: 18 files, 190 tests passed. An earlier run of only the payments test files, while about 38 node processes from other agents were running, failed on 1 s findBy waits and 20 s test timeouts. The same files all passed when run in smaller groups. The final full-suite run was green.
- not_run `API tests, test:pg, contracts:lint`: No API, contract or database files changed; only apps/admin was touched.

## Contract changes


## Shared changes
- kapdh-platform/apps/admin/src/components/ui/Tabs.tsx (foundation, additive): new optional TabItem.countLabel. When it is set, the visible count gets aria-hidden and an sr-only ', <countLabel>' is added, so the tab's accessible name reads e.g. 'Verifikasi Pembayaran, 23 menunggu verifikasi'. Behaviour is unchanged when it is not set. The payments page is the only user of TabItem.count.
- kapdh-platform/apps/admin/src/api/mocks/payments.ts (shared payments mock, additive): new test controls mockPayments.fail(method, path, {status, code, message, times}), mockPayments.hold(method, path) returning a release function, clearMethods() and linkOwnerToAdmin(paymentId). The exported `routes` now wrap every handler with the hold and fail checks; method, path and behaviour are unchanged when no control is set, and reset() clears the controls. Fixture data and counts are unchanged.

## Open issues
- Finding 6 is fixed without a contract change: the adjustment panel makes one extra GET /admin/payments/{payment_id} to read the server's conflict_of_interest. If api-payments (owner of admin-payments.yaml) adds an `actions.can_process` or `conflict_of_interest` field to AdminPaymentAdjustment, the panel could drop that request. This is optional.
- Carried over from the builder: D13 adminRecordPayment (POST /admin/payments) still has no admin UI or mock route. It was outside this slice's brief and needs a member picker.
- Carried over from the builder: nav.ts (foundation) still labels /payments 'Verifikasi Pembayaran' for an admin who has only settings.manage.
- Mock evidence is not AC proof (PRD 7.3). The real concurrency and conflict-of-interest proof belongs to the API PG lane.

## Handoff notes
Everything is committed on worktree-wf_2dfc8f13-ce6-8; HEAD is b67ddee, on top of the builder's b96e14f.

Files changed, all under kapdh-platform/apps/admin/src:
- routes/payments/PaymentDecisionPanel.tsx (CancelInstruction reason focus)
- routes/payments/AdjustmentPanel.tsx (cancel reason focus; conflict-of-interest check through paymentDetailKey(payment_id); confirmation before removing a refund account; refund-without-account warning)
- routes/payments/VerificationTab.tsx and AdjustmentsTab.tsx (focus request when ?payment= or ?adjustment= changes)
- routes/payments/MethodsTab.tsx (focus to 'Tambah metode' after delete)
- routes/payments/MethodFormDialog.tsx (requestBody/sameAsBase; save disabled when nothing changed)
- routes/payments/PaymentsPage.tsx (COUNT_LABEL)
- components/ui/Tabs.tsx (countLabel)
- api/mocks/payments.ts (fail/hold/clearMethods/linkOwnerToAdmin; handlers wrapped)
- tests: states.test.tsx (new); updates to adjustments.test.tsx, methods.test.tsx, payments.test.tsx and testing.tsx

Behaviour changes other slices may see:
- With ?payment= or ?adjustment= in the URL, the page moves focus to the panel heading once it loads. This includes a full page load.
- The adjustment panel shows 'Memeriksa pembayaran asal...' until the payment detail has loaded. Tests should use findByRole for 'Tandai selesai', 'Ubah' and 'Batalkan'.

For new screen-state tests, use mockPayments.fail(...) and mockPayments.hold(...).
