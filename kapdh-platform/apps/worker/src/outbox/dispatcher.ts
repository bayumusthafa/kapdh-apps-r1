import {
  type Clock,
  type OutboxClaim,
  type OutboxClaimRef,
  type OutboxOutcome,
  safeError,
} from "@kapdh/api/worker";
import type { Logger } from "pino";
import { type QueueDriver, queueJobId } from "../queue/queue-driver.js";

/** Bagian JobRunner (@kapdh/api/worker) yang dipakai dispatcher. */
export interface OutboxJobs {
  claimOutbox(options: { limit: number; lockMs: number }): Promise<OutboxClaim[]>;
  processOutboxClaim(claim: OutboxClaimRef, options: { lockMs: number }): Promise<OutboxOutcome>;
  releaseOutboxClaim(claim: OutboxClaimRef): Promise<boolean>;
}

/** Data job antrean outbox: hanya id event dan token lease, tanpa payload (N-14). */
export interface OutboxJobData {
  outbox_id: string;
  lease: string;
}

export interface OutboxDispatcherOptions {
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  concurrency: number;
  attempts: number;
  backoffMs: number;
}

/** Jeda singkat saat semua slot antrean penuh: memeriksa slot lagi tanpa menyentuh database. */
const BUSY_RECHECK_MS = 200;

export interface DispatcherStatus {
  running: boolean;
  /** Akhir iterasi poll terakhir (berhasil atau tidak): bukti loop hidup. */
  lastLoopAt: Date | null;
  /** Akhir poll terakhir yang berhasil menyentuh database/antrean. */
  lastPollOkAt: Date | null;
  consecutiveFailures: number;
  totals: Record<OutboxOutcome, number> & { claimed: number; released: number };
}

/**
 * Dispatcher outbox (PRD 5.1, ARCHITECTURE §4.8): setiap ~2 detik mengklaim event jatuh tempo (`FOR UPDATE SKIP
 * LOCKED` + lease `locked_until`) sebanyak slot antrean yang kosong, lalu meneruskannya ke antrean dengan jobId = dedup
 * key event + nomor percobaan. Konsumen antrean memanggil `processOutboxClaim` (handler topik terdaftar, dispatched /
 * failed + backoff / dead). Bila enqueue gagal, klaim dilepas; bila proses mati, lease habis dan event diklaim ulang,
 * sehingga event tidak pernah hilang.
 */
export class OutboxDispatcher {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlightPoll: Promise<void> | null = null;
  private readonly state: DispatcherStatus = {
    running: false,
    lastLoopAt: null,
    lastPollOkAt: null,
    consecutiveFailures: 0,
    totals: { claimed: 0, released: 0, dispatched: 0, failed: 0, dead: 0, lost: 0 },
  };

  constructor(
    private readonly deps: { jobs: OutboxJobs; queue: QueueDriver; clock: Clock; logger: Logger },
    private readonly options: OutboxDispatcherOptions,
  ) {}

  /** Mendaftarkan konsumen antrean `outbox` (sebelum queue.start()). */
  attach(): void {
    this.deps.queue.register<OutboxJobData>(
      "outbox",
      async (data) => {
        const outcome = await this.deps.jobs.processOutboxClaim(toClaimRef(data), {
          lockMs: this.options.leaseMs,
        });
        this.state.totals[outcome]++;
      },
      {
        concurrency: this.options.concurrency,
        // Job yang dibuang saat shutdown (belum berjalan) dilepas agar instance berikutnya tidak menunggu lease habis.
        discard: async (data) => {
          if (await this.deps.jobs.releaseOutboxClaim(toClaimRef(data))) this.state.totals.released++;
        },
        // N-14: log antrean memakai job_id yang sama dengan JobRunner (`outbox:<id event>`) dan audit handler.
        correlate: (data) => outboxJobId(data.outbox_id),
      },
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state.running = true;
    this.schedule(0);
  }

  /** Menghentikan poll; klaim yang sudah diteruskan diselesaikan konsumen antrean (queue.close). */
  async stop(): Promise<void> {
    this.running = false;
    this.state.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlightPoll;
  }

  status(): DispatcherStatus {
    return { ...this.state, totals: { ...this.state.totals } };
  }

  /**
   * Satu putaran poll: klaim sebanyak slot kosong (maksimal batchSize) lalu enqueue. Mengembalikan
   * {claimed, limit}; limit 0 berarti antrean penuh (backpressure).
   */
  async pollOnce(): Promise<{ claimed: number; limit: number }> {
    const free = await this.deps.queue.capacity("outbox");
    const limit = Math.min(this.options.batchSize, free);
    if (limit <= 0) return { claimed: 0, limit: 0 };
    const claims = await this.deps.jobs.claimOutbox({ limit, lockMs: this.options.leaseMs });
    this.state.totals.claimed += claims.length;
    for (let index = 0; index < claims.length; index++) {
      const claim = claims[index]!;
      try {
        await this.deps.queue.enqueue<OutboxJobData>("outbox", {
          // Dedup key event + token lease klaim: klaim yang sama tidak pernah masuk antrean dua kali, sedangkan klaim
          // ulang (lease habis atau klaim dilepas) mendapat job baru; job lama yang masih menunggu menjadi `lost`
          // karena lease-nya tidak lagi berlaku, sehingga handler tidak pernah berjalan ganda untuk satu klaim.
          jobId: queueJobId("outbox", claim.dedupKey, String(claim.lockedUntil.getTime())),
          data: { outbox_id: claim.id, lease: claim.lockedUntil.toISOString() },
          attempts: this.options.attempts,
          backoffMs: this.options.backoffMs,
        });
      } catch (error) {
        // Antrean tidak tersedia (mis. Redis putus): kembalikan klaim ini dan sisanya agar tidak menunggu lease habis.
        const rest = claims.slice(index);
        let released = 0;
        for (const pending of rest) {
          try {
            if (await this.deps.jobs.releaseOutboxClaim(pending)) released++;
          } catch {
            // Lease tetap berlaku sampai habis; event diklaim ulang setelahnya.
          }
        }
        this.state.totals.released += released;
        this.deps.logger.warn(
          { error: safeError(error), unqueued: rest.length, released },
          "antrean menolak klaim outbox; klaim dilepas",
        );
        throw error;
      }
    }
    return { claimed: claims.length, limit };
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlightPoll = this.loop().finally(() => (this.inFlightPoll = null));
    }, delayMs);
  }

  private async loop(): Promise<void> {
    let next = this.options.pollIntervalMs;
    try {
      const { claimed, limit } = await this.pollOnce();
      this.state.lastPollOkAt = this.deps.clock.now();
      this.state.consecutiveFailures = 0;
      // Batch penuh: masih ada backlog, poll lagi segera. Antrean penuh: periksa slot lagi sebentar lagi.
      if (limit === 0) next = Math.min(BUSY_RECHECK_MS, this.options.pollIntervalMs);
      else if (claimed === limit) next = 0;
    } catch (error) {
      this.state.consecutiveFailures++;
      // Log dibatasi: galat pertama dan setiap 30 kegagalan berturut-turut (DB/Redis mati tidak membanjiri log).
      if (this.state.consecutiveFailures === 1 || this.state.consecutiveFailures % 30 === 0)
        this.deps.logger.error(
          { error: safeError(error), consecutive_failures: this.state.consecutiveFailures },
          "poll outbox gagal",
        );
    } finally {
      this.state.lastLoopAt = this.deps.clock.now();
    }
    this.schedule(next);
  }
}

/** job_id JobRunner untuk satu event outbox (`outbox:<id>`), dipakai juga oleh log antrean (N-14). */
export function outboxJobId(outboxId: string): string {
  return `outbox:${outboxId}`;
}

function toClaimRef(data: OutboxJobData): OutboxClaimRef {
  return { id: data.outbox_id, lockedUntil: new Date(data.lease) };
}
