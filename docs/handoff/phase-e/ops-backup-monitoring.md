# Phase E slice E3: backup, restore, monitoring, load tests and incident operations

Branch `worktree-wf_7d813f46-21c-8`. Main (Phase D hardening, 5c59999) is merged in and conflicts are resolved (see
"Merge with D2-01").

## Summary

| Area | Delivered | Evidence in the repo | Still needs a real run |
| ---- | --------- | -------------------- | ---------------------- |
| Backup (N-06, D9, D2) | `infra/backup/backup.sh`: pg_dump custom on an exported REPEATABLE READ snapshot, manifest stats computed on the same snapshot, restic of `/data/files` after the dump, copy of the off-VPS deletion ledger, `manifest.json` (schema), read-back check, 30-day retention with paired files snapshots + `prune --max-unused 0`, image tag@digest, Uptime Kuma push; systemd timer or cron (UTC) | `infra/backup/test/dry-run.sh` (60 checks, fake tools), `apps/api/test/ops/backup-ops.e2e.test.ts` (SQL on PGlite), `apps/api/test/pg/backup-roles.pg.test.ts` (snapshot export/import as `kapdh_backup` on PG 17) | first backup + drill on staging with real restic/rclone/R2 or B2 |
| Restore (PRD 5.5, 8.4, AC F14-6) | `restore.sh` (clean environment only, roles.sql, pg_restore single transaction, files snapshot from the manifest, `ledger-reapply` over the newest off-VPS bucket + backup copies, outbox lease release, evidence with RTO/RPO), `verify-restore.sh` + `verify-http.mjs` (counts and money totals equal to the manifest, ledger applied, files + sha256 sample, Super Admin, readiness incl. `deletion_ledger`, drill admin login + TOTP, public file) | same as above | timed restore drill (U-11, U-12) |
| Off-VPS deletion ledger (D5-07) | `OffsiteDeletionLedger`: `ledger_open`/`ledger_final` append each entry synchronously to `DELETION_LEDGER_S3_*` (append-only keys, Content-MD5 for object lock) before the StorageDriver copy; failure fails the step; production worker requires the bucket | `apps/api/test/account/offsite-ledger.test.ts`, `deletion-job.e2e.test.ts` (VPS loss restored from the bucket, readiness 200 after re-apply; write failure at both steps), PG 17 CLI test with two `--dir` | bucket with object lock at the chosen provider |
| Monitoring (N-05, D2-08) | `infra/monitoring/check-{host,app,worker,backup}.sh`, `sql/app-health.sql` (role `kapdh_monitor`, column grants only), `realtime-probe.mjs`; runbook with 18 monitors, alert routing Telegram/WhatsApp/email, monthly availability report | `infra/monitoring/test/dry-run.sh` (37 checks), `apps/api/test/ops/monitoring.e2e.test.ts` (probe against a listening API), PG 17 grants test | Uptime Kuma, channels and monthly report |
| Error tracking (PRD 7.1) | GlitchTip/Sentry envelopes from already-safe pino error logs (`SENTRY_DSN`, whitelist of fields, rate limited), API and worker | `apps/api/src/core/logging/error-tracker.test.ts` | a real GlitchTip project; admin web and Flutter have none |
| Load tests (D2-04, D2-05, D2-06) | `infra/loadtest/api-load.mjs` (N-01 and N-04 step mode), `realtime-load.mjs` (N-02 + reconnect sync), CLI `loadtest:seed` (PRD 2.4 dataset, staging only) | `apps/api/test/ops/loadtest.e2e.test.ts` (seed + all modes against a listening test API) | the actual numbers on the target VPS |
| Storage migration (PRD 5.4) | `FallbackReadDriver` + `STORAGE_FALLBACK_LOCAL_ROOT`; runbook copy → full sha256 check → fallback read → cleanup | `packages/storage/src/drivers.test.ts`, `packages/config/src/index.test.ts` | rehearsal on staging; S3 mode for the backup scripts |
| Runbooks (Indonesian) | `docs/runbooks/{backup-restore,monitoring,incident-response,storage-migration,load-test}.md`; `restore-backup.md` (from D2-01) aligned | | |
| ADRs | `docs/adr/018`–`022` | | |

## Audit findings

- **D2-03** (no backup/restore tooling, RPO/RTO unproven): tooling, runbook and drill procedure with evidence checklist
  delivered. RPO/RTO are only proven after the first timed drill on staging (open).
- **D2-04 / D2-05 / D2-06** (no N-02 p95, no N-01 load test, no N-04 capacity): generators, dataset CLI, thresholds that
  fail the run, capacity knee and 70 % scale trigger delivered and exercised against a test API. Numbers on the target
  VPS are open.
- **D2-08** (no external monitor/alerts/SLO report): monitor list, push checks, alert routing, availability report
  procedure delivered; the external Uptime Kuma is not installed (open).
- **D5-07** (ledger shares the files volume): fixed in code (off-VPS append-only bucket, synchronous, fail-closed) and
  wired into backup/restore. Verified by tests; bucket provisioning is open.

## Review findings on this slice (fixer round)

Each finding was checked against the code first. All 13 were confirmed and fixed; none was rejected.

| # | Finding | Verdict | Fix |
| - | ------- | ------- | --- |
| 1 | high: the ledger copy mounted into the API image (uid 1000) is root-owned 0700/0600 (umask 077), so `ledger-reapply` dies with EACCES on the documented path | confirmed by reading restore.sh, Dockerfile.api (`USER node`) and the CLI | The ledger copy now lives in `<evidence>/ledger` and is `chown -R $FILES_OWNER` when restore.sh runs as root. restore.sh refuses any user other than root or the `FILES_OWNER` uid before downloading anything. `FILES_OWNER=` (empty) is allowed only for a CLI running directly on the host. Dry-run: guard scenario + CLI reads from the evidence folder. Not tested with a real Docker bind mount (open). |
| 2 | medium: `ledger-reapply` needs Redis that the runbook starts after restore.sh; redis-emitter `publish` is not awaited, so an unhandled rejection kills the CLI | **reproduced**: with `REDIS_URL=redis://127.0.0.1:9` the PG 17 CLI test fails ("[ioredis] Unhandled error event ... expected 1 to be 0") without the fix and passes with it | `createWorkerDeps(env, { redis: false })` in the CLI (no realtime client is connected during restore), plus an `unhandledRejection` handler that logs the type and exits 1. Start order aligned in both runbooks: Redis → one API replica (readiness `deletion_ledger: ok`) → worker → `verify-restore.sh --post-start` → web/admin. |
| 3 | medium: D2 "backup berotasi 30 hari" not delivered (`prune` default `--max-unused 5%`; runbook advised 7-day noncurrent versions = 37 days) | confirmed | `restic prune --max-unused 0` every run; `RETENTION_DAYS + BUCKET_NONCURRENT_DAYS <= 30` enforced; production requires `RESTIC_PRUNE=1`; runbook section 3/10 and ADR-018 rewritten (no noncurrent versions by default; R2 = 0, B2 = 1 with `RETENTION_DAYS=29`). D2 owner sign-off on the parameters is open. |
| 4 | medium: storage-migration.md runs `node dist/modules/account/ledger-reapply.cli.js` in the worker image (path does not exist there); restore-backup.md uses pnpm and is English | confirmed (worker image `/app/dist` is the worker build) | Both runbooks use `docker run ... <image-api> node dist/modules/account/ledger-reapply.cli.js` (worker image path documented as `node node_modules/@kapdh/api/dist/...`), folder chowned to 1000:1000. `restore-backup.md` translated to Indonesian. |
| 5 | low: post-start verification has no ledger copy (deleted with TMP), `outbox.lease` FAILs once the worker runs, report defaults to `./` | confirmed | Ledger copy kept in `<evidence>/ledger`; `verify-restore.sh --post-start` (lease = INFO, `--ledger-dir` required); default report `verify-report[-post-start]-<time>.txt` next to the manifest. |
| 6 | low: PRD 8.2 step 1 (backup/restore "dari database kosong", before Super Admin bootstrap) cannot pass | confirmed | `restore.sh/verify-restore.sh --baseline-empty`: zero Super Admins = WARN. Runbook section 3 step 10 splits the baseline proof (after migrations, before bootstrap) from the first full drill (U-12). |
| 7 | low: `images.*` null with the shipped config | confirmed | Production: backup is still stored, but the run exits 1 with a `down` heartbeat when `images.api`/`images.worker` is empty. `CONTAINER_*` accepts `label=<k>=<v>` and resolves `tag@sha256:digest` via RepoDigests. Env example documents both options. |
| 8 | low: Kuma push URL copied with `?status=up&msg=OK&ping=` makes every heartbeat DOWN | confirmed (the new dry-run case fails without the fix) | `kuma_push` strips the query string; both env examples note it. |
| 9 | low: `CRON_TZ` ignored by Debian/Ubuntu cron; backup and monitoring in one cron file | confirmed | Backup cron in UTC (`15 19 * * *`), host must be UTC; monitoring checks moved to `infra/monitoring/cron/kapdh-monitoring`; runbooks say systemd timer OR backup cron, never both. |
| 10 | low: retention per (host, paths) can forget a files snapshot still referenced by a kept manifest | confirmed | Files snapshots are forgotten by pair: kept only while the dump with the same `backup_id` exists; orphans from failed runs are dropped; parsing failure aborts retention (nothing forgotten). Dry-run with a fake restic that implements keep-within. |
| 11 | low: backfill uses the read-only `kapdhledger:` remote; disaster restore omits the application secrets | confirmed | Backfill uses a temporary write remote `kapdhledgerw:`; section 7 step 3 restores all secrets (TOTP_ENC_KEY, OTP_HMAC_SECRET, QR_SIGNING_KEYS, JWT, FILE_URL_SECRET, ...) identical to production, cross-referencing E1's compose-cadangan.md. |
| 12 | low: `--confirm-database` cannot tell staging from production (both `kapdh`) | confirmed | Positive marker: the seed requires `current_setting('kapdh.environment', true)` in (`staging`, `development`), set once with `ALTER DATABASE kapdh SET kapdh.environment = 'staging'`. Test covers unmarked and production-marked databases. |
| 13 | low: `FallbackReadDriver` never destroys the wrapped S3 client on shutdown | confirmed | `FallbackReadDriver.destroy()` + `destroyStorageDriver()` used by API `main.ts` and `createWorkerDeps`; unit test. |

## Configuration added (packages/config)

| Variable | Service | Rule |
| -------- | ------- | ---- |
| `DELETION_LEDGER_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE` | worker | all-or-nothing, bucket ≠ `S3_BUCKET`, required for the production worker |
| `STORAGE_FALLBACK_LOCAL_ROOT` | API, worker | only with `STORAGE_DRIVER=s3`; empty = unset |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | API, worker | DSN shape validated; empty = off |

CLIs: `loadtest:seed` (`dist/cli/loadtest-seed.js`, refuses production), `account:ledger-reapply` now takes repeated
`--dir`. Roles: `kapdh_backup` (`pg_read_all_data`) and `kapdh_monitor` (column grants) in `infra/db/roles.sql`.

## Merge with D2-01 (main)

- `deletion-steps.ts`: the N floor is refreshed (and audit exports purged in `ledger_final`) before the entry is built;
  the entry goes to the off-VPS bucket first, then `writeLedgerEntryMonotonic` (which advances the head).
- `mergeLedgerEntries`: conflict check + object-key union + floor never decreases.
- `AccountJobsModule` provides `AccountStatusService` and `OffsiteDeletionLedger`.
- The VPS-loss test now also asserts that re-applying from the bucket rewrites the ledger head and readiness reports
  `deletion_ledger: ok`.

## Notes for the integrator (sibling Phase E branches)

1. **E1 (release/compose, `wf_7d813f46-21c-6`)**: `infra/scripts/validate-infra.mjs` requires every packages/config key
   in `infra/.env.production.example` and `.env.staging.example` and in the compose files. Add
   `DELETION_LEDGER_S3_*` (worker), `STORAGE_FALLBACK_LOCAL_ROOT`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
   `SENTRY_RELEASE` (API and worker), or that validation fails after the merge. `infra/db/role-passwords.sql` only sets
   passwords for migrator/app/worker; add `kapdh_backup`/`kapdh_monitor` (or set them manually as in
   backup-restore.md section 3 step 4). `restore.sh` uses its own `ROLE_PASSWORDS_SQL` file; it can be switched to
   E1's `\getenv` file later.
2. **E2 (CI, `wf_7d813f46-21c-7`)**: add `sh infra/backup/test/dry-run.sh` and `sh infra/monitoring/test/dry-run.sh` to
   CI (Linux runner; the role-password scenarios only run where chmod works).
3. **E4 (ADRs/README, `wf_7d813f46-21c-9`)**: add rows 018–022 to `docs/adr/README.md`; set ADR-014's status to
   "Diperbarui oleh ADR-019 (ledger luar VPS, D5-07)"; link `infra/{backup,monitoring,loadtest}/README.md` from
   `kapdh-platform/README.md` / `infra/README.md`.

## Verification (this branch, after the merge, Windows 11 + Git Bash)

| Command | Result |
| ------- | ------ |
| `pnpm build` | pass, 10/10 tasks |
| `pnpm typecheck` | pass, 16/16 tasks |
| `pnpm lint` | pass, 9/9 (after cherry-picking E2's 5e8bb90 for two unused helpers left by the Phase D merge; contracts keeps its 2 known warnings) |
| `pnpm format:check` | pass |
| `pnpm --filter @kapdh/api test` (alone) | pass, 124 files, 2706 tests |
| `pnpm --filter @kapdh/api test:pg` (PostgreSQL 17) | pass, 28 files (1 skipped), 237 tests |
| other packages via `pnpm test` | database 23, config 27, shared 16, storage 40, web 169, worker 54, contracts pass; admin 594/594 when run alone (8 UI tests timed out at 20 s inside the parallel turbo run on a loaded machine) |
| `sh infra/backup/test/dry-run.sh` | 37 pass (role-password scenarios skipped on NTFS) |
| `sh infra/monitoring/test/dry-run.sh` | 36 pass |

Not run anywhere: real PostgreSQL backup/restore with restic/rclone/R2 or B2, Uptime Kuma, GlitchTip, a load test on the
target VPS, a storage migration against a real S3 provider, Docker images.

## Verification after the fixer round (Windows 11 + Git Bash)

| Command | Result |
| ------- | ------ |
| `pnpm build` | pass, 10/10 |
| `pnpm typecheck` | pass, 16/16 |
| `pnpm lint` | pass, 9/9 |
| `pnpm format:check` | pass |
| `pnpm --filter @kapdh/api test` | pass, 124 files, 2706 tests |
| `pnpm --filter @kapdh/api test:pg` (PostgreSQL 17) | pass, 29 files, 238 tests + 1 todo (embedded-postgres prints "done is not a function" during teardown; exit code 0) |
| CLI ledger-reapply with `REDIS_URL=redis://127.0.0.1:9` | pass with the fix; fails (exit 1, ioredis unhandled error) when the fix is removed from `dist` |
| `npx vitest run test/ops/loadtest.e2e.test.ts` | pass, 6 tests (includes the unmarked / production-marked database refusals) |
| storage 41, worker 54, config 27 | pass |
| `sh infra/backup/test/dry-run.sh` | 60 pass (role-password scenarios skipped on NTFS) |
| `sh infra/monitoring/test/dry-run.sh` | 37 pass (the Kuma query-string case fails when the fix is removed) |

Still not run: Docker bind mount of `<evidence>/ledger` into the API image as uid 1000, `CONTAINER_*` label lookup
against a real Docker daemon, `restic prune --max-unused 0` cost on a real repository, the JSON shape of real
`restic snapshots --json` used by the paired retention (aborts safely if unreadable), cron on an Ubuntu host.
