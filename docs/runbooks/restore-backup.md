# Runbook: restore a backup without bringing deleted accounts back

Owner: infrastructure operator (PRD 5.5). Business sign-off and user communication: Super Admin.
Requirements: AC F14-6, PRD 9.2 scenario 8, PRD 3.5/6.4 (member number N is never reused), N-06, U-09.

This runbook covers the application side of a restore: the order of steps that keeps accounts deleted after the
backup point deleted. The full operator procedure, in Indonesian, is `docs/runbooks/backup-restore.md`: there
`infra/backup/restore.sh` performs steps 2 to 5 automatically on a clean environment (it refuses a non-empty database
or files volume), then `verify-restore.sh` checks money totals, counts, the applied ledger, files and readiness. It
also contains the monthly restore drill with RPO/RTO measurement (N-06, D2-03).
Follow every step in order. **Step 5 is blocking: the service is not opened until it exits 0 and readiness is 200.**

## Background

- Every account deletion writes an entry to the external **deletion ledger** in object storage:
  `ledger/account-deletions/<yyyy>/<mm>/<request-number>.json` (state `requested`, later `completed`). Entries hold
  only ids, object keys and `member_seq_floor` (the highest member number N already issued). No personal data.
- Every entry is ALSO appended synchronously, before any data is deleted, to a dedicated **off-VPS bucket**
  (`DELETION_LEDGER_S3_*`, append-only keys `account-deletions/<yyyy>/<mm>/<request>/<state>-<uuid>.json`,
  versioning + object lock; ADR-019, audit D5-07). After a VPS loss this bucket is the newest ledger, because the
  `ledger/` prefix on `/data/files` is only as new as the last daily backup.
- The ledger also keeps a **head** object, `ledger/account-deletions-head.json`, that points to the newest request.
- `GET /api/v1/health/ready` returns **503** with `checks.deletion_ledger: "fail"` while the database does not know
  the newest request in the head (a restored database that has not had the ledger re-applied), or while the head is
  unreadable. It returns 200 with `deletion_ledger: "ok"` once `account:ledger-reapply` has run.
- Re-applying the ledger also records the N floor of every entry in the database. Member number allocation skips
  past that floor, so an N issued after the backup point is never issued again, even though the restored sequence
  `app.membership_no_seq` is older.

Limitation: the readiness check can only detect a stale database while storage still holds a newer ledger head. If
the database AND the object storage both come from the same backup, the head is as old as the database and the check
passes. That is why steps 2 and 5 are mandatory in every restore, whatever readiness says, and why step 2 always
starts from the off-VPS bucket.

## Steps

1. **Stop traffic and jobs.** Scale the API and worker services to 0 in Coolify (or `docker compose stop api worker`
   with the fallback Compose file). Leave PostgreSQL and Redis running. Confirm that the Coolify health check for the
   API uses `/api/v1/health/ready` (not `/api/v1/health`), so that a 503 keeps the container out of rotation.

2. **Save the newest deletion ledger before touching storage.** First copy the off-VPS bucket with its read-only
   key: `rclone copy kapdhledger:<DELETION_LEDGER_S3_BUCKET> /restore/ledger-offsite --include "/account-deletions/**"`.
   Then, if the live storage still exists, copy its whole `ledger/` prefix too, for example to
   `/restore/ledger-latest/`:
   - `STORAGE_DRIVER=local`: `cp -a "$STORAGE_LOCAL_ROOT/ledger" /restore/ledger-latest/`
   - `STORAGE_DRIVER=s3`: `rclone copy <remote>:<S3_BUCKET>/ledger /restore/ledger-latest/ledger`

   If the live storage is lost, use the bucket copy plus the ledger copy from the newest backup manifest (snapshot
   `kapdh-db`, folder `ledger-offsite/`). Only when the bucket itself is permanently lost may a restore continue
   without it (`restore.sh --allow-missing-offsite-ledger`), and that must be recorded and reported (AC F14-6).

3. **Restore the database.** Restore the chosen dump with the owner/migration role, run the migration job once
   (`pnpm --filter @kapdh/database migrate`), then re-apply `infra/db/roles.sql` so that `kapdh_app`, `kapdh_worker`
   and `kapdh_audit_purge` have their grants. Redis can be flushed; it is rebuilt from durable state and the outbox.

4. **Restore files, then put the newest ledger back.** If the files have to be restored as well (restic of
   `/data/files`, or a bucket restore), restore them now. Then copy the ledger saved in step 2 back over the restored
   `ledger/` prefix (`cp -a /restore/ledger-latest/ledger "$STORAGE_LOCAL_ROOT/"`, or `rclone copy` back to the
   bucket). Ledger entries only grow (a `completed` entry is never replaced by `requested`), so the newest copy always
   wins.

5. **Re-apply the deletion ledger (blocking).** With the worker environment (connection as `kapdh_worker`, which is a
   member of `kapdh_audit_purge`), run:

   ```sh
   pnpm --filter @kapdh/api account:ledger-reapply -- \
     --dir /restore/ledger-offsite/account-deletions --dir /restore/ledger-latest/ledger/account-deletions
   ```

   `--dir` may be repeated: entries from all copies are merged per request (`completed` wins, object keys are
   united, the N floor never goes down, conflicting copies are refused). Without `--dir` and with
   `STORAGE_DRIVER=local`, the CLI reads `$STORAGE_LOCAL_ROOT/ledger/account-deletions`. Re-applying also rewrites
   the entries and the head in the StorageDriver, so readiness recognises the newest request.
   The output lists only request numbers and counts:

   | Line | Meaning |
   | --- | --- |
   | `Diterapkan ulang` | Accounts present in the backup that were deleted again (files, profile, credentials). Requests that were still `requested` are finished now, including the completion email. |
   | `Sudah terhapus` | Already deleted in the backup. Only the N floor is recorded. |
   | `Tidak ada di backup` | Registered after the backup point. A `completed` request row with the N floor is recorded, so readiness recognises the request and N is not reused. |
   | `Gagal` | Must be 0. Exit code 1 means the service must stay closed: fix the cause (usually storage access or the `kapdh_audit_purge` role) and run the step again. The CLI is idempotent. |

6. **Start the API and check readiness.** Start one API replica only. `GET /api/v1/health/ready` must return 200 with
   `"deletion_ledger": "ok"`. If it is 503 with `"deletion_ledger": "fail"`, the ledger that was applied is older than
   the head in storage, or the head is damaged: go back to step 5 with the newest ledger copy. Re-running step 5
   rewrites the head.

7. **Start the worker and the remaining API replicas.**

8. **Post-restore checks** (PRD 5.5): admin login with MFA, member list, money totals, tickets, chat, private files,
   and previous deletions. For the request numbers printed in step 5, this query must return only `deleted` (absent
   accounts have no `users` row and return nothing):
   `select u.status, count(*) from app.account_deletions d join app.users u on u.id = d.user_id where d.request_number in (...) group by 1`.
   Optional, informational only: compare `select last_value from app.membership_no_seq` with
   `select max((ledger->>'member_seq_floor')::bigint) from app.account_deletions`. Allocation skips past the floor by
   itself. To align the sequence anyway, run `select setval('app.membership_no_seq', greatest(last_value, <floor>))`
   as the owner role (`kapdh_worker` has no sequence privilege).

9. **Communicate.** Data written after the backup point (payments, registrations, chat) is lost. The Super Admin
   informs affected users (PRD 8.4, "Data/berkas hilang atau rusak").

## Evidence

- `kapdh-platform/apps/api/test/account/deletion-job.e2e.test.ts`: "AC F14-6, PRD 9.2 #8: database dipulihkan
  (storage tetap terkini) -> GET /health/ready 503 deletion_ledger fail sampai ledger-reapply; sesudahnya 200", and the
  restore test that checks the N floor for an account that is absent from the backup (D5-05).
- `kapdh-platform/apps/api/test/pg/account-deletion.pg.test.ts`: the CLI `ledger-reapply` on PostgreSQL 17.
- `kapdh-platform/apps/api/test/pg/deletion-e2e.pg.test.ts`: D5-05 on PostgreSQL 17.
- `kapdh-platform/apps/api/test/account/deletion-job.e2e.test.ts`: "AC F14-6, D5-07: VPS hilang ..." (database and
  files from a backup older than the deletion, ledger re-applied from the off-VPS bucket copy, readiness 200) and
  "D5-07: penulisan ke ledger luar VPS gagal ..." (no data deleted before the off-VPS entry exists).
- `kapdh-platform/infra/backup/test/dry-run.sh`: `restore.sh` passes the bucket copy, the backup copy and the restored
  files ledger to the CLI and refuses to continue when it exits non-zero (fake tools; a staging drill is still due).
