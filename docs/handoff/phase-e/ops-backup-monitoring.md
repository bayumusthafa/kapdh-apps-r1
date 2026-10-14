# Phase E slice E3: backup, restore, monitoring, load tests and incident operations

Branch `worktree-wf_7d813f46-21c-8`. Main (Phase D hardening, 5c59999) is merged in and conflicts are resolved (see
"Merge with D2-01").

## Summary

| Area | Delivered | Evidence in the repo | Still needs a real run |
| ---- | --------- | -------------------- | ---------------------- |
| Backup (N-06, D9, D2) | `infra/backup/backup.sh`: pg_dump custom on an exported REPEATABLE READ snapshot, manifest stats computed on the same snapshot, restic of `/data/files` after the dump, copy of the off-VPS deletion ledger, `manifest.json` (schema), read-back check, 30-day retention + prune, Uptime Kuma push; systemd timer and cron | `infra/backup/test/dry-run.sh` (37 checks, fake tools), `apps/api/test/ops/backup-ops.e2e.test.ts` (SQL on PGlite), `apps/api/test/pg/backup-roles.pg.test.ts` (snapshot export/import as `kapdh_backup` on PG 17) | first backup + drill on staging with real restic/rclone/R2 or B2 |
| Restore (PRD 5.5, 8.4, AC F14-6) | `restore.sh` (clean environment only, roles.sql, pg_restore single transaction, files snapshot from the manifest, `ledger-reapply` over the newest off-VPS bucket + backup copies, outbox lease release, evidence with RTO/RPO), `verify-restore.sh` + `verify-http.mjs` (counts and money totals equal to the manifest, ledger applied, files + sha256 sample, Super Admin, readiness incl. `deletion_ledger`, drill admin login + TOTP, public file) | same as above | timed restore drill (U-11, U-12) |
| Off-VPS deletion ledger (D5-07) | `OffsiteDeletionLedger`: `ledger_open`/`ledger_final` append each entry synchronously to `DELETION_LEDGER_S3_*` (append-only keys, Content-MD5 for object lock) before the StorageDriver copy; failure fails the step; production worker requires the bucket | `apps/api/test/account/offsite-ledger.test.ts`, `deletion-job.e2e.test.ts` (VPS loss restored from the bucket, readiness 200 after re-apply; write failure at both steps), PG 17 CLI test with two `--dir` | bucket with object lock at the chosen provider |
| Monitoring (N-05, D2-08) | `infra/monitoring/check-{host,app,worker,backup}.sh`, `sql/app-health.sql` (role `kapdh_monitor`, column grants only), `realtime-probe.mjs`; runbook with 18 monitors, alert routing Telegram/WhatsApp/email, monthly availability report | `infra/monitoring/test/dry-run.sh` (36 checks), `apps/api/test/ops/monitoring.e2e.test.ts` (probe against a listening API), PG 17 grants test | Uptime Kuma, channels and monthly report |
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

## Verification (this branch, after the merge)

See the final report of this slice for the exact command results.
