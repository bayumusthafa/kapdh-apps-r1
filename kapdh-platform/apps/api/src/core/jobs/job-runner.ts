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
 * Klaim lease satu event outbox (PRD 5.1). `lockedUntil` adalah token kepemilikan (fencing): pengambilalihan saat mulai
 * diproses dan pelepasan hanya berlaku selama `locked_until` di database masih sama dengan nilai klaim ini; setelah
 * diambil alih, perpanjangan lease dan finalisasi memakai token baru milik pemrosesan itu. Klaim ulang setelah lease
 * habis dan pengambilalihan selalu menghasilkan nilai yang lebih besar, sehingga klaim lama tidak pernah dapat
 * dimulai lagi maupun menimpa hasil klaim baru.
 */
export interface OutboxClaim {
  id: string;
  topic: string;
  dedupKey: string;
  /** Percobaan ke-n yang dicatat klaim ini (dimulai 1). */
  attempts: number;
  lockedUntil: Date;
}

/** Rujukan klaim yang cukup untuk memproses/melepasnya (mis. data job BullMQ: hanya id + lease, tanpa payload). */
export type OutboxClaimRef = Pick<OutboxClaim, "id" | "lockedUntil">;

/**
 * Hasil memproses satu klaim. `lost`: lease sudah bukan milik klaim ini (kedaluwarsa lalu diklaim dispatcher lain,
 * klaim yang sama sudah dimulai pemrosesan lain, atau event sudah selesai), sehingga handler tidak dijalankan /
 * hasilnya tidak dicatat.
 */
export type OutboxOutcome = "dispatched" | "failed" | "dead" | "lost";

const CLAIMABLE: ("pending" | "failed")[] = ["pending", "failed"];

/**
 * Eksekutor job dan dispatcher outbox (ARCHITECTURE §4.8): dipakai apps/worker (poll 2 detik) dan oleh uji untuk
 * memproses outbox secara sinkron. Klaim memakai `FOR UPDATE SKIP LOCKED` + `locked_until`, sehingga beberapa worker
 * tidak memproses event yang sama bersamaan; handler idempoten menangani pengiriman ulang setelah crash (PRD 5.1).
 * Setiap eksekusi berjalan dalam konteks system dengan request_id asal event (korelasi audit, N-14).
 *
 * apps/worker memakai tiga langkah terpisah agar klaim dapat diteruskan ke antrean (BullMQ) dengan dedup key:
 * `claimOutbox` → `processOutboxClaim` (di konsumen antrean) → atau `releaseOutboxClaim` bila antrean menolak.
 * `dispatchOutbox` menjalankan ketiganya inline (uji dan worker tanpa Redis).
 */
@Injectable()
export class JobRunner {
  constructor(
    readonly registry: JobRegistry,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Menjalankan satu job terjadwal sekali (scheduler worker, atau uji: `await t.jobs.runScheduled(name)`). `jobId`
   * opsional dari pemanggil (apps/worker: id yang sama dengan log antrean, sehingga satu job_id menghubungkan log
   * antrean, log job, dan audit; N-14). Bawaan `<nama>:<uuidv7>`.
   */
  async runScheduled(name: string, options: { jobId?: string } = {}): Promise<void> {
    const job = this.registry.scheduledJob(name);
    if (!job) throw new Error(`Job ${name} tidak terdaftar`);
    const jobId = options.jobId ?? `${name}:${uuidv7()}`;
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

  /** Mengklaim dan memproses event outbox yang jatuh tempo (inline, berurutan). */
  async dispatchOutbox(options: { limit?: number; lockMs?: number } = {}): Promise<DispatchResult> {
    const claims = await this.claimOutbox(options);
    const result: DispatchResult = { claimed: claims.length, dispatched: 0, failed: 0, dead: 0 };
    for (const claim of claims) {
      const outcome = await this.processOutboxClaim(claim, { lockMs: options.lockMs });
      if (outcome !== "lost") result[outcome]++;
    }
    return result;
  }

  /**
   * Mengklaim sampai `limit` event jatuh tempo (`pending`/`failed`, `next_attempt_at <= now`, lease kosong atau sudah
   * habis) dalam satu transaksi `FOR UPDATE SKIP LOCKED`: `locked_until = now + lockMs` dan `attempts + 1`. Event yang
   * diklaim proses yang kemudian mati diklaim ulang setelah lease habis, sehingga tidak pernah hilang (PRD 5.1).
   */
  async claimOutbox(options: { limit?: number; lockMs?: number } = {}): Promise<OutboxClaim[]> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1) return [];
    const lockMs = options.lockMs ?? OUTBOX_LOCK_MS;
    const now = this.clock.now();
    const lockedUntil = new Date(now.getTime() + lockMs);
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({
          id: outboxEvents.id,
          topic: outboxEvents.topic,
          dedupKey: outboxEvents.dedupKey,
          attempts: outboxEvents.attempts,
        })
        .from(outboxEvents)
        .where(
          and(
            inArray(outboxEvents.status, CLAIMABLE),
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
      return due.map((d) => ({ ...d, attempts: d.attempts + 1, lockedUntil }));
    });
  }

  /**
   * Memproses satu klaim. Langkah pertama MENGAMBIL ALIH lease secara atomik (ARCHITECTURE §2.11): satu UPDATE bersyarat
   * `locked_until = token klaim` yang sekaligus memajukan lease ke `now + lockMs` (selalu > token lama) dan memuat event.
   * Akibatnya (PRD 5.1, "tidak boleh menggandakan … notifikasi"):
   *   - klaim yang lease-nya sudah diklaim ulang dispatcher lain → token berbeda → `lost`, handler tidak dijalankan;
   *   - klaim yang menunggu di antrean melewati lease tetapi belum diklaim ulang → diambil alih dengan lease baru,
   *     sehingga dispatcher lain tidak dapat mengklaimnya selama handler berjalan (tidak ada jendela sampai heartbeat);
   *   - klaim yang sama diproses dua kali (job antrean diulang/stalled) → token sudah maju → proses kedua `lost`.
   * Handler topik berjalan dalam konteks system dengan request_id asal event, lalu event ditandai `dispatched`, atau
   * `failed` + backoff + last_error aman, atau `dead` setelah percobaan maksimum. Selama handler berjalan, lease
   * diperpanjang berkala (heartbeat) agar job panjang (ekspor audit, penghapusan akun) tidak diklaim ulang worker lain.
   * Galat handler tidak dilempar (dicatat ke baris outbox); galat database dilempar agar pemanggil (antrean) dapat
   * mencoba lagi (bila galat terjadi setelah pengambilalihan, percobaan ulang menjadi `lost` dan event diklaim ulang
   * setelah lease habis; handler idempoten).
   */
  async processOutboxClaim(claim: OutboxClaimRef, options: { lockMs?: number } = {}): Promise<OutboxOutcome> {
    const lockMs = options.lockMs ?? OUTBOX_LOCK_MS;
    const jobId = `outbox:${claim.id}`;
    // Token baru selalu lebih besar dari token klaim (juga saat jam tidak bergerak), sehingga satu klaim hanya dapat
    // dimulai sekali.
    const token = new Date(Math.max(this.clock.now().getTime() + lockMs, claim.lockedUntil.getTime() + 1));
    const [event] = await this.db
      .update(outboxEvents)
      .set({ lockedUntil: token })
      .where(
        and(
          eq(outboxEvents.id, claim.id),
          eq(outboxEvents.lockedUntil, claim.lockedUntil),
          inArray(outboxEvents.status, CLAIMABLE),
        ),
      )
      .returning({
        id: outboxEvents.id,
        topic: outboxEvents.topic,
        dedupKey: outboxEvents.dedupKey,
        payload: outboxEvents.payload,
        attempts: outboxEvents.attempts,
        requestId: outboxEvents.requestId,
      });
    if (!event) {
      this.logger.debug({ job_id: jobId }, "klaim outbox tidak lagi berlaku; dilewati");
      return "lost";
    }

    const lease = new LeaseKeeper(this.db, this.clock, claim.id, token, lockMs);
    lease.start();
    let failure: unknown = null;
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
    } catch (error) {
      failure = error ?? new Error("galat handler kosong");
    }
    const owned = await lease.stop();

    if (failure === null) {
      const done = await this.db
        .update(outboxEvents)
        .set({ status: "dispatched", dispatchedAt: this.clock.now(), lockedUntil: null, lastError: null })
        .where(and(eq(outboxEvents.id, event.id), eq(outboxEvents.lockedUntil, owned)))
        .returning({ id: outboxEvents.id });
      if (done.length === 0) return this.lostBeforeFinalize(jobId, event);
      return "dispatched";
    }

    const dead = failure instanceof UnknownTopicError || event.attempts >= OUTBOX_MAX_ATTEMPTS;
    const safe = safeError(failure);
    // last_error aman: tipe + kode saja, tanpa pesan/payload (N-14).
    const lastError = [safe.type, safe.error_code].filter(Boolean).join(":").slice(0, 200);
    const recorded = await this.db
      .update(outboxEvents)
      .set({
        status: dead ? "dead" : "failed",
        nextAttemptAt: new Date(this.clock.now().getTime() + outboxBackoffMs(event.attempts)),
        lockedUntil: null,
        lastError,
      })
      .where(and(eq(outboxEvents.id, event.id), eq(outboxEvents.lockedUntil, owned)))
      .returning({ id: outboxEvents.id });
    if (recorded.length === 0) return this.lostBeforeFinalize(jobId, event);
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
    return dead ? "dead" : "failed";
  }

  /**
   * Mengembalikan klaim yang belum diproses (mis. antrean menolak enqueue karena Redis putus): lease dikosongkan dan
   * percobaan dikembalikan sehingga dispatcher berikutnya dapat mengklaimnya segera tanpa menunggu lease habis. Tidak
   * berpengaruh bila lease sudah bukan milik klaim ini. Mengembalikan true bila klaim dilepas.
   */
  async releaseOutboxClaim(claim: OutboxClaimRef): Promise<boolean> {
    const released = await this.db
      .update(outboxEvents)
      .set({ lockedUntil: null, attempts: sql`greatest(${outboxEvents.attempts} - 1, 0)` })
      .where(
        and(
          eq(outboxEvents.id, claim.id),
          eq(outboxEvents.lockedUntil, claim.lockedUntil),
          inArray(outboxEvents.status, CLAIMABLE),
        ),
      )
      .returning({ id: outboxEvents.id });
    return released.length > 0;
  }

  private lostBeforeFinalize(jobId: string, event: { topic: string; requestId: string | null }): "lost" {
    this.logger.warn(
      { job_id: jobId, request_id: event.requestId, topic: event.topic },
      "lease outbox hilang sebelum hasil dicatat; event akan diklaim ulang (handler idempoten)",
    );
    return "lost";
  }
}

/**
 * Heartbeat lease selama handler berjalan: setiap sepertiga lease, `locked_until` dimajukan dengan UPDATE bersyarat pada
 * token saat ini (fencing). Bila lease sudah diambil alih, token tidak berubah dan finalisasi menjadi `lost`.
 */
class LeaseKeeper {
  private timer: NodeJS.Timeout | null = null;
  private renewing: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly id: string,
    private token: Date,
    private readonly lockMs: number,
  ) {}

  start(): void {
    const every = Math.max(1000, Math.floor(this.lockMs / 3));
    this.timer = setInterval(() => {
      if (!this.renewing) this.renewing = this.renew().finally(() => (this.renewing = null));
    }, every);
    this.timer.unref();
  }

  /** Menghentikan heartbeat, menunggu perpanjangan yang sedang berjalan, dan mengembalikan token terakhir. */
  async stop(): Promise<Date> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.renewing;
    return this.token;
  }

  private async renew(): Promise<void> {
    // Lease tidak pernah dimundurkan (token pengambilalihan bisa 1 ms di atas now + lockMs).
    const next = new Date(Math.max(this.clock.now().getTime() + this.lockMs, this.token.getTime()));
    try {
      const renewed = await this.db
        .update(outboxEvents)
        .set({ lockedUntil: next })
        .where(
          and(
            eq(outboxEvents.id, this.id),
            eq(outboxEvents.lockedUntil, this.token),
            inArray(outboxEvents.status, CLAIMABLE),
          ),
        )
        .returning({ id: outboxEvents.id });
      if (renewed.length > 0) this.token = next;
    } catch {
      // Gagal sementara: dicoba lagi pada detak berikutnya; lease lama tetap berlaku sampai habis.
    }
  }
}

class UnknownTopicError extends Error {
  override name = "UnknownTopicError";
}

class MissingHandlerError extends Error {
  override name = "MissingHandlerError";
}
