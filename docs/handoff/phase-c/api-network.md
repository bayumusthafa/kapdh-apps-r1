# Phase C slice: api-network

Final report after build, adversarial review (3 findings) and fixes (commit 82eb938).

## Summary
I checked all 3 findings. All are real and all are fixed, with tests that would have caught each one. The work is in fix commit 82eb938, on top of 070d65a. No contract, schema, migration or shared files were changed.

1. (medium) A NUL byte in a free-text query parameter gave 500 instead of 400. I reproduced it first with new tests: `GET /directory?q=ab%00cd` returned 500, and `GET /admin/masters/{kind}?q=a%00` did too. `q` and `city` in the directory search, and `q` in the admin master list, now reject any control character with 400 VALIDATION_ERROR on that field. This is the same rule the label field already uses. The check uses new helpers `hasControlChar` and `hasNul` in `directory.query.ts`.

2. (low) Hand-edited cursors could still cause 500 errors. Cursor contents are now limited to values the server can produce and the columns accept:
   - admin masters: `o` must be within -32768..32767, `u` must be a whole number from 0 up to the largest safe integer, and `l` must not contain NUL;
   - directory: `n` must not contain NUL. NUL is the only character PostgreSQL text cannot hold, so real names with other characters still work.
   A forged cursor now returns 400 VALIDATION_ERROR on the `cursor` field. Tests also show that the smallint limits themselves and a normal name cursor are still accepted.

3. (low) Nothing tested that a failed audit write cancels the master change (AC F17-1). I added 3 e2e tests that make `AuditService.write` fail once, for POST (both kinds), PATCH and DELETE. Each asserts a 500, that no row was inserted, that label/active/sort_order/version are unchanged, that the row was not deleted, and that only `master.created` is in the audit log. Each test also shows the action works again once audit recovers. As a check, I temporarily made the audit write swallow its errors: all 3 tests failed (201, 200 and 204 instead of 500). I then restored the code.

All checks passed: build, typecheck, lint, test (API 457 tests, admin 143), test:pg (72), contracts:lint and format:check.

## AC coverage
- [covered] AC F10-1 (validation of search input, PRD 5.2): test/network/directory.e2e.test.ts 'AC F10-1, PRD 5.2: karakter kontrol (NUL) pada q/city dan cursor palsu → 400 VALIDATION_ERROR, bukan 500': q with NUL or BEL, city with NUL or ESC, a name_asc cursor with NUL in n, and a cohort_desc cursor with NUL in n all return 400 with the matching field_errors; a forged but valid cursor is still accepted
- [covered] F-15 / adminListMasters 400 (PRD 5.2): test/network/admin-masters.e2e.test.ts 'F-15, PRD 5.2: q berkarakter kontrol dan cursor palsu ...': for both professions and skills, q with NUL or BEL, manual o=±40000, NUL in l for manual/label_asc/label_desc/usage_desc, and u=-1 all return 400 on field q or cursor; o=-32768 and 32767 still return 200
- [covered] AC F17-1 (audit failure cancels master change): test/network/admin-masters.e2e.test.ts describe 'AC F17-1: kegagalan mencatat audit membatalkan perubahan master': the POST, PATCH and DELETE tests make AuditService.write fail once and assert a 500 with no change to the data or the audit log. With audit errors swallowed on purpose, all 3 tests failed.
- [covered] AC F10-1, F10-2, F10-3, F10-4, F10-5, F15-1, F15-4, F12-1, PRD 5.4: Unchanged from the builder's report; all earlier network tests still pass (test/network: 4 files / 53 tests; test:pg network.pg.test.ts)

## Verification
- fail `npx vitest run test/network (apps/api), before the fix`: Expected failure that confirms the findings: the new tests got 500 for q=ab\u0000cd on /directory and q=a\u0000 on /admin/masters/professions
- pass `npx vitest run test/network (apps/api), after the fix`: 4 files / 53 tests (48 before + 5 new)
- pass `mutation check: audit write errors swallowed in masters.service.ts`: All 3 new AC F17-1 tests failed against the changed code (201, 200 and 204 instead of 500); masters.service.ts was restored with git checkout
- pass `pnpm format:check`: All matched files use Prettier code style
- pass `pnpm build`: 10/10 tasks successful
- pass `pnpm typecheck`: 15/15 tasks successful
- pass `pnpm lint`: 9/9 tasks successful; only the 2 known contract warnings
- pass `pnpm test`: Exit 0; API 35 files / 457 tests, admin 143, config 23, database 23, storage 33, shared 16, web 5; 15/15 tasks. The flaky tests noted earlier did not fail in this run.
- pass `pnpm --filter @kapdh/api test:pg`: 11 files / 72 tests, exit 0; the known embedded-postgres 'done is not a function' teardown message still appears
- pass `pnpm contracts:lint`: Valid with the 2 known warnings; events: 17 schemas, 20 examples

## Contract changes


## Shared changes


## Open issues
- Cross-cutting (outside this slice, for the core-api owner): any module that passes free-text query strings to SQL without rejecting NUL gets the same 500 (SQLSTATE 22021). A core-level fix would close it for every module: either validateQuery rejects \u0000, or ErrorFilter maps 22021 and 22003 from request input to 400. The network module now validates its own input.
- Still open from the builder report: flaky tests outside this slice under the full parallel `pnpm test` (apps/admin payments.test.tsx debounce, flow.test.tsx; core qr-token.service.test.ts with the 'xx' signature tamper). They did not fail in this fixer run.
- Still open from the builder report: the directory rate limits (search 60/min and 600/h, profile 120/min and 1200/h) need confirming with D1/D8; name ordering is by bytes of the lowercased name, so names starting with a non-ASCII letter sort after 'z' — product should confirm this is acceptable.
- GET /masters/{kind} (listMasters, me.yaml) belongs to the membership slice.

## Handoff notes
Fix commit 82eb938 on branch worktree-wf_b8bd7d01-232-6, on top of 070d65a.

Code changed:
- kapdh-platform/apps/api/src/modules/network/directory.query.ts: new exported helpers `hasControlChar(value)` (matches \p{Cc}) and `hasNul(value)`. Other modules can reuse them for free-text search input.
- kapdh-platform/apps/api/src/modules/network/directory.service.ts: `searchQuerySchema` q and city reject control characters (400 on field q or city); cursor `n` rejects NUL (400 on cursor).
- kapdh-platform/apps/api/src/modules/network/masters.service.ts: listQuerySchema q rejects control characters; cursor schema limits:
  - `o` to the smallint range;
  - `u` to a whole number from 0 up to the largest safe integer;
  - `l` to text with no NUL.

Tests added:
- kapdh-platform/apps/api/test/network/directory.e2e.test.ts: 1 test for control characters and forged cursors.
- kapdh-platform/apps/api/test/network/admin-masters.e2e.test.ts: 1 test for control characters and forged cursors, plus describe 'AC F17-1: kegagalan mencatat audit membatalkan perubahan master' (3 tests using vi.spyOn(t.app.get(AuditService), 'write').mockRejectedValueOnce).

API behaviour is unchanged for valid input. Clients only see new 400 VALIDATION_ERROR responses for input that used to cause a 500.
