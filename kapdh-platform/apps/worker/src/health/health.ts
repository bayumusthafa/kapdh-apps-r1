import { type Clock, safeError } from "@kapdh/api/worker";
import { type SQL, sql } from "drizzle-orm";
import type { DispatcherStatus } from "../outbox/dispatcher.js";
import type { SchedulerStatus } from "../scheduler/scheduler.js";

/**
 * Kesehatan worker (PRD 5.5 "Monitoring wajib meliputi … DB … umur job/outbox tertua"): koneksi database, backend
 * antrean, umur outbox tertua, loop dispatcher dan tick penjadwal. Laporan hanya berisi angka, waktu, dan nama job,
 * tanpa PII, payload, URL koneksi, atau pesan galat mentah (N-14).
 */

/** Ringkasan outbox: event belum terkirim (`pending`/`failed`) dan `dead` yang butuh tindakan operator. */
export interface OutboxStats {
  pending: number;
  dead: number;
  /** Umur event belum terkirim tertua (now - created_at), detik; null bila tidak ada. */
  oldestPendingAgeSeconds: number | null;
  /** Keterlambatan event jatuh tempo yang belum diklaim siapa pun (now - next_attempt_at), detik; null bila tidak ada. */
  oldestDueLagSeconds: number | null;
}

export interface HealthProbes {
  /** Melempar bila database tidak dapat dijangkau. */
  database(): Promise<void>;
  outbox(now: Date): Promise<OutboxStats>;
}

const PROBE_TIMEOUT_MS = 2_000;

/** Hasil kueri mentah: postgres-js mengembalikan array, PGlite `{rows}`. */
function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown } | null | undefined;
  if (maybe && Array.isArray(maybe.rows)) return maybe.rows as T[];
  throw new Error("Hasil kueri mentah tidak dikenal");
}

/** Bagian Drizzle yang dipakai probe (postgres-js di production, PGlite di uji). */
export interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/**
 * Probe database (role kapdh_worker). Runtime memakai koneksi health KHUSUS (bukan pool kerja), sehingga job yang
 * memenuhi pool tidak membuat health palsu "database tidak terjangkau" dan memicu restart. Kueri outbox memakai indeks
 * (status, next_attempt_at).
 */
export function createDbHealthProbes(db: SqlExecutor): HealthProbes {
  return {
    async database() {
      await db.execute(sql`select 1`);
    },
    async outbox(now: Date) {
      const at = now.toISOString();
      const [row] = resultRows<{
        pending: number;
        dead: number;
        oldest_pending_age_seconds: number | null;
        oldest_due_lag_seconds: number | null;
      }>(
        await db.execute(sql`
          select
            count(*) filter (where status in ('pending', 'failed'))::int as pending,
            count(*) filter (where status = 'dead')::int as dead,
            greatest(0, floor(extract(epoch from (${at}::timestamptz
              - min(created_at) filter (where status in ('pending', 'failed'))))))::int as oldest_pending_age_seconds,
            greatest(0, floor(extract(epoch from (${at}::timestamptz
              - min(next_attempt_at) filter (
                  where status in ('pending', 'failed') and next_attempt_at <= ${at}::timestamptz
                    and (locked_until is null or locked_until < ${at}::timestamptz)
                )))))::int as oldest_due_lag_seconds
          from app.outbox_events
          where status in ('pending', 'failed', 'dead')`),
      );
      return {
        pending: Number(row?.pending ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? null,
        oldestDueLagSeconds: row?.oldest_due_lag_seconds ?? null,
      };
    },
  };
}

export type HealthStatus = "ok" | "degraded" | "error" | "stopping";

export interface HealthReport {
  status: HealthStatus;
  service: "kapdh-worker";
  time: string;
  started_at: string;
  /** Alasan status bukan ok (kode singkat, stabil untuk alert). */
  issues: string[];
  checks: {
    database: { ok: boolean; latency_ms: number | null };
    queue: { ok: boolean; driver: "inline" | "bullmq" };
    outbox: {
      ok: boolean;
      pending: number | null;
      dead: number | null;
      oldest_pending_age_seconds: number | null;
      oldest_due_lag_seconds: number | null;
      dispatcher: {
        running: boolean;
        last_loop_at: string | null;
        last_poll_ok_at: string | null;
        consecutive_failures: number;
        totals: DispatcherStatus["totals"];
      };
    };
    scheduler: {
      ok: boolean;
      running: boolean;
      role: SchedulerStatus["role"];
      /** Tick terakhir sebagai leader (jadwal dievaluasi); null pada instance standby. */
      last_tick_at: string | null;
      last_leader_check_at: string | null;
      jobs: {
        name: string;
        every_ms: number;
        next_due_at: string | null;
        last_enqueued_at: string | null;
        last_started_at: string | null;
        last_finished_at: string | null;
        last_status: "ok" | "failed" | null;
      }[];
    };
  };
}

export interface HealthInputs {
  clock: Clock;
  startedAt: Date;
  stopping: boolean;
  probes: HealthProbes;
  queue: { kind: "inline" | "bullmq"; ping(): Promise<boolean> };
  dispatcher: DispatcherStatus;
  scheduler: SchedulerStatus;
  pollIntervalMs: number;
  tickMs: number;
  outboxLagDegradedSeconds: number;
  onProbeError?: (probe: string, error: ReturnType<typeof safeError>) => void;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout pemeriksaan health")), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Loop dianggap macet bila tidak ada iterasi selama batas ini (setelah masa tenggang start). */
function loopStale(last: Date | null, now: Date, startedAt: Date, staleMs: number): boolean {
  const reference = last ?? startedAt;
  return now.getTime() - reference.getTime() > staleMs;
}

/**
 * Menyusun laporan health. HTTP 503 (`error`/`stopping`) hanya untuk masalah liveness: database atau antrean tidak
 * terjangkau, loop dispatcher/penjadwal macet, atau proses sedang berhenti. Backlog outbox (keterlambatan melewati
 * ambang) dan event `dead` dilaporkan `degraded` (HTTP 200) agar monitor memberi alert tanpa memicu restart berulang.
 */
export async function buildHealthReport(input: HealthInputs): Promise<HealthReport> {
  const now = input.clock.now();
  const issues: string[] = [];

  const dbStarted = performance.now();
  let databaseOk = true;
  let latency: number | null = null;
  const databaseCheck = withTimeout(input.probes.database(), PROBE_TIMEOUT_MS).then(
    () => {
      latency = Math.round(performance.now() - dbStarted);
    },
    (error: unknown) => {
      databaseOk = false;
      input.onProbeError?.("database", safeError(error));
    },
  );
  let stats: OutboxStats | null = null;
  const outboxCheck = withTimeout(input.probes.outbox(now), PROBE_TIMEOUT_MS).then(
    (value) => {
      stats = value;
    },
    (error: unknown) => {
      input.onProbeError?.("outbox", safeError(error));
    },
  );
  let queueOk = false;
  const queueCheck = withTimeout(input.queue.ping(), PROBE_TIMEOUT_MS).then(
    (value) => {
      queueOk = value;
    },
    (error: unknown) => {
      input.onProbeError?.("queue", safeError(error));
    },
  );
  await Promise.all([databaseCheck, outboxCheck, queueCheck]);
  const outbox = stats as OutboxStats | null;

  if (!databaseOk) issues.push("database_unreachable");
  if (!queueOk) issues.push("queue_unreachable");
  const dispatcherStale =
    input.dispatcher.running &&
    loopStale(input.dispatcher.lastLoopAt, now, input.startedAt, Math.max(5 * input.pollIntervalMs, 30_000));
  if (dispatcherStale) issues.push("dispatcher_stalled");
  const schedulerStale =
    input.scheduler.running &&
    loopStale(input.scheduler.lastLeaderCheckAt, now, input.startedAt, Math.max(30 * input.tickMs, 30_000));
  if (schedulerStale) issues.push("scheduler_stalled");
  if (!outbox && databaseOk) issues.push("outbox_stats_unavailable");

  const fatal = !databaseOk || !queueOk || dispatcherStale || schedulerStale;
  const lagging = (outbox?.oldestDueLagSeconds ?? 0) > input.outboxLagDegradedSeconds;
  if (lagging) issues.push("outbox_lagging");
  const dead = (outbox?.dead ?? 0) > 0;
  if (dead) issues.push("outbox_dead_events");
  if (input.stopping) issues.unshift("stopping");

  const status: HealthStatus = input.stopping
    ? "stopping"
    : fatal
      ? "error"
      : lagging || dead || !outbox
        ? "degraded"
        : "ok";

  return {
    status,
    service: "kapdh-worker",
    time: now.toISOString(),
    started_at: input.startedAt.toISOString(),
    issues,
    checks: {
      database: { ok: databaseOk, latency_ms: databaseOk ? latency : null },
      queue: { ok: queueOk, driver: input.queue.kind },
      outbox: {
        ok: Boolean(outbox) && !lagging && !dispatcherStale,
        pending: outbox?.pending ?? null,
        dead: outbox?.dead ?? null,
        oldest_pending_age_seconds: outbox?.oldestPendingAgeSeconds ?? null,
        oldest_due_lag_seconds: outbox?.oldestDueLagSeconds ?? null,
        dispatcher: {
          running: input.dispatcher.running,
          last_loop_at: iso(input.dispatcher.lastLoopAt),
          last_poll_ok_at: iso(input.dispatcher.lastPollOkAt),
          consecutive_failures: input.dispatcher.consecutiveFailures,
          totals: input.dispatcher.totals,
        },
      },
      scheduler: {
        ok: !schedulerStale,
        running: input.scheduler.running,
        role: input.scheduler.role,
        last_tick_at: iso(input.scheduler.lastTickAt),
        last_leader_check_at: iso(input.scheduler.lastLeaderCheckAt),
        jobs: input.scheduler.jobs.map((job) => ({
          name: job.name,
          every_ms: job.everyMs,
          next_due_at: iso(job.nextDueAt),
          last_enqueued_at: iso(job.lastEnqueuedAt),
          last_started_at: iso(job.lastStartedAt),
          last_finished_at: iso(job.lastFinishedAt),
          last_status: job.lastStatus,
        })),
      },
    },
  };
}

/** Kode HTTP untuk status health: 200 ok/degraded, 503 error/stopping. */
export function httpStatusFor(status: HealthStatus): number {
  return status === "ok" || status === "degraded" ? 200 : 503;
}
