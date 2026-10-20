# Phase C slice: worker

Final report after build, adversarial review (7 findings) and fixes (commit 7cc72f1).

## Summary
All 7 review findings for the worker slice are fixed or disclosed, and every verification command passed on the final commit 7cc72f1.

**Interrupted earlier work.** A previous fixer had already written most of the fixes (0bb7138), but its interrupted wip commit fc007c9 had quietly reverted kapdh-platform/apps/api/src/core/jobs/job-runner.ts to the builder's version. That revert removed the main fix (finding 1) and broke the job_id fix (finding 7). I restored the file from 0bb7138 (commit 817b473). To show the tests catch these findings, I ran them against the builder's job-runner and confirmed they fail:
- the unit tests in test/outbox-dispatcher.test.ts ("lease taken over atomically" and "same claim processed twice → lost") and the job_id test in test/scheduler.test.ts;
- the race test on real Postgres in test/pg/outbox-dispatch.pg.test.ts (the handler ran twice at the same time).

**Status of each finding:**
1. (high) A claim whose lease had expired could still run its handler while another worker re-claimed it. Fixed: `processOutboxClaim` first takes over the lease with one conditional UPDATE (`locked_until = claim token`, moved forward to now + lockMs), and the heartbeat and finalize steps use the new token. A claim that is stale or already started returns `lost` and its handler never runs. I took over expired-but-unclaimed leases instead of adding the reviewer's `locked_until > now` check. Both are safe; takeover avoids waiting a full 5-minute lease.
2. (high) Redis down at boot left BullMQ broken for the whole process. Fixed: `BullMqQueueDriver.start()` waits for both Redis connections and every BullMQ client to be ready. After 30 s it fails, so `main.ts` exits 1 and the orchestrator restarts the worker. The health check now fails when a BullMQ client did not initialise or a consumer loop stopped. Tested with real ioredis and BullMQ against a fake Redis server (test/bullmq-redis.test.ts) and on the pg lane.
3. (medium) A loop that kept failing still reported healthy. Fixed: /healthz returns 503 with `dispatcher_failing` when no poll has succeeded for 2 minutes, and `scheduler_failing` when leader checks or scheduled enqueues keep failing.
4. (medium) Queue calls could hang forever when Redis dropped. Fixed: the queue producer has its own connection that fails fast (no offline queue, command timeout), and each capacity/enqueue/isPending call has a 5 s timeout. A poll that hits Redis trouble now releases its claims at once. The real driver is tested against an unresponsive Redis.
5. (medium) Undisclosed changes to core files. Fixed by disclosure: every change to a core- or integrator-owned file is listed under shared_changes below, with the reason.
6. (low) More jobs could run than the database pool had connections. Fixed: WORKER_CONCURRENCY is now the total for both queues (half for scheduled jobs, at least 1 each). With 2 or more there is always a spare connection for lease heartbeats. With 1 there is none, so start now logs a warning (new in 7cc72f1, with tests).
7. (low) Log lines could not be joined by job_id. Fixed: one job_id (`outbox:<id>` or `<name>:<uuidv7>`) appears in queue logs, JobRunner logs and audit; the queue's own id is logged as `queue_job_id`. `runScheduled` accepts an optional jobId. I also switched the scheduler's id from v4 to uuidv7 (ARCHITECTURE §2.7), which moves `uuid` to the worker's runtime dependencies.

I also ran Prettier on the earlier fixer's files, which had never been formatted and were failing format:check.

## AC coverage
- [covered] PRD 5.1 / ARCH §4.8: outbox dispatcher polls ~2 s, claims with FOR UPDATE SKIP LOCKED + locked_until lease, routes by topic: test/outbox-dispatcher.test.ts 'PRD 5.1: event jatuh tempo diklaim ...' and the poll-loop test; pg lane test/pg/outbox-dispatch.pg.test.ts: 300 events with two dispatchers, each handled exactly once, and parallel batch claims never overlap
- [covered] PRD 5.1: mark dispatched / attempts+1 with exponential backoff + safe last_error / dead after N attempts: outbox-dispatcher.test.ts 'handler gagal -> failed + attempts + backoff ...' and 'PRD 5.5: setelah percobaan maksimum event menjadi dead'
- [covered] PRD 5.1: events never lost or handled twice concurrently (lease expiry recovery, atomic takeover, fencing) — finding 1: outbox-dispatcher.test.ts 'klaim yang menunggu di antrean melewati lease ... diambil alih atomik', 'klaim lama ... SETELAH event diklaim ulang -> lost', 'klaim yang sama diproses dua kali -> proses kedua lost'; pg lane 'job antrean dengan lease kedaluwarsa mulai diproses BERSAMAAN dengan klaim ulang ...' (two real connections, 40 events, zero overlaps). All of these fail against the builder's job-runner (checked).
- [covered] PRD 5.1: dispatcher forwards to BullMQ with dedup key; inline without Redis; Redis outage never hangs or loses events — findings 2 and 4: test/bullmq-redis.test.ts (real ioredis + BullMQ against a fake RESP server): Redis down at boot -> start fails after the deadline; Redis comes up during the wait -> start succeeds; Redis drops after boot -> calls rejected within the timeout, then recovery without restart; Redis hangs -> poll releases claims at once. pg lane worker-runtime.pg.test.ts: bootWorker fails with Redis down and leaves no connections; with BullMQ, health 200 -> 503 queue_unreachable -> 200 without restart. bullmq-driver.test.ts and inline-driver.test.ts cover jobId dedup and retry.
- [covered] ARCH §4.8 / PRD 5.1: schedulers for every registered job with a Postgres advisory-lock leader (two workers on pg lane): test/scheduler.test.ts; test/pg/scheduler-leader.pg.test.ts (exactly one leader over 20 concurrent rounds, resign handover, pg_terminate_backend takeover); test/pg/worker-runtime.pg.test.ts (two full workers, handover on SIGTERM)
- [covered] Graceful shutdown (stop polling, finish in-flight, close pools): runtime.test.ts tests for shutdown order, timeout and start failure; worker-runtime.pg.test.ts checks that no kapdh-worker* connections remain after stop
- [covered] PRD 5.5: /healthz (DB ok, oldest pending outbox age, last scheduler tick) incl. failing-loop detection — finding 3: health.test.ts 'loop yang terus berputar tetapi gagal setiap iterasi ... -> error dispatcher_failing / scheduler_failing (HTTP 503)'; runtime.test.ts 'poll outbox gagal setiap iterasi walau DB dan antrean menjawab ping -> /healthz 503 dispatcher_failing'; the earlier ok/degraded/error/stopping tests
- [covered] N-14: structured JSON logs with job_id/request_id, redaction, one job_id across queue/JobRunner/audit — finding 7: scheduler.test.ts 'N-14: satu job_id eksekusi menghubungkan log antrean, log/konteks JobRunner, dan audit job' (now also checks the id is UUID v7); bullmq-driver.test.ts N-14 correlate test; logging.test.ts
- [covered] PRD 5.1 least privilege + pool-safe concurrency — finding 6: settings.test.ts 'total job paralel per proses = WORKER_CONCURRENCY ...' (all values 1..64, pool size and hasPoolHeadroom); runtime.test.ts 'WORKER_CONCURRENCY=1 -> start memperingatkan ...'; settings least-privilege test; pg lane connects as kapdh_worker
- [partial] infra/Dockerfile.worker: multi-stage, correct pnpm 10 deploy, non-root: Unchanged since the builder. Docker image not built (no Docker on this machine).

## Verification
- pass `pnpm build`: 10/10 tasks, final tree
- pass `pnpm typecheck`: 16/16 tasks, final tree
- pass `pnpm lint`: 9/9 tasks; only the 2 known contract warnings
- pass `pnpm test`: Final tree, exit 0: api 404/404, admin 143, worker 54/54, config 24, storage 33, database 23, shared 16, web 5. An earlier run on a machine at 100% CPU (other parallel builds) had two timing failures in core-owned API tests: worker-package.e2e timed out at 30 s while importing @kapdh/api/worker (13-35 s here, main 21 s at the same load) and the realtime expires_at test. Both passed on rerun and in the final full run; neither touches worker code.
- pass `pnpm --filter @kapdh/api test:pg`: 10 files, 66/66, exit 0 (final tree)
- pass `pnpm --filter @kapdh/worker test:pg`: 3 files, 11/11, exit 0 (final tree)
- pass `pnpm contracts:lint`: Valid; 2 known warnings; event schemas valid
- pass `pnpm format:check`: All matched files use Prettier code style (after formatting the previous fixer's 8 files)
- pass `Regression check: builder job-runner (afefaef) + rebuilt API -> vitest outbox-dispatcher/scheduler tests and pg outbox-dispatch.pg.test.ts`: As expected, 3 unit tests and the pg race test fail without the fix (the handler ran twice at the same time), so the tests catch findings 1 and 7. The fix was then restored and rebuilt.

## Contract changes


## Shared changes
- apps/api/src/core/jobs/job-runner.ts (core-api), needed so the worker can hand outbox claims to BullMQ with a dedup key (PRD 5.1). (a) dispatchOutbox is split into claimOutbox({limit, lockMs}) -> OutboxClaim[], processOutboxClaim(claimRef, {lockMs}) -> 'dispatched'|'failed'|'dead'|'lost', and releaseOutboxClaim(claimRef) -> boolean. `locked_until` is the ownership token. (b) processOutboxClaim first takes over the lease atomically: UPDATE ... SET locked_until = max(now + lockMs, token + 1 ms) WHERE id = $1 AND locked_until = token AND status IN ('pending','failed') RETURNING the event; no row means 'lost' and the handler does not run. (c) A LeaseKeeper heartbeat renews the lease every lockMs/3 while the handler runs, and finalization is fenced on the latest token. (d) runScheduled(name, options?: {jobId?}) gains an optional caller job id; the default `<name>:<uuidv7>` is unchanged. dispatchOutbox, drainOutbox and runScheduled(name) keep their signatures and results; core jobs.e2e passes unchanged.
- apps/api/src/worker.ts (core-api): @kapdh/api/worker also exports the types DispatchResult, OutboxClaim, OutboxClaimRef, OutboxOutcome, Clock and Db, plus OUTBOX_LOCK_MS, OUTBOX_MAX_ATTEMPTS, outboxBackoffMs and ADVISORY_LOCK_KEYS (additive only).
- apps/api/src/core/db/locks.ts (core-api): new ADVISORY_LOCK_KEYS.workerSchedulerLeader = 4711000520 (additive). Note: main has since added ADVISORY_LOCK_NAMESPACES.otpDecoy; this branch does not touch it, so merge both.
- packages/config/src/index.ts + index.test.ts (core-api): optional WorkerEnv keys WORKER_HEALTH_PORT, WORKER_HEALTH_HOST, OUTBOX_POLL_INTERVAL_MS, WORKER_SHUTDOWN_TIMEOUT_MS with range checks, and a test that API secrets never reach WorkerEnv (additive).
- kapdh-platform/.env.example: worker section documents the four new variables.
- kapdh-platform/pnpm-lock.yaml: the apps/worker importer has bullmq, ioredis, postgres, drizzle-orm, pino and uuid (runtime; uuid moved from dev in this fix), plus dev deps @kapdh/database, embedded-postgres and @electric-sql/pglite. All were already in the store; other importers unchanged.

## Open issues
- Finding 5 (undisclosed core changes) is accepted, not rejected: the changes are necessary but were missing from the report the reviewer saw, so they are now listed in shared_changes. The integrator should review the JobRunner change against any other Phase C branch that touches core/jobs.
- WORKER_CONCURRENCY=1 still runs 2 jobs on a 2-connection pool with no spare for lease heartbeats. Start now logs a warning; the default is 4 and the README says to use 2 or more in production. A full fix would need packages/config (core) to require a minimum of 2, or a larger pool in createWorkerDeps.
- infra/Dockerfile.worker has never been built as an image (no Docker here); CI should build it once.
- BullMQ job processing (the Lua scripts) was not run against a real Redis. The fake RESP server tests only connection, boot, timeout and recovery behaviour. A staging smoke test with real Redis is still needed: enqueue/dedup, stalled-job recovery, and backpressure across instances.
- A handler that hangs forever keeps renewing its lease, so its event and queue slot stay busy. Core handlers must set timeouts on external I/O (SMTP/FCM).
- core worker-package.e2e has a 30 s vitest timeout, but importing @kapdh/api/worker took 13-35 s on this heavily loaded machine (main 21 s). It is flaky under load; the core owner may want a longer timeout.
- Health gives 200 'degraded' for outbox lag over 5 min and for dead events; Uptime Kuma should alert on status != ok as well as on the HTTP code.

## Handoff notes
Branch worktree-wf_b8bd7d01-232-12 is final at 7cc72f1, with a clean tree. The fixer commits after the builder's afefaef are 0bb7138 and fc007c9 (wip from the previous fixer), then 817b473, 3df6815, 2ed8e34 and 7cc72f1.

fc007c9 had reverted job-runner.ts to the builder's version; 817b473 restores the fix. If you rebase or squash, make sure job-runner.ts keeps the atomic takeover. To check, grep for 'MENGAMBIL ALIH' and confirm runScheduled accepts `options: { jobId?: string }`.

Run from kapdh-platform:
- `pnpm --filter @kapdh/worker test` (PGlite plus real ioredis/BullMQ against a fake RESP server)
- `pnpm --filter @kapdh/worker test:pg` (embedded PG17, connects as kapdh_worker)

Module owners:
- Handlers must still be idempotent. An event is reprocessed after its lease expires if a DB error happened after the takeover.
- `t.jobs.dispatchOutbox()` / `drainOutbox()` behave exactly as before.

Ops:
- REDIS_URL must reach Redis within 30 s of boot, otherwise the worker exits 1 and is restarted.
- Each instance opens two BullMQ Redis connections (kapdh-worker-bullmq and kapdh-worker-bullmq-producer) plus one blocking connection per queue.
- Monitor /healthz for the issue codes dispatcher_failing, scheduler_failing, queue_unreachable and outbox_lagging.

Integrator:
- The shared core/config changes are listed in shared_changes.
- main has moved ahead (for example locks.ts otpDecoy), so merge rather than taking either side whole.
- No migrations and no contract changes.
