import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { accountDeletions } from "@kapdh/database";
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { safeError } from "../../core/logging/safe-error.js";
import { CLOCK, DB, ROOT_LOGGER } from "../../core/tokens.js";
import { DELETION_LEASE_MS } from "./deletion-policy.js";
import type { DeletionRow } from "./deletion-request.service.js";
import {
  DELETION_STEPS,
  type DeletionStep,
  DeletionSteps,
  EMAIL_STEPS,
  type StepContext,
  type WorkingLedger,
} from "./deletion-steps.js";

/** Nama job terjadwal sapuan ulang (ARCHITECTURE §4.8: topik + sapuan setiap 10 menit). */
export const ACCOUNT_DELETION_JOB = "account.deletion";
export const SWEEP_EVERY_MS = 10 * 60_000;
/** Email gagal sebanyak ini (atau batas 7 hari lewat) dilewati agar penghapusan tidak tertahan (F-14, D2). */
export const EMAIL_MAX_FAILURES = 3;
const SWEEP_BATCH = 20;

/** Backoff pengulangan setelah gagal: 10, 20, 40 menit, ... maksimal 6 jam (AC F14-2, N-15). */
export function deletionRetryBackoffMs(attempts: number): number {
  return Math.min(6 * 3600_000, 10 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

export type DeletionRunResult =
  | { outcome: "completed"; requestNumber: string }
  | { outcome: "failed"; requestNumber: string; step: DeletionStep | "complete" }
  | { outcome: "skipped" };

/**
 * Pengamat langkah: dipanggil setelah setiap langkah commit. Dipakai untuk log operasional dan uji injeksi kegagalan
 * sesudah setiap langkah (PRD 6.5 "injection failure sesudah setiap langkah kritis", AC F14-2): pengamat yang melempar
 * membuat eksekusi gagal persis seperti galat langkah berikutnya.
 */
export type DeletionStepObserver = (event: { deletionId: string; step: DeletionStep }) => void | Promise<void>;

function normalizeLedger(raw: unknown): WorkingLedger {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<WorkingLedger>) : {};
  return { ...value, v: 1 };
}

/**
 * Job `account.deletion` (F-14, AC F14-2; ARCHITECTURE §4.8): dipicu outbox `account.deletion.requested` dan sapuan
 * ulang setiap 10 menit. Satu permintaan diklaim dengan UPDATE bersyarat (status `processing` + sewa), lalu
 * {@link DELETION_STEPS} dijalankan berurutan melewati langkah yang sudah ada di `steps_done`. Gagal: status
 * `failed`, `last_error` aman (langkah + tipe/kode galat, tanpa pesan/PII), dicoba ulang dengan backoff tanpa
 * mengulang langkah yang selesai. Selesai: `completed`, `completed_at` (target <= 7 hari kalender).
 */
@Injectable()
export class AccountDeletionProcessor implements OnModuleInit {
  private observer: DeletionStepObserver | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly jobs: JobRegistry,
    private readonly audit: AuditService,
    private readonly steps: DeletionSteps,
  ) {}

  onModuleInit(): void {
    this.jobs.registerTopicHandler({
      topic: "account.deletion.requested",
      handle: async (event, ctx) => {
        await this.run(event.payload.deletion_id, { logger: ctx.logger });
      },
    });
    this.jobs.registerScheduled({
      name: ACCOUNT_DELETION_JOB,
      everyMs: SWEEP_EVERY_MS,
      run: async (now, ctx) => {
        await this.sweep(now, ctx.logger);
      },
    });
  }

  /** Memasang/melepas pengamat langkah (lihat {@link DeletionStepObserver}). */
  setStepObserver(observer: DeletionStepObserver | null): void {
    this.observer = observer;
  }

  /** Sapuan: permintaan pending/failed yang jatuh tempo dan `processing` yang sewanya habis. */
  async sweep(now: Date, logger: Logger = this.logger): Promise<DeletionRunResult[]> {
    const due = await this.db
      .select({ id: accountDeletions.id })
      .from(accountDeletions)
      .where(
        or(
          and(
            inArray(accountDeletions.status, ["pending", "failed"]),
            or(isNull(accountDeletions.nextAttemptAt), lte(accountDeletions.nextAttemptAt, now)),
          ),
          and(eq(accountDeletions.status, "processing"), lte(accountDeletions.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(accountDeletions.requestedAt), asc(accountDeletions.id))
      .limit(SWEEP_BATCH);
    const results: DeletionRunResult[] = [];
    for (const { id } of due) results.push(await this.run(id, { logger }));
    const [overdue] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(accountDeletions)
      .where(and(ne(accountDeletions.status, "completed"), lt(accountDeletions.deadlineAt, now)));
    if (Number(overdue?.value ?? 0) > 0)
      logger.error(
        { overdue: Number(overdue!.value) },
        "permintaan penghapusan akun melewati batas 7 hari; periksa last_error (F-14)",
      );
    return results;
  }

  /**
   * Menjalankan satu permintaan bila dapat diklaim. `force` (penerapan ulang ledger setelah restore) mengabaikan
   * jadwal backoff tetapi tidak merebut permintaan yang sedang diproses worker lain (sewa belum habis).
   */
  async run(deletionId: string, options: { force?: boolean; logger?: Logger } = {}): Promise<DeletionRunResult> {
    const logger = options.logger ?? this.logger;
    const claimed = await this.claim(deletionId, options.force === true);
    if (!claimed) return { outcome: "skipped" };
    const ctx: StepContext = {
      deletion: claimed,
      userId: claimed.userId,
      ledger: normalizeLedger(claimed.ledger),
      done: new Set(claimed.stepsDone),
    };
    let current: DeletionStep | "complete" = "complete";
    try {
      for (const step of DELETION_STEPS) {
        if (ctx.done.has(step)) continue;
        current = step;
        await this.runStep(step, ctx, logger);
        await this.observer?.({ deletionId, step });
      }
      current = "complete";
      await this.complete(ctx);
      logger.info({ deletion_id: deletionId }, "penghapusan akun selesai");
      return { outcome: "completed", requestNumber: claimed.requestNumber };
    } catch (error) {
      await this.fail(ctx, current, error, logger);
      return { outcome: "failed", requestNumber: claimed.requestNumber, step: current };
    }
  }

  private async claim(deletionId: string, force: boolean): Promise<DeletionRow | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(accountDeletions)
      .set({
        status: "processing",
        attempts: sql`${accountDeletions.attempts} + 1`,
        nextAttemptAt: new Date(now.getTime() + DELETION_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(accountDeletions.id, deletionId),
          ne(accountDeletions.status, "completed"),
          or(ne(accountDeletions.status, "processing"), lte(accountDeletions.nextAttemptAt, now)),
          force
            ? undefined
            : or(isNull(accountDeletions.nextAttemptAt), lte(accountDeletions.nextAttemptAt, now)),
        ),
      )
      .returning();
    return row ?? null;
  }

  private async runStep(step: DeletionStep, ctx: StepContext, logger: Logger): Promise<void> {
    try {
      await this.execute(step, ctx);
    } catch (error) {
      if (!EMAIL_STEPS.has(step)) throw error;
      // Email gagal: dicoba ulang; setelah EMAIL_MAX_FAILURES kali atau batas 7 hari lewat, dilewati agar data
      // pribadi tidak tertahan lebih lama dari batas (D2).
      const failures = (ctx.ledger.email_failures?.[step] ?? 0) + 1;
      ctx.ledger.email_failures = { ...ctx.ledger.email_failures, [step]: failures };
      if (failures < EMAIL_MAX_FAILURES && this.clock.now() < ctx.deletion.deadlineAt) throw error;
      ctx.ledger.skipped = [...new Set([...(ctx.ledger.skipped ?? []), step])];
      logger.warn(
        { deletion_id: ctx.deletion.id, step, failures, error: safeError(error) },
        "email penghapusan akun dilewati setelah gagal berulang",
      );
      await this.db.transaction((tx) => this.steps.markDone(tx, ctx, step));
    }
  }

  private execute(step: DeletionStep, ctx: StepContext): Promise<void> {
    switch (step) {
      case "ledger_open":
        return this.steps.ledgerOpen(ctx);
      case "notify_requested":
        return this.steps.notifyRequested(ctx);
      case "inventory":
        return this.steps.inventory(ctx);
      case "revoke_access":
        return this.steps.revokeAccess(ctx);
      case "tickets_payments":
        return this.steps.ticketsAndPayments(ctx);
      case "chat_rooms":
        return this.steps.chatRooms(ctx);
      case "chat_messages":
        return this.steps.chatMessages(ctx);
      case "community":
        return this.steps.community(ctx);
      case "notifications":
        return this.steps.notifications(ctx);
      case "files":
        return this.steps.files(ctx);
      case "finance":
        return this.steps.finance(ctx);
      case "audit":
        return this.steps.auditAnonymize(ctx);
      case "profile":
        return this.steps.profile(ctx);
      case "notify_completed":
        return this.steps.notifyCompleted(ctx);
      case "credentials":
        return this.steps.credentials(ctx);
      case "ledger_final":
        return this.steps.ledgerFinal(ctx);
    }
  }

  private async complete(ctx: StepContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [done] = await tx
        .update(accountDeletions)
        .set({
          status: "completed",
          completedAt: now,
          lastError: null,
          nextAttemptAt: null,
          ledger: ctx.ledger as unknown as Record<string, unknown>,
          updatedAt: now,
        })
        .where(and(eq(accountDeletions.id, ctx.deletion.id), eq(accountDeletions.status, "processing")))
        .returning({ id: accountDeletions.id });
      if (!done) throw new Error("Permintaan penghapusan tidak lagi diklaim eksekusi ini");
      await this.audit.write(tx, {
        action: "account.deletion_completed",
        entityType: "account_deletion",
        entityId: ctx.deletion.id,
        after: {
          request_number: ctx.deletion.requestNumber,
          status: "completed",
          skipped_steps: ctx.ledger.skipped ?? [],
        },
      });
    });
  }

  private async fail(
    ctx: StepContext,
    step: DeletionStep | "complete",
    error: unknown,
    logger: Logger,
  ): Promise<void> {
    const now = this.clock.now();
    const safe = safeError(error);
    // last_error aman (AC F14-2): langkah + tipe + kode/constraint, tanpa pesan yang dapat memuat data pribadi.
    const lastError = [step, safe.type, safe.error_code, safe.constraint].filter(Boolean).join(":").slice(0, 200);
    await this.db
      .update(accountDeletions)
      .set({
        status: "failed",
        lastError,
        nextAttemptAt: new Date(now.getTime() + deletionRetryBackoffMs(ctx.deletion.attempts)),
        ledger: ctx.ledger as unknown as Record<string, unknown>,
        updatedAt: now,
      })
      .where(and(eq(accountDeletions.id, ctx.deletion.id), eq(accountDeletions.status, "processing")));
    logger.warn(
      { deletion_id: ctx.deletion.id, step, attempts: ctx.deletion.attempts, error: safe },
      "langkah penghapusan akun gagal; dijadwalkan ulang",
    );
  }
}
