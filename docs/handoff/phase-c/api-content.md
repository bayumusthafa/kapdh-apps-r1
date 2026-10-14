# Phase C slice: api-content

Final report after build, adversarial review (7 findings) and fixes (commit 10ad21d).

## Summary
I fixed all 7 review findings for the api-content slice. Each fix has a test that would have caught the original problem, and all required checks pass. The work is one commit, 10ad21d, on top of the builder's commits; I squashed my own checkpoint commits into it, and its file tree is identical to the tree I verified.

1. **Image deleted while still in use (medium, real).** Every content save that attaches, references or deletes an image now first locks those `files` rows (FOR NO KEY UPDATE, in id order, after the post/page/banner row itself). The lock is taken even for images that are already attached, and the delete path locks the file before checking whether anything still uses it. So whichever request comes second waits:
   - if the save commits first, the delete sees the new reference and keeps the image;
   - if the delete commits first, the save sees the image is deleted and gets 400 `field_errors.body_html`.
   I added three real PostgreSQL 17 tests: both of these orderings, and the deadlock case from finding 4. I confirmed they fail when the locks are removed.

2. **Legal page text cut off in the audit (medium, real).** Post and page bodies are now limited to 200,000 characters *after* sanitising (400 `field_errors.body_html` on create and update). The audit size limit for full documents went from 1 MB to 2 MiB, which covers the worst case (200,000 control characters, 6 bytes each in JSON). Publishing a page now also checks that the audit entry would hold the published title and body exactly, and cancels the whole publish if not. Tests cover a link-heavy body and a body of ampersands (both rejected), and the largest valid body (199,957 characters), which publishes with its audit text complete.

3. **Error responses marked cacheable (low, real).** The `@Header` decorator is gone. The handler now sets `no-store` first and switches to `public, max-age=60` only when the page loads successfully. Tests check the header on 200, on a 404 for a page not yet published, on 400 and on 429.

4. **Deadlock between two saves (low, real).** Fixed by the id-ordered locking in item 1. Post, page and banner writes also now retry the whole transaction up to 3 times on a deadlock or serialization error (this replaces the retry loop that only post delete had). The real-PostgreSQL test returns 200 for both saves; without the fix it failed.

5. **Reviewer's scratch test committed (low, real).** Deleted.

6. **Home seat count ignores expired holds (low, real).** GET /home now treats unpaid holds that have expired but not yet been released as free, the same rule the event list and detail use (Events tag rule). It only reads; it never releases holds. The e2e test includes the edge case where a hold expires exactly now, and checks that nothing in the database changes.

7. **Core audit files changed without being declared (low, real).** They are now listed under shared changes, and I added unit tests for custom limits and for the full-document limits.

The contract changes are description-only and recorded in `CHANGELOG.md`. Totals: API tests 497/497, PostgreSQL lane 74/74.

## AC coverage
- [covered] Finding 1 (medium): discardIfUnreferenced vs attachBodyImages race: Fixed in content-media.service.ts: lockFiles locks FOR NO KEY UPDATE in id order, and discardIfUnreferenced locks before checking references. Two tests in test/pg/content.pg.test.ts: (1) page save held after its UPDATE while the cover is replaced: the cover replacement waits for the lock, both return 200 and the old cover stays ready; (2) cover deleted first: the page save waits, then gets 400 and the page is unchanged. Both failed when the row locks were removed.
- [covered] Finding 2 (medium): page.published audit truncation: ContentMediaService.sanitizeBody rejects a sanitised body over 200,000 characters (CONTENT_BODY_HTML_MAX). AUDIT_DOCUMENT_LIMITS.maxBytes is now 2 MiB. pages.service publish cancels unless the audited body_html and title match the published copy exactly. Tests: pages.e2e (link-dense and ampersand bodies give 400; largest valid body of 199,957 characters publishes with the full audit text); admin-posts.e2e (same limit for posts); sanitize.test.ts (worst case of 200,000 control characters kept in full).
- [covered] Finding 3 (low): cache-control on error responses: public-pages.controller.ts sets no-store first and public, max-age=60 only on success. pages.e2e checks the header on 200, on 404 for a page about to be published (then 200 after publishing), on 400 and on 429 for both endpoints.
- [covered] Finding 4 (low): opposite-order attach deadlock: Files are locked in sorted id order before attaching, and post/page/banner writes retry on 40P01/40001 (retryContentTransaction). Test in test/pg/content.pg.test.ts: two drafts referencing [A,B] and [B,A], held at the attach trigger, both return 200 and both files end up attached.
- [covered] Finding 5 (low): committed reviewer scratch test: test/content/zz-review-scratch.e2e.test.ts deleted; API test count is now 497 with no placeholder tests.
- [covered] Finding 6 (low): Home seats ignore expired holds: home.service.ts adds a read-only correlated count of awaiting_payment tickets with hold_expires_at <= now; seatsAvailable() and registrationState() use it. home.e2e test 'AC F09-2 (proyeksi kursi...)' covers mixed expired and active holds, the hold_expires_at = now boundary, a still-held event that stays sold_out, and checks no writes happen.
- [covered] Finding 7 (low): core audit change not declared, untested: Listed in shared_changes. Two new unit tests in src/core/audit/sanitize.test.ts: custom limits override the defaults while secret keys are still removed, and AUDIT_DOCUMENT_LIMITS keeps the worst-case document in full.
- [covered] Slice ACs (F08-1..4, F15-1, F15-4, F15-5, PRD 3.8, F-01) still covered: All builder tests pass unchanged: API 497/497 and PostgreSQL lane 74/74 (including the existing like, announce and legal concurrency tests).

## Verification
- pass `pnpm build`: 10/10 tasks
- pass `pnpm typecheck`: 15/15 tasks; I also ran tsc for the API src and test tsconfigs directly, both clean
- pass `pnpm lint`: 9/9 tasks; pnpm --filter @kapdh/api lint run directly also clean (exit 0). The contracts lint shows the 2 known warnings.
- pass `pnpm test`: Second full run: 15/15 tasks, API 497/497, admin 143/143. On the first full run one admin test failed: payments.test.tsx 'pencarian di-debounce...', a timing-based test in apps/admin, which this slice does not touch. It passed when admin ran alone (143/143) and on the second full run.
- pass `pnpm --filter @kapdh/api test:pg`: 11 files, 74/74 (71 before + 3 new content concurrency tests). The known embedded-postgres teardown message 'done is not a function' still appears; exit code 0.
- pass `pnpm contracts:lint`: Valid; the 2 known warnings remain
- pass `pnpm format:check`: All matched files use Prettier code style
- pass `PATH=/c/flutter/flutter/bin:$PATH pnpm contracts:test-dart`: Not on the required list; run because contract descriptions changed. Analyze is clean and all Dart tests pass.
- pass `Regression proof: content-media lockFiles without FOR NO KEY UPDATE, then vitest --config vitest.pg.config.ts test/pg/content.pg.test.ts`: With the lock removed, the 3 new tests failed as expected (no lock wait observed, and 400 instead of 200 in the deadlock case). The file was restored afterwards and all 8 tests pass.

## Contract changes
- content.yaml (description only, additive): listPublicPages/getPublicPage now say only 200 responses carry Cache-Control: public, max-age=60, and error responses (400/404/429) carry no-store. HomeEvent.seats_available now documents the Events seat rule (expired, unreleased holds count as free; registration_state uses the same value).
- admin-content.yaml (description only, additive): body_html in AdminPostCreateRequest, AdminPostUpdateRequest, AdminInfoPageCreateRequest and AdminInfoPageUpdateRequest says the sanitised result is also limited to 200,000 characters, otherwise 400 field_errors.body_html. maxLength and other constraints are unchanged.
- packages/contracts/CHANGELOG.md: three new bullets under 'Konten: implementasi API (modul api-content, Tahap C)'. No operation, field or schema was renamed or removed.

## Shared changes
- apps/api/src/core/audit/{sanitize.ts, write-audit.ts, audit.service.ts} (owned by core-api; additive, carried over from the builder and not reported then): new AuditLimits type and AUDIT_DOCUMENT_LIMITS (maxStringLength 250,000, maxBytes now 2 MiB, up from the builder's 1 MB). sanitizeAuditValue(value, limits = AUDIT_LIMITS) plus optional AuditRecord.limits and AuditEntry.limits. Default behaviour is unchanged. The only caller passing the document limits is the page.published audit.
- apps/api/src/core/audit/sanitize.test.ts (core test file): 2 new unit tests for custom limits and for AUDIT_DOCUMENT_LIMITS.
- Carried over from the builder: apps/api/package.json + pnpm-lock.yaml add sanitize-html 2.17.7 and @types/sanitize-html 2.16.2. The integrator may need to regenerate the lockfile.
- No database migration was added.

## Open issues
- Images used in a post or page body are still never deleted when removed from the body (builder's open issue, unchanged). Only covers and banner images are deleted when no longer referenced.
- isReferenced treats any '/files/public/<id>' in a body as a reference, links included, so an image linked with <a> is also kept. Only <img> references are locked; a link added at the same moment as the image is deleted can point to a deleted file. That is a broken link, not a broken image.
- Post, page and banner saves that use the same image now run one after another, because the file row is locked. These transactions are short.
- The audit check in page publish cannot fail for bodies saved under the new limit. It only guards drafts saved before this fix, which then get 400 field_errors.body_html instead of being published with a cut-off audit.
- Carried over from the builder: a new cover or banner image must be uploaded by the admin who saves it (FilesService.attach checks the owner); content.announce runs one notify per member inside the claim transaction.

## Handoff notes
Fixer commit 10ad21d on branch worktree-wf_b8bd7d01-232-5, on top of cd7d8a0 (builder) and dba9b7e (the commit that added the scratch test, which this commit deletes).

**Concurrency rule for anyone touching content images** (kapdh-platform/apps/api/src/modules/content/content-media.service.ts):
- Lock the content row first (post, page or banner).
- Then call `media.lockFiles(tx, [every file the operation will attach, reference or release])`. This takes FOR NO KEY UPDATE in id order.
- Only then call attachNew, attachBodyImages or discardIfUnreferenced. attachBodyImages and discardIfUnreferenced also lock the files themselves; locking a row twice in the same transaction is harmless.
- Writes are wrapped in `retryContentTransaction` (content.util.ts): up to 3 attempts on 40P01/40001.

**Other changes:**
- Body limit: `ContentMediaService.sanitizeBody(dirty, emptyMessage)` rejects an empty body, or a sanitised body over `CONTENT_BODY_HTML_MAX` (200,000), with 400 field_errors.body_html. The admin web editor should show this message on the body field.
- Public pages: exported constants `PUBLIC_PAGES_CACHE_CONTROL` and `PUBLIC_PAGES_ERROR_CACHE_CONTROL` in public-pages.controller.ts. Headers are set inside the handler via `@Res({ passthrough: true })`.
- Home: `seatsAvailable(event, expiredHolds)` and `registrationState(event, now, expiredHolds)` in home.service.ts follow the Events seat rule. If the api-events slice exports a shared helper, the integrator can switch to it.

**Tests:**
- Concurrency (real PostgreSQL 17), kapdh-platform/apps/api/test/pg/content.pg.test.ts: the `withHold` helper pauses an API transaction after a chosen UPDATE using a temporary trigger plus an advisory lock. Trigger WHEN clauses only ever contain uuids the test generated.
- e2e: kapdh-platform/apps/api/test/content/{pages,admin-posts,home}.e2e.test.ts
- unit: kapdh-platform/apps/api/src/core/audit/sanitize.test.ts
