# Final integration R1.0: Phase D client hardening and Phase E (E1-E4)

Integrator report for the last merge round of the R1.0 build. Integrator worktree branch
`worktree-wf_21c04bba-38a-1`, branched from `main` at `5c59999` (Phase D API hardening already merged: API 2674 tests,
PG lane 235). Branches were merged one at a time with `git merge --no-ff --no-edit`, in the order below. After each
merge the build and the tests most affected by that branch were run before continuing; the full verification ran once
at the end (section 8). Environment: Windows 11 + Git Bash, Node 24.19, pnpm 10.28, Flutter 3.47.2, ShellCheck 0.11.0.
No Docker, nginx, psql, actionlint, physical devices or GitHub Actions runner on this machine.

| # | Branch (tip) | Slice | Merge commit | Conflicts | Integration commit |
| - | ------------ | ----- | ------------ | --------- | ------------------ |
| 1 | `worktree-wf_0181d2bd-bcd-12` (`2b1fda1`) | Phase D admin hardening: D13 "Catat iuran", payment deep links, admin `test:live` lane | `c554a3c` | none | |
| 2 | `worktree-wf_0181d2bd-bcd-13` (`30f02d1`) | Phase D mobile hardening: route matrix, privacy cache eviction, `integration_test` N-03 harness | `297c7dd` | none | |
| 3 | `worktree-wf_7d813f46-21c-6` (`bcf45b3`) | E1 containers: Dockerfiles, nginx admin/web, release job + go-live gate, Compose fallback/staging, ADR | `c850da5` | 2 | |
| 4 | `worktree-wf_7d813f46-21c-7` (`3abd652`) | E2 CI/CD: `.github/workflows`, contract gate, fastify 5.12.5 override, image pipeline, ADR | `e4d15c7` | 13 | `dd0170e` |
| 5 | `worktree-wf_7d813f46-21c-8` (`3cca104`) | E3 backup/restore/monitoring/load-test tooling and runbooks | `edc3e08` | 3 | `5bd66e4` |
| 6 | `worktree-wf_7d813f46-21c-9` (`aa76651`) | E4 docs: READMEs, ADR 001-017, production-init/go-live/app-store runbooks, UAT checklist | `c22e74d` | 2 | `5e01db7` |

The traceability update and this report were committed in `0ad6028`. An independent review of that tree raised 11
findings; all 11 were verified as real and fixed in one fix-round commit on the same branch (section 10), followed by
a full re-run of the verification (section 8 shows the fix-round run).

## 1. Phase D admin hardening (merge 1)

No conflicts (all changes under `apps/admin`, plus `turbo.json`/root `package.json` for `test:live`, ARCHITECTURE and
traceability lines). Checked after the merge: `pnpm build` 10/10; `@kapdh/admin` `vitest run` 43 files, 618 tests,
all pass; `pnpm test:live` 5/5 (login + TOTP, concurrent decision 409, "Catat iuran" D6-01/D6-02, idle warning, idle
timeout) against the API built from the merged tree.

## 2. Phase D mobile hardening (merge 2)

No conflicts (all changes under `kapdh-mobile`, plus `docs/qa/device-matrix.md`). `pubspec.yaml`/`pubspec.lock` gained
the `integration_test` SDK dev dependency; `flutter.bat pub get` resolved it. Checked:
`flutter.bat analyze` "No issues found!", `flutter.bat test` 912 tests, "All tests passed!".

## 3. E1 containers, release job and go-live gate (merge 3)

E1 was branched before the Phase D API hardening (`fccd56e`), so it met that work here.

- `apps/api/package.json` scripts: E1 added `golive:check`, main (Phase D api-identity) added `account:status`. Both
  kept.
- `apps/api/test/pg/critical-9-2.pg.test.ts` go-live gate scenario (PRD v3.5 9.2 #9; the file labelled it #10 until the
  fix round, section 10): main had an `it.todo` (no go-live gate existed) with a note
  that D4-02 already fails closed at runtime when dues are unset or 0.00; E1 replaced it with the real gate test.
  Chosen: E1's test, main's D4-02 note kept as a comment (runtime fail-closed and pre-release gate complement each
  other). The test file's imports (golive CLI, `approveProductionConfig`, seeds) merged cleanly.

Checked: build, typecheck 16/16; API `golive-gate.e2e` + `app.e2e` 15/15; PG lane `golive-gate.pg`, `release-job.pg`,
`critical-9-2.pg` 3 files, 38 tests (exit 0, the known `embedded-postgres` "done is not a function" message after the
summary); admin `nginx-config.test.ts` + `RichTextEditor.test.tsx` 14/14; web `nginx-config.test.ts` 7/7;
`node infra/scripts/validate-infra.mjs` pass; `sh infra/scripts/release-job.test.sh` all scenarios pass.

## 4. E2 CI/CD (merge 4) and the release-pipeline integration (`dd0170e`)

E1 and E2 were written in parallel and both rebuilt the Dockerfiles and nginx configuration, and each built its own
"single migration job". Thirteen files conflicted.

### 4.1 Textual conflicts (merge commit)

- **`infra/Dockerfile.{api,worker,web,admin}`** (both rewrote them). E1: pinned `# syntax` frontend, BuildKit pnpm
  store cache, `pnpm deploy --legacy` with build assertions (`dist/cli/golive-check.js`, migrations journal, ...),
  `HEALTHCHECK` in every image, a `release` target (psql 17 + `release-job.sh`), admin CSP rendered from the API
  origin and checked by `admin-csp.mjs`, `USER 101`. E2: `KAPDH_COMMIT` build arg validated and baked (reported by
  `GET /health` and `/version.json` for the deploy smoke test), `db/roles.sql` copied into the API image for
  `remote-migrate.sh`, https-only `VITE_API_BASE_URL`. Both used the same base image digests. Chosen: E1's structure
  with all of E2's additions; base images as literal pinned `FROM` lines (E2's `check-workflows.mjs` rejects
  `FROM ${NODE_IMAGE}`; E1's `validate-infra.mjs` accepts both), so both validators pass.
- **`infra/nginx-admin.conf`** (add/add). E1: CSP `connect-src`/`img-src` = exact API origin rendered at build,
  `worker-src`/`frame-src 'none'`, `picture-in-picture=()`, `no-store` for SPA routes and all error statuses,
  `/healthz`. E2: `https://*.kapdh.or.id` wildcard, `no-cache` index. Chosen: E1's (stricter); E2's `/version.json`
  is served by the static-file location.
- **`infra/nginx-main.conf`** (add/add). Chosen: E1's JSON access log without query, Referer, User-Agent or client IP
  (N-14, PRD 5.5) and one worker; E2's note about the missing `user` directive kept. `nginx-web.conf`: E1 + E2 comment.
- **TipTap base CSS** (`RichTextEditorImpl.tsx`). Both turned off `injectCSS` for the strict admin CSP; E1 copied the
  ProseMirror rules into `styles.css`, E2 into `components/ui/tiptap-base.css` (imported by the lazy editor chunk).
  Chosen: one copy, E2's file (complete, includes `-moz-selection`); E1's duplicate removed from `styles.css`.
  `apps/admin/src/nginx-config.test.ts` (add/add) is the union of both test sets.
- **`infra/ci/github-actions-ci.yml`** (E2 deleted, E1 modified): deleted; `.github/workflows/ci.yml` already runs
  the PG lane and `format:check` that E1 added to the template.
- `.dockerignore`, `kapdh-platform/README.md`, `kapdh-mobile/README.md`: union.
- `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `apps/api/package.json` (fastify 5.12.5 + `overrides`, closing four
  high advisories) merged without conflict: E2 is the only branch of this round that changed the lockfile. `pnpm
  install` after this and every other merge left it unchanged; the override (strictest setting) is kept.
- `infra/scripts/validate-infra.mjs` required every `packages/config` key in the env examples and Compose; E2's
  `KAPDH_COMMIT` is baked into the image and must NOT be set at runtime (it would mask the image commit). The
  validator now exempts image-baked keys and fails if an env example sets one.

### 4.2 Semantic integration (`dd0170e`)

After the textual merge the automated production path (E2: `_deploy.yml` → SSH forced command
`infra/ci/remote-migrate.sh` → `roles.sql` → `migrate.js` → `roles.sql`) did **not** run E1's go-live gate, so PRD 9.2
#9 ("unapproved configuration; the gate refuses go-live") held only on the manual `run-release.sh` path. E1 also
published images with its own template workflow and another tag scheme (`sha-<12>`), duplicating E2's
`deploy-staging.yml`/`release.yml` (`sha-<40>`, `crane tag` promotion).

- **`remote-migrate.sh` runs the same sequence and gate policy as `release-job.sh`**: [dump] → `roles.sql` →
  `golive-check.js --preflight` (enforce; refusal = schema untouched) → migrate → `roles.sql` → `seed-reference.js`
  (idempotent, E1 runs it every release) → `golive-check.js --allow-schema-ahead` (E2's `deploy-tag` rollback runs
  an older image on a newer schema). Mode only from the server config (`KAPDH_RELEASE_GATE`, production exception
  needs `KAPDH_RELEASE_GATE_REASON` + `KAPDH_RELEASE_GATE_APPROVER`, printed to the CI log), never from the client
  command. A refusal exits 1, so channels and Coolify are not touched. Tests (`infra/ci/test/remote-migrate.test.mjs`,
  fake `docker`): sequences updated, 5 new (preflight refusal, post-migration refusal + image/env assertions,
  technical error handling, staging report + seed failure, server-only exception). Deliberate remaining difference:
  the CI path does not refuse an image older than the schema (that is how `deploy-tag` rolls back). Since the fix round
  (section 10) it detects that case from the image migration journal and runs only the go-live gate, skipping the old
  image's `roles.sql`, migrations and seed, so no manual `roles.sql` re-apply is needed after a rollback.
- **Image catalog**: `release` (Dockerfile.api target `release`) added to `infra/ci/images.json`, with `target`
  support in `images.mjs` (validated against the Dockerfile stages) and `target: ${{ matrix.target }}` in both build
  steps, so the release image is built, scanned, smoke-tested and promoted with the same digest as the others and
  the Compose fallback can use `vX.Y.Z`.
- **`ci.yml`**: `validate-infra.mjs`, `sh -n` and the release-job dry run in `verify`; new `compose-stack` job (E1's
  entry-point checks, `nginx -t` on production and staging variants, `smoke-static.sh`, `ci-stack-smoke.sh`) required
  by "CI lulus". E1's `infra/ci/github-actions-images.yml` template removed; `validate-infra.mjs` now fails if
  `ci.yml` drops any of these checks (verified by removing them temporarily).
- Runbooks/ADRs: two executors of one release job (`rilis-dan-gerbang-go-live.md` section 1 table, `ci-cd.md` section
  5, `infra/README.md`), tag scheme `sha-<40 hex>`, first production init exception via the server config file.

Checked after merge + fix: build, typecheck; API `trust-proxy` unit + `app.e2e` + `gates.e2e` + `golive-gate.e2e`
32/32; admin nginx/editor/content tests 69/69; `node --test 'infra/ci/test/*.test.mjs'` 58/58; `check-workflows.mjs`
8 files pass; `images.mjs validate` (api, release, worker, web, admin); `validate-infra.mjs` pass; release-job dry
run pass; `@kapdh/config` 25, `@kapdh/contracts` 59 node tests; `pnpm audit --prod` "No known vulnerabilities found"
(fastify 5.12.5 override kept); `format:check` pass.

## 5. E3 backup, restore, monitoring, load tooling (merge 5) and `5bd66e4`

Conflicts (union): `.env.example` (E2 `KAPDH_COMMIT` + E3 `SENTRY_*`), `apps/api/src/bootstrap.ts` (both imports,
both used), `apps/api/test/support/test-app.ts` (testEnv carries both).

E3 added config keys and two database roles after E1/E2 were written (its handoff lists them as integrator notes):

- `validate-infra.mjs` failed with 30 missing keys. Added to `infra/.env.{production,staging}.example` and
  `compose.production.yml`: `STORAGE_FALLBACK_LOCAL_ROOT`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (Compose default
  = `KAPDH_IMAGE_TAG`) for API and worker; separate GlitchTip DSNs (API `SENTRY_DSN`, worker `SENTRY_DSN_WORKER`,
  E3: one project per service); `DELETION_LEDGER_S3_*` for the **worker only** (required in production; E3 states the
  API must not hold them). The validator now fails if the API receives the off-VPS ledger credentials.
- `infra/db/role-passwords.sql` + `release-job.sh`: optional passwords for `kapdh_backup`/`kapdh_monitor`
  (`KAPDH_BACKUP_DB_PASSWORD`, `KAPDH_MONITOR_DB_PASSWORD`); new dry-run scenario `sandi-backup-monitor`.
- `ci.yml`: `sh -n` and the backup/monitoring dry runs (E3 note 2), also enforced by the validator.
- **ShellCheck.** E2's CI job runs `shellcheck --severity=style` on every `infra/**/*.sh`; E1 and E3 scripts had 23
  findings (unused-variable warnings for variables consumed by the sourced `backup/lib.sh`, `lib.sh` without a shell
  declaration, an SC1087 error in `backup.sh`, SC2015 in `staging-smoke.sh`, intentional Traefik literals). Fixed:
  `kapdh-platform/.shellcheckrc` (`external-sources`, `source-path=SCRIPTDIR`) so the existing
  `# shellcheck source=` directives are followed, `# shellcheck shell=sh` in `lib.sh`, `${FILES_SNAPSHOT}` braces,
  if/else in `staging-smoke.sh`, documented disables. ShellCheck 0.11.0 is now clean on all 18 scripts, and the 75
  `run` blocks of the workflows (extracted, `${{ }}` replaced as actionlint does) are clean too.
- Runbooks: Compose fallback and release runbooks point to `backup-restore.md` instead of "not yet available"; the
  secret list includes `DELETION_LEDGER_S3_*` and the DSNs.

Checked: build; API `test/account`, `test/ops`, `src/core/logging`, `app.e2e`, `gates.e2e` 13 files 132/132; PG lane
`backup-roles`, `account-deletion`, `release-job`, `golive-gate` 4 files 25/25; `@kapdh/config` 28, `@kapdh/storage`
41; `sh infra/backup/test/dry-run.sh` 60 pass; `sh infra/monitoring/test/dry-run.sh` 37 pass; release-job dry run
(19 scenarios) pass; `validate-infra.mjs`, `check-workflows.mjs` pass.

## 6. E4 docs (merge 6) and `5e01db7`

Conflicts: `kapdh-mobile/README.md` (E4 rewrite + Phase D mobile `integration_test`/APK notes + E2 `docs/BUILD.md`
paragraph; E4's "no APK/IPA build on this machine" replaced by the Phase D statement that APK debug/profile was built
and run on an emulator) and `kapdh-platform/README.md` (E4 local-run section; CI/deploy sections from the merged tree,
since E4 still described the deleted CI template).

**ADR numbering.** E4 wrote 001-017 and E3 018-022 after it, but E1 used `0002` and E2 `ADR-010`, clashing with E4's
002 (contracts per domain) and 010 (worker runtime). Renumbered into one sequence: E1 → **ADR-023**
(`023-job-rilis-dan-gerbang-go-live.md`), E2 → **ADR-024** (`024-pipeline-ci-cd.md`), each noting its original
number. Every reference was updated (runbooks `ci-cd.md` and `rilis-dan-gerbang-go-live.md`, `infra/README.md`,
`infra/ci/README.md`, `images.json`, `remote-migrate.sh`, `release.yml` error text, ADR-023/024 cross-references);
`git grep` finds no reference to the old file names. `docs/adr/README.md` lists 018-024; ADR-014 is marked
"diperbarui oleh ADR-019" (E3 note 3).

E4's documents predate E1-E3 and the admin/mobile hardening and said "not merged / not available" in several places.
Aligned with the merged tree: root and platform READMEs (`.github`, ADR 001-024, all runbooks, infra contents,
`test:live` and infra lanes, `golive:check`/`loadtest:seed`, new env keys), `production-init.md` (job rilis exists,
Dockerfile.api `--legacy` fixed, admin image with the strict CSP, web/admin on 8080, backup tooling exists: the
remaining blocker is the drill), `go-live.md` (gate `golive:check` closes D2-02; runbooks exist),
`app-store-submission.md` (the D13 "Catat iuran" screen exists), `uat-checklist.md` (U-11/U-12/U-13), ARCHITECTURE
§10 (CI/CD and release job + gate). One contradiction resolved: E1's runbook set the Coolify API healthcheck to `/api/v1/health`,
E4 and the Phase D ledger gate require `/api/v1/health/ready` (a restored replica must not take traffic before the
ledger is re-applied). Chosen: readiness for Coolify; the image `HEALTHCHECK` stays liveness. The review found that
the Compose fallback Traefik still health-checked liveness; fixed in the fix round (section 10, R1), so both deploy
paths now route on readiness.

## 7. Traceability

`docs/qa/traceability.md` now reflects the merged state (each changed row says "Final integration: ..."):

- AC F14-6 partial → covered (readiness ledger gate, Phase D; off-VPS ledger, E3). AC: 87 covered.
- PRD 9.2 #8 partial → covered; #9 covered on both deploy paths. 10/10 covered.
- U-09 partial → covered. U: 8 covered, 5 partial (U-01, U-07, U-11, U-12, U-13 need staging/devices).
- N-06 missing → partial (backup/restore tooling tested, no drill), N-12 missing → partial (D7 matrix enforced,
  emulator smoke). N-01/02/03/05/07/11/13/16 stay partial with the new evidence and the exact remaining step; N-04
  stays missing (capacity tool exists, no numbers). N: 5 covered, 10 partial, 1 missing.
- Section 6: each finding D2-01..D2-14 carries its final status (D2-01 and D2-02 fixed; the others have tooling or
  partial fixes and an operational remainder).
- Every cited test name (598 citations) was checked to exist in the cited file after the merge
  (script in the integrator's scratchpad, not committed); `[pass]` markers on new citations refer to the final run in
  section 8.

## 8. Final verification

Re-run on the fix-round tree (section 10; the first run on `0ad6028` had the same results except where noted). Every
result was observed in the fix-round session. turbo build/typecheck/lint/test runs used `--force`; the `test:pg` and
`test:live` tasks are never cached.

| Command | Result |
| ------- | ------ |
| `kapdh-platform`: `pnpm install` | pass, no tracked file changed (`pnpm-lock.yaml` already contains E2's fastify override resolution) |
| `pnpm build --force` | pass, 10/10 tasks (0 cached) |
| `pnpm typecheck --force` | pass, 16/16 tasks (0 cached) |
| `pnpm lint --force` | pass, 9/9 tasks (2 known redocly `no-ambiguous-paths` warnings in contracts) |
| `pnpm format:check` | pass ("All matched files use Prettier code style!") |
| `pnpm contracts:lint` | pass, valid (2 known warnings); 17 event schemas valid, 20 examples |
| `pnpm exec turbo run test --concurrency=1 --force` | pass, 16/16 tasks: api 126 files / 2718 tests, admin 44 / 628, web 14 / 170, worker 9 / 54, contracts 59 node tests, config 28, storage 41, database 23, shared 16 |
| `pnpm exec turbo run test:pg --concurrency=1` | pass, 9/9 tasks: api 31 files / 257 tests, worker 3 / 11; exit 0 (the known `embedded-postgres` "done is not a function" teardown message prints after both summaries) |
| `pnpm contracts:test-dart` (Flutter on PATH) | pass: `kapdh_api` `dart analyze --fatal-infos` "No issues found!" + 40 tests; fixture package analyze clean + 7 tests |
| `pnpm audit --prod` | "No known vulnerabilities found" (fastify 5.12.5 override) |
| `pnpm test:live` | pass, 8/8 tasks; `admin.live.test.tsx` 5/5 (now also a CI step, R2) |
| `kapdh-mobile`: `flutter.bat pub get` | pass, `pubspec.lock` unchanged |
| `flutter.bat analyze` | "No issues found!" |
| `flutter.bat test --concurrency=4` | 912 tests, "All tests passed!" |
| CI `dart format` command with the R10 pathspec (`lib`, `test`, `integration_test`, `test_driver`, minus the generated token copy), batched with `xargs -n 60` for the Windows command-line limit | 279 files, 0 changed |
| `node infra/scripts/validate-infra.mjs` | "Validasi infra lulus." |
| `node infra/ci/check-workflows.mjs` | 8 files pass, 0 warnings |
| `node infra/ci/images.mjs validate` (extra) | api, release, worker, web, admin valid |
| `node --test 'infra/ci/test/*.test.mjs'` | 65 tests, 10 suites, 65 pass, 0 fail, 0 skipped (first run 58; R6, R7, R11 tests) |
| `sh infra/backup/test/dry-run.sh` | 60 pass, 0 fail |
| `sh infra/monitoring/test/dry-run.sh` | 37 pass, 0 fail |
| `sh infra/scripts/release-job.test.sh` | all 19 scenarios pass (25 checks) |
| `shellcheck --severity=style` on the 18 `infra/**/*.sh` (extra, same as the CI job) and `sh -n` on every infra script | clean, exit 0 |
| Traceability citation check (extra, scratchpad script) | 599 citations, 0 missing |

The brief for this round gave `main` at API 2674 tests and PG lane 235 (not re-measured here); the merged tree has
2718 and 257 (E1 go-live gate and release job, E2 trust proxy/health/gate tests, E3 ops, account, logging and backup
role tests). Admin went from 618 right after merge 1 to 628 (E1/E2 nginx and editor tests).

## 9. Still open (needs real staging, VPS, GitHub or devices)

None of these can be done on this machine (no Docker, nginx, psql, Java/Xcode for release builds, physical devices,
or GitHub runner). Each is an explicit go-live gate item in `docs/runbooks/go-live.md` / `production-init.md`.

- **Docker image builds**: none of the five images (`api`, `release`, `worker`, `web`, `admin`) has ever been built.
  First run of `ci.yml` jobs `docker` and `compose-stack` (BuildKit cache mounts, `pnpm deploy --legacy` inside the
  image, the admin CSP render/check inside the build, `apk add postgresql17-client`, image smoke commands, grype).
- **`nginx -t` and header smoke** of web/admin production and staging variants (the `compose-stack` job), then
  `infra/scripts/staging-smoke.sh` from outside (TLS >= 1.2, WSS upgrade, closed ports, HSTS after all subdomains are
  HTTPS).
- **GitHub Actions first run**: actionlint (only ShellCheck was run locally on the `run` blocks), `check-workflows`,
  the Linux embedded-postgres lanes, osv-scanner, oasdiff (needs the first `contracts-v*` tag; app releases fail until
  it exists), `deploy-staging.yml` with GHCR, the SSH forced command (`remote-migrate.sh` installed per
  `ci-cd.md` section 5, now including the go-live gate and seed), Coolify API deploy and the commit smoke test.
- **Release job on a real database**: `release-job.sh` with psql 17 (`\getenv`, `\if`, `roles.sql`,
  `role-passwords.sql` incl. the new backup/monitor roles) and the Compose stack on the VPS
  (`ci-stack-smoke.sh` runs it in CI first). First production init uses the documented gate exception, removed before
  go-live; go-live requires the gate in `enforce`.
- **restic/backup drill**: `infra/backup/backup.sh` + `restore.sh` + `verify-restore.sh` against real PostgreSQL 17,
  restic, rclone and object storage (R2/B2) with timed RPO <= 24 h / RTO <= 4 h (N-06, U-11, U-12), off-VPS ledger
  bucket with object lock, cron/systemd timers on Ubuntu.
- **Load, realtime and availability reports** on the target VPS/staging: N-01 (10 rps / 15 min), N-02 (100 sessions,
  p95 <= 2 s), N-04 capacity knee, N-05 monthly availability with Uptime Kuma + GlitchTip running.
- **Devices (D7 matrix)**: physical Android 8.0 (API 26, low-end, N-03 sign-off number), latest Android, iOS 15 and
  latest iOS (needs macOS + Xcode; no IPA has been built), plus desktop Chrome/Edge/Firefox/Safari for admin and web
  (no Playwright smoke yet), and a screen-reader pass (TalkBack, VoiceOver, NVDA). Admin has no axe audit.
- **Store submission** (`docs/runbooks/app-store-submission.md`): organisation accounts (D-U-N-S), signing keys,
  listings, privacy forms, reviewer demo account; the D13 mitigation-1 copy changes in the app (texts tying dues to
  unlocking features, listed in that runbook section 2) are still a submit blocker; `assetlinks.json` /
  `apple-app-site-association` and the `/.well-known/` exception in `nginx-web.conf` are not done; app version is
  `0.1.0+1`, below the seeded `min_app_version` 1.0.0.
- Carried over: BullMQ Lua paths against a real Redis; the `embedded-postgres@17.6.0-beta.15` teardown message
  ("done is not a function", exit code 0); Flutter against the merged API (the device smoke uses an in-process fake
  API).
- Fix round leftovers (section 10): the readiness healthcheck in the Compose fallback Traefik, the schema-ahead skip
  in `remote-migrate.sh` and the `PG_EXEC`/`FILES_ROOT` example defaults are tested only with fakes and static
  validation here; they need the same first real runs as above (Compose stack on the VPS, a `deploy-tag` rollback on
  staging, the first backup run). `restore-backup.md` and `storage-migration.md` still write `/data/files` for host
  commands; `backup-restore.md` section 3 now states that on the host this is `FILES_ROOT`
  (`/srv/kapdh/<env>/files`).

## 10. Review fix round

An independent review of `0ad6028` raised 2 medium and 9 low findings. Each was checked against the tree; all 11 are
real and were fixed. None was rejected.

| # | Severity | Finding | Verified | Fix |
| - | -------- | ------- | -------- | --- |
| R1 | medium | The Compose fallback Traefik (`infra/traefik/render-dynamic.sh`) health-checked the API on liveness `/api/v1/health`, so the readiness ledger gate (503 `deletion_ledger: fail`, ADR-014) never took a restored API out of rotation on that path. | yes: lines 121/125, `compose.production.yml` comment, ADR-014:55 | Production and staging API services now use `/api/v1/health/ready`; web/admin stay `/healthz`; the image `HEALTHCHECK` stays liveness. `validate-infra.mjs` asserts the rendered health path per service (checked by reverting the path: 2 failures). Comment in `compose.production.yml`, `compose-cadangan.md` 2a step 4 and the AC F14-6 traceability note cover the Compose path. |
| R2 | medium | No CI job ran `pnpm test:live`, so "CI lulus" did not gate the admin-against-API evidence that D2-14 relies on. | yes: no `test:live` in `.github/workflows` | New step `pnpm test:live` in the `test` job (in `ci-ok.needs`). `validate-infra.mjs` now requires every infra/live needle to sit in a job that `ci-ok` needs (checked by removing the step and by dropping `test` from `ci-ok.needs`). `ci-cd.md` job table, ARCHITECTURE §9.3, D2-14 row updated. |
| R3 | low | PRD 9.2 numbering differed between files: `critical-9-2.pg.test.ts` split PRD bullet 1 in two, so restore was "#9" and the gate "#10" there, in E3's backup docs and in this report, while traceability and the PRD use #8 restore, #9 gate, #10 two Super Admins. | yes: PRD v3.5 9.2 list has 10 bullets | Renumbered to PRD v3.5 order: `critical-9-2.pg.test.ts` header and describe labels (#2, #4-#9), `backup-ops.e2e.test.ts` (#8), ADR-018, `backup-restore.md`, `verify-restore.sh`, `infra/README.md`, `ci.yml` comment, this report. The changed `it` name is updated in traceability; the citation check (599 citations, 0 missing) passes. Remaining "#9" references all mean the go-live gate. |
| R4 | low | ADR-003 still pointed at the deleted `infra/ci/github-actions-ci.yml` and said CI skips the PG lane, Flutter, Dart SDK and format. | yes | Bullet replaced: `.github/workflows/ci.yml` (ADR-024) runs `test` (+ live lane), `test-pg`, format, Dart SDK and Flutter. |
| R5 | low | `infra/ci/README.md` described `remote-migrate.sh` with the old E2 sequence (no gate, no seed). | yes | Row lists the full sequence, the schema-ahead behaviour (R11) and the config file. |
| R6 | low | `.env.production.example` header pointed the Coolify path only at `run-release.sh`/`release.env` with `RELEASE_GATE`; the CI forced command reads `KAPDH_RELEASE_GATE*` from `/etc/kapdh/ci-migrate/<env>.env`, so `RELEASE_GATE=report` there was silently ignored (fail-closed). | yes: `remote-migrate.sh` reads only `KAPDH_RELEASE_GATE*` | Both env examples name both executors, their files and variable names. `remote-migrate.sh` now rejects `RELEASE_GATE`, `RELEASE_GATE_REASON`, `RELEASE_GATE_APPROVER` (config or environment) with an error naming the `KAPDH_` variable; new fake-docker test. `ci-cd.md` section 5 updated. |
| R7 | low | `Dockerfile.admin` accepted only `https://*/api/v1`, while `admin-csp.mjs` also allowed `http://localhost`, a branch that could never run in the image build. | yes | One policy, the strict one: `admin-csp.mjs` accepts only `https://<host>/api/v1` (same as the Dockerfile `case` and `images.json`). New `infra/ci/test/admin-csp.test.mjs` (4 tests) pins the accepted/rejected set and that the Dockerfile check runs before the render. |
| R8 | low | `backup.env.example` assumed Postgres on `127.0.0.1:5432` and files at `/data/files`; in the merged infra Postgres is only on an internal Docker network and files live at `/srv/kapdh/production/files`. `production-init.md` 2.2 set no passwords for `kapdh_backup`/`kapdh_monitor`. | yes: `compose.production.yml` `data` network internal, no ports; `files` bind to `KAPDH_FILES_DIR` | `backup.env.example` and `monitoring.env.example` (same defect) default to `PG_EXEC` into the Postgres container and `FILES_ROOT=/srv/kapdh/production/files` (loopback `PGHOST` kept as a commented alternative); restore section and `LEDGER_REAPPLY_CMD` mount aligned. `backup-restore.md` section 3 explains the topology; `production-init.md` 2.2 sets both role passwords. |
| R9 | low | `kapdh-mobile/docs/BUILD.md` said the Windows build machine has no JDK and Android builds happen elsewhere; Phase D built and ran debug/profile APKs here. | yes: `flutter doctor -v` shows Temurin 21.0.12 configured via `flutter config --jdk-dir` | Row now states the Phase D local APK builds; signed release builds and IPA stay on trusted/macOS machines. |
| R10 | low | The CI `dart format` gate covered only `lib/` and `test/`, not `integration_test/` and `test_driver/`. | yes | Pathspec extended in `ci.yml` and `ci-cd.md`; the same command run locally over 279 files: 0 changed. |
| R11 | low | On a `deploy-tag` rollback `remote-migrate.sh` applied the OLD image's `roles.sql` (twice) to the newer schema, loosening grants on tables that newer releases restrict until someone re-applied the latest file by hand. | yes: `roles.sql` revokes and re-grants DML on all tables, then applies only the restrictions it knows | `remote-migrate.sh` copies the image migration journal, compares it with `drizzle.__drizzle_migrations` (read-only, via the psql image) and, when the database is ahead, skips `roles.sql` (both), migrate and seed with a loud warning; the go-live gate still runs (preflight in enforce, then full `--allow-schema-ahead`). The manual re-apply step is gone from `ci-cd.md` 9, `rilis-dan-gerbang-go-live.md` 6.1 and ADR-023. Tests: sequences now include the schema check; new tests for rollback (skips, gate still refuses), schema unreadable/invalid, journal missing/empty. |

Fix-round test changes: `infra/ci/test` 58 → 65 tests (remote-migrate 15 → 18, admin-csp 4 new); API and PG lanes keep
their counts (only labels changed).
