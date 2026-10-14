# Phase C slice: mobile-auth-recovery

Final report after build, adversarial review (7 findings) and fixes (commit 8df3c4c).

## Summary
All 7 review findings were checked and found real. All 7 are fixed, each with tests. Two commits sit on top of the builder's 1d9e552: 3702816 (wip) and 8df3c4c (fix). flutter analyze reports no issues. flutter test passes 402 tests (385 before plus 17 new). To confirm the tests catch the bugs, I ran them once against the old lib/ from 1d9e552: 19 new or changed tests failed there, covering every finding. After restoring the fixed code they all pass.

**Fixes**

1. **Email-correction sheet could close mid-request (medium).**
   - The POST /auth/email-correction request now runs in the OTP screen (`_submitCorrection`), not in the sheet. `showEmailCorrectionSheet` takes an `onSubmit` callback that returns `EmailCorrectionFeedback` or null.
   - If the sheet is closed while the request is running (for example dragged down), the screen still applies the new email_change challenge, credentials, login email and draft.
   - While sending, the sheet ignores taps outside it and the back button (`PopScope(canPop: !_busy)`). Its fields are disabled. Verify, resend and the change-email link wait for the correction to finish.

2. **No recovery when the correction response is lost (medium).**
   - A network error, 5xx or 408 on email-correction is recorded as an unknown outcome, and the typed new email is kept as the login email.
   - A later 410 then triggers a check through POST /auth/login instead of a dead end. This applies whether the 410 comes from a retried correction, from verify, or from resend.
   - The login check tries the new email first, then the old in-memory email. A 401 moves on to the next one:
     - next=verify_otp continues with the returned challenge and shows "Email sudah diubah ke …".
     - next=home creates the session.
     - deletion_pending or disabled go to login with a notice.
     - A network error keeps the sheet open so the user can retry.
     - Any other definitive error (for example 429) asks the user to log in, with the new email filled in.

3. **Forgot-password challenge link hid behind an old challenge (medium).** `ForgotOtpScreen` now shows the link's loading, failed (with retry) or gone state even when another password_reset challenge is in memory. A code from the admin's email can no longer be typed into a cancelled challenge.

4. **Admin reset link dropped while signed in (low).**
   - `redirect.dart` now lets an authenticated or offline session open `/forgot/otp?challenge=<uuid>`, including from splash and maintenance.
   - The screen explains the situation and offers "Keluar dan lanjutkan" (sign out, then read the same link through /auth/otp/status) or "Kembali ke beranda". If the server revokes the session (refresh rejected), the link continues on its own.
   - `/register/otp?challenge=` and links without a valid id still go to home.

5. **Leaving the new-password step silently discarded the reset grant (low).** `ResetPasswordScreen` now handles every back action through `PopScope(canPop:false)` and `_onBack`. While the one-time grant is still valid, both the header back button and the system back button ask for confirmation. After saving, back goes to login. After expiry, back returns to the email step and clears the reset token.

6. **Misleading consent label (low).** The text reads "Versi berlaku: …" until the box is ticked and "Versi yang disetujui: …" after.

7. **Test names (low).** Every new test from the slice now starts with an AC, PRD, F- or N- id.

**Refactor:** the private `_ResultPanel` moved to `auth_widgets.dart` as `AuthResultPanel`. The reset screen and the signed-in link notice both use it.

## AC coverage
- [covered] Finding 1: the sheet can be closed while the correction request is running (PRD 2.2, 4.5): otp_screen_test 'PRD 2.2, PRD 4.5: selama koreksi dikirim, ketukan di luar lembar dan tombol kembali diabaikan' (barrier tap and handlePopRoute while a Completer is pending; the sheet stays open; the result is applied) and 'PRD 2.2, PRD 4.5: lembar yang diseret tertutup saat koreksi dikirim tidak membuang hasilnya' (fling closes the sheet; the pending 200 still sets challenge-2, the credentials, the draft email and the snackbar). Both fail on 1d9e552.
- [covered] Finding 2: correction with an unknown outcome followed by 410 (AC F01-4, PRD 4.5): otp_screen_test group 'koreksi email yang hasilnya tidak diketahui' (5 tests): retry 410 leads to login with the new email and the email_change challenge; sheet closed then verify 410 is checked with the new email; new email 401 falls back to the old email; login check network error keeps the sheet open; login cooldown leads to sign-in with the new email filled in. All fail on 1d9e552 except the last, which was added afterwards.
- [covered] Finding 3: link state takes priority over an in-memory challenge (AC F16-4): challenge_link_test 'AC F16-4: tautan pengurus saat kode pemulihan lain di memori: status tautan diutamakan' (loading skeleton, then error with Coba lagi, then success, and verify uses the link's challenge_id) and 'AC F16-4: tautan tidak berlaku (410) walau kode pemulihan lain masih di memori'. Both fail on 1d9e552.
- [covered] Finding 4: signed-in member opens the admin reset link (AC F16-4): auth_flow_unit_test 'AC F16-4: tautan reset saat masih masuk tidak dibuang...' and '...saat maintenance dan masih masuk ditunda lalu dipulihkan'. challenge_link_test group 'tautan pemulihan saat anggota masih masuk' (5 tests: sign out then the link continues; server revocation through refresh 401 continues the link; back to home; cold start with saved session; /register/otp link still goes home).
- [covered] Finding 5: leaving the new-password step needs confirmation (PRD 4.5, 2.5, AC F02-4): forgot_password_flow_test 'AC F02-4, PRD 4.5: keluar dari Password Baru meminta konfirmasi...' (header back with stay keeps input and token; system back with confirm goes to /forgot and clears the token), plus '...setelah izin habis, kembali tidak perlu konfirmasi' and '...password tersimpan: tombol kembali sistem menuju masuk tanpa konfirmasi'.
- [covered] Finding 6: consent version label (F-01, N-15): register_screen_test 'F-01: tautan baca ...' asserts 'Versi berlaku' before ticking, 'Versi yang disetujui' after ticking, and the label going back after unticking. The policy-change test asserts 'Versi berlaku ... versi 3' and then 'disetujui' after re-ticking.
- [covered] Finding 7: new test names start with an AC or PRD id: Renamed the tests the reviewer listed and the other new tests that lacked an id, in otp_screen_test, forgot_password_flow_test, auth_flow_unit_test, challenge_link_test, register_screen_test and login_screen_test.
- [covered] Builder ACs (F01-1..4, F02-1, F02-4, F16-4, PRD 2.5, PRD 2.2, consent, guideline p5, N-11) remain intact: Full flutter test suite: 402 passed, including all of the builder's 76 auth tests.

## Verification
- pass `cd kapdh-platform && pnpm install`: Already up to date; finished in 1.7s.
- pass `cd kapdh-platform && pnpm build`: 10/10 tasks successful (turbo cache). The Dart SDK is present in packages/contracts/dart/kapdh_api/lib/src.
- pass `cd kapdh-mobile && flutter.bat pub get (run as part of analyze)`: Got dependencies!
- pass `cd kapdh-mobile && flutter.bat analyze`: No issues found (final run after the last edit and formatting).
- pass `cd kapdh-mobile && flutter.bat test --timeout 120s`: 00:42 +402: All tests passed! (385 before the fix plus 17 new).
- fail `New and changed auth tests run against the pre-fix lib/ (git checkout 1d9e552 -- kapdh-mobile/lib), then restored`: This failure was intended. It shows the tests catch the bugs: 19 tests failed on the old code, covering all 7 findings. The fixed lib/ was then restored from HEAD and the tree is clean.
- fail `cd kapdh-mobile && dart.bat format --output=none --set-exit-if-changed lib test`: Only lib/app/theme/kapdh_tokens.dart would change. It was already unformatted on main and is outside this slice. Every file touched by this fix is formatted.

## Contract changes


## Shared changes
- kapdh-mobile/lib/app/redirect.dart (mobile-foundation): one more line in resolveRedirect, in the authenticated/offlineLastKnown branch. `if (group == RouteGroup.forgotOtp && _isChallengeLink(location)) return null;` lets a signed-in member open the admin reset link /forgot/otp?challenge=<uuid>. Because of it, _landing restores the link after splash or maintenance. It sits right before the existing `_authGroups` landing check, not in _anonymous, so a conflict with the sibling branch wf_43c6809b-584-6 is unlikely. The builder's earlier redirect.dart and deep_links.dart changes still apply.

## Open issues
- No finding was rejected; all 7 were confirmed and fixed.
- Remaining edge case: when there is no email/password in memory (the OTP screen was opened only from a ?challenge= link) and the login check with the new email gets 401, the user is asked to log in with the new email filled in. The old email is only known in masked form, so it cannot be tried.
- Each 401 in the login check counts toward the server's login-failure limit (10 per 15 minutes), so at most 2 for each unknown-outcome check (new email, then old email).

## Handoff notes
Merge: three commits on worktree-wf_43c6809b-584-7: 1d9e552 (builder), 3702816 (wip) and 8df3c4c (fix). The builder's note about a possible conflict with wf_43c6809b-584-6 in redirect.dart _anonymous still applies. The new redirect line is in the authenticated branch.

API changes inside lib/features/auth since the builder's handoff:
- email_correction_sheet.dart:
  - `showEmailCorrectionSheet(context, {required EmailCorrectionSubmit onSubmit, String? currentEmail})` now returns Future<void>.
  - `EmailCorrected` and `EmailCorrectionChallengeGone` were removed. The caller owns the request and applies the result itself.
  - `EmailCorrectionFeedback` carries message, fieldErrors and retryAfter, and has a `fromError` constructor.
- auth_widgets.dart: new shared `AuthResultPanel` (icon, title, message, actions).
- ForgotOtpScreen shows a signed-in notice when a session exists.

New test keys:
- forgot-link-signout and forgot-link-home (signed-in link notice).
- reset-leave-stay and reset-leave-confirm (dialog when leaving the new-password step).

Testing tip: never `await` a session or dio call directly inside testWidgets. It hangs in fake async until the 10-minute test timeout. Use unawaited(...) and then settle(tester).
