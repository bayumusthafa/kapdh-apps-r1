import { Inject, Injectable } from "@nestjs/common";
import { outboxEvents } from "@kapdh/database";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { runAsSystem } from "../context/request-context.js";
import type { Db } from "../db/types.js";
import { safeError } from "../logging/safe-error.js";
import { isOutboxTopic, OUTBOX_TOPICS, type OutboxTopic } from "../outbox/topics.js";
import { CLOCK, DB, ROOT_LOGGER } from "../tokens.js";
import { JobRegistry } from "./job-registry.js";

/** Percobaan maksimum sebelum event outbox menjadi `dead` (butuh tindakan operator, PRD 5.5). */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Kunci klaim; event yang diklaim worker yang mati dapat diklaim ulang setelah ini. */
export const OUTBOX_LOCK_MS = 5 * 60_000;

/** Backoff eksponensial 10 s, 20 s, 40 s, … maksimal 1 jam. */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(3600_000, 10_000 * 2 ** Math.max(0, attempts - 1));
}

export interface DispatchResult {
  claimed: number;
  dispatched: number;
  failed: number;
  dead: number;
}

/**
 * Eksekutor job dan dispatcher outbox (ARCHITECTURE §4.8): dipakai apps/worker (poll 2 detik) dan oleh uji untuk
 * memproses outbox secara sinkron. Klaim memakai `FOR UPDATE SKIP LOCKED` + `locked_until`, sehingga beberapa worker
 * tidak memproses event yang sama bersamaan; handler idempoten menangani pengiriman ulang setelah crash (PRD 5.1).
 * Setiap eksekusi berjalan dalam konteks system dengan request_id asal event (korelasi audit, N-14).
 */
@Injectable()
export class JobRunner {
  constructor(
    readonly registry: JobRegistry,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** Menjalankan satu job terjadwal sekali (scheduler worker, atau uji: `await t.jobs.runScheduled(name)`). */
  async runScheduled(name: string): Promise<void> {
    const job = this.registry.scheduledJob(name);
    if (!job) throw new Error(`Job ${name} tidak terdaftar`);
    const jobId = `${name}:${uuidv7()}`;
    const logger = this.logger.child({ job_id: jobId, job: name });
    await runAsSystem(
      async () => {
        try {
          await job.run(this.clock.now(), { jobId, requestId: jobId, logger });
        } catch (error) {
          logger.error({ error: safeError(error) }, "job terjadwal gagal");
          throw error;
        }
      },
      { jobId },
    );
  }

  /**
   * Helper uji dan operasi manual: memproses outbox berulang (klaim seperti dispatcher, handler dijalankan inline)
   * sampai tidak ada event jatuh tempo. Event yang gagal dijadwalkan ulang dengan backoff sehingga loop berhenti.
   */
  async drainOutbox(options: { maxRounds?: number } = {}): Promise<DispatchResult> {
    const total: DispatchResult = { claimed: 0, dispatched: 0, failed: 0, dead: 0 };
    for (let round = 0; round < (options.maxRounds ?? 20); round++) {
      const result = await this.dispatchOutbox();
      total.claimed += result.claimed;
      total.dispatched += result.dispatched;
      total.failed += result.failed;
      total.dead += result.dead;
      if (result.claimed === 0) break;
    }
    return total;
  }

  /** Mengklaim dan memproses event outbox yang jatuh tempo. */
  async dispatchOutbox(options: { limit?: number; lockMs?: number } = {}): Promise<DispatchResult> {
    const limit = options.limit ?? 50;
    const lockMs = options.lockMs ?? OUTBOX_LOCK_MS;
    const now = this.clock.now();
    const lockedUntil = new Date(now.getTime() + lockMs);
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({
          id: outboxEvents.id,
          topic: outboxEvents.topic,
          dedupKey: outboxEvents.dedupKey,
          payload: outboxEvents.payload,
          attempts: outboxEvents.attempts,
          requestId: outboxEvents.requestId,
        })
        .from(outboxEvents)
        .where(
          and(
            inArray(outboxEvents.status, ["pending", "failed"]),
            lte(outboxEvents.nextAttemptAt, now),
            or(isNull(outboxEvents.lockedUntil), lt(outboxEvents.lockedUntil, now)),
          ),
        )
        .orderBy(asc(outboxEvents.nextAttemptAt), asc(outboxEvents.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      await tx
        .update(outboxEvents)
        .set({ lockedUntil, attempts: sql`${outboxEvents.attempts} + 1` })
        .where(
          inArray(
            outboxEvents.id,
            due.map((d) => d.id),
          ),
        );
      return due.map((d) => ({ ...d, attempts: d.attempts + 1 }));
    });

    const result: DispatchResult = { claimed: claimed.length, dispatched: 0, failed: 0, dead: 0 };
    for (const event of claimed) {
      const jobId = `outbox:${event.id}`;
      const owned = and(eq(outboxEvents.id, event.id), eq(outboxEvents.lockedUntil, lockedUntil));
      try {
        if (!isOutboxTopic(event.topic)) throw new UnknownTopicError();
        const handler = this.registry.handlerFor(event.topic);
        if (!handler) throw new MissingHandlerError();
        const payload = OUTBOX_TOPICS[event.topic].parse(event.payload);
        const requestId = event.requestId ?? event.id;
        const logger = this.logger.child({ job_id: jobId, request_id: requestId, topic: event.topic });
        await runAsSystem(
          () =>
            handler.handle(
              {
                id: event.id,
                topic: event.topic as OutboxTopic,
                dedupKey: event.dedupKey,
                attempts: event.attempts,
                requestId: event.requestId,
                payload,
              },
              { jobId, requestId, logger },
            ),
          { requestId, jobId },
        );
        await this.db
          .update(outboxEvents)
          .set({ status: "dispatched", dispatchedAt: this.clock.now(), lockedUntil: null, lastError: null })
          .where(owned);
        result.dispatched++;
      } catch (error) {
        const dead = error instanceof UnknownTopicError || event.attempts >= OUTBOX_MAX_ATTEMPTS;
        const safe = safeError(error);
        // last_error aman: tipe + kode saja, tanpa pesan/payload (N-14).
        const lastError = [safe.type, safe.error_code].filter(Boolean).join(":").slice(0, 200);
        await this.db
          .update(outboxEvents)
          .set({
            status: dead ? "dead" : "failed",
            nextAttemptAt: new Date(this.clock.now().getTime() + outboxBackoffMs(event.attempts)),
            lockedUntil: null,
            lastError,
          })
          .where(owned);
        this.logger[dead ? "error" : "warn"](
          {
            job_id: jobId,
            request_id: event.requestId,
            topic: event.topic,
            attempts: event.attempts,
            error: safe,
          },
          dead ? "event outbox mati setelah percobaan maksimum" : "event outbox gagal; dijadwalkan ulang",
        );
        if (dead) result.dead++;
        else result.failed++;
      }
    }
    return result;
  }
}

class UnknownTopicError extends Error {
  override name = "UnknownTopicError";
}

class MissingHandlerError extends Error {
  override name = "MissingHandlerError";
}
