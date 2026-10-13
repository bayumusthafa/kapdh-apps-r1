import { type Clock, safeError, type ScheduledJob } from "@kapdh/api/worker";
import type { Logger } from "pino";
import { type QueueDriver, queueJobId } from "../queue/queue-driver.js";
import type { LeaderLock } from "./leader-lock.js";

/** Bagian JobRegistry/JobRunner (@kapdh/api/worker) yang dipakai penjadwal. */
export interface ScheduledJobSource {
  scheduledJobs(): ScheduledJob[];
}
export interface ScheduledJobRunner {
  runScheduled(name: string): Promise<void>;
}

/** Data job antrean `scheduled`: nama job + awal slot jadwal (ISO), tanpa data bisnis. */
export interface ScheduledJobData {
  name: string;
  slot: string;
}

export interface SchedulerOptions {
  /** Interval evaluasi jadwal dan cek leader (bawaan 1 s). */
  tickMs: number;
  concurrency: number;
  attempts: number;
  backoffMs: number;
  /** Jarak antar-job saat run susulan setelah menjadi leader, agar tidak semua job berjalan bersamaan. */
  staggerMs?: number;
}

export type SchedulerRole = "leader" | "standby";

export interface ScheduledJobStatus {
  name: string;
  everyMs: number;
  nextDueAt: Date | null;
  lastEnqueuedAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: "ok" | "failed" | null;
}

export interface SchedulerStatus {
  running: boolean;
  role: SchedulerRole;
  /** Tick terakhir sebagai leader (jadwal dievaluasi). */
  lastTickAt: Date | null;
  /** Pemeriksaan leader terakhir (leader maupun standby): bukti loop hidup. */
  lastLeaderCheckAt: Date | null;
  jobs: ScheduledJobStatus[];
}

const ENQUEUE_RETRY_MAX_MS = 15_000;

/**
 * Penjadwal job terdaftar (ARCHITECTURE §4.8) dengan leader tunggal lewat kunci advisory PostgreSQL: setiap tick,
 * instance memeriksa/mengambil kunci; hanya leader yang menjadwalkan. Jadwal sejajar slot `floor(now / everyMs)`:
 * setelah menjadi leader setiap job dijalankan sekali (susulan, bertahap), lalu pada setiap batas slot berikutnya.
 * jobId = `scheduled.<nama>.<awal slot>` sehingga satu slot tidak pernah dijadwalkan dua kali di antrean yang sama
 * (BullMQ: juga lintas pergantian leader selama catatan slot disimpan). Slot dilewati bila run sebelumnya masih
 * berjalan (tidak menumpuk). Job tetap wajib idempoten (PRD 5.1): pergantian leader di driver inline dapat
 * mengulang slot berjalan.
 */
export class Scheduler {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlightTick: Promise<void> | null = null;
  private role: SchedulerRole = "standby";
  private lastTickAt: Date | null = null;
  private lastLeaderCheckAt: Date | null = null;
  private leaderErrors = 0;
  private readonly nextDue = new Map<string, number>();
  private readonly lastJobId = new Map<string, string>();
  private readonly jobStatus = new Map<string, Omit<ScheduledJobStatus, "name" | "everyMs" | "nextDueAt">>();

  constructor(
    private readonly deps: {
      registry: ScheduledJobSource;
      jobs: ScheduledJobRunner;
      queue: QueueDriver;
      leader: LeaderLock;
      clock: Clock;
      logger: Logger;
    },
    private readonly options: SchedulerOptions,
  ) {}

  /** Mendaftarkan konsumen antrean `scheduled` (sebelum queue.start()). */
  attach(): void {
    this.deps.queue.register<ScheduledJobData>(
      "scheduled",
      async (data, meta) => {
        const status = this.statusFor(data.name);
        status.lastStartedAt = this.deps.clock.now();
        const started = performance.now();
        try {
          await this.deps.jobs.runScheduled(data.name);
          status.lastStatus = "ok";
          meta.logger.info(
            { job: data.name, slot: data.slot, duration_ms: Math.round(performance.now() - started) },
            "job terjadwal selesai",
          );
        } catch (error) {
          status.lastStatus = "failed";
          throw error;
        } finally {
          status.lastFinishedAt = this.deps.clock.now();
        }
      },
      { concurrency: this.options.concurrency },
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Menghentikan tick (tidak ada jadwal baru). Kunci leader dilepas terpisah lewat {@link resign}. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlightTick;
  }

  /** Melepas kunci leader (setelah job terjadwal yang berjalan selesai) agar instance lain segera mengambil alih. */
  async resign(): Promise<void> {
    if (this.role !== "leader") return;
    this.role = "standby";
    try {
      await this.deps.leader.release();
      this.deps.logger.info("kunci leader penjadwal dilepas");
    } catch (error) {
      // Koneksi kunci ditutup sesudahnya; PostgreSQL melepas kunci sesi saat backend berakhir.
      this.deps.logger.warn({ error: safeError(error) }, "gagal melepas kunci leader; dilepas saat koneksi ditutup");
    }
  }

  status(): SchedulerStatus {
    return {
      running: this.running,
      role: this.role,
      lastTickAt: this.lastTickAt,
      lastLeaderCheckAt: this.lastLeaderCheckAt,
      jobs: this.deps.registry.scheduledJobs().map((job) => {
        const due = this.nextDue.get(job.name);
        return {
          name: job.name,
          everyMs: job.everyMs,
          nextDueAt: due === undefined ? null : new Date(due),
          ...this.statusFor(job.name),
        };
      }),
    };
  }

  /** Satu tick: cek/ambil kunci leader, lalu (bila leader) menjadwalkan job yang jatuh tempo. */
  async tick(): Promise<void> {
    const now = this.deps.clock.now();
    let leader = false;
    try {
      leader = await this.deps.leader.tryAcquire();
      this.leaderErrors = 0;
    } catch (error) {
      this.leaderErrors++;
      if (this.leaderErrors === 1 || this.leaderErrors % 60 === 0)
        this.deps.logger.error(
          { error: safeError(error), consecutive_failures: this.leaderErrors },
          "pemeriksaan kunci leader penjadwal gagal; penjadwalan dihentikan sementara",
        );
    }
    this.lastLeaderCheckAt = now;
    if (leader && this.role !== "leader") {
      this.role = "leader";
      this.nextDue.clear();
      this.deps.logger.info("instance ini menjadi leader penjadwal");
    } else if (!leader && this.role === "leader") {
      this.role = "standby";
      this.deps.logger.warn("kunci leader penjadwal hilang; instance ini menjadi standby");
    }
    if (!leader) return;

    const jobs = this.deps.registry.scheduledJobs();
    const stagger = this.options.staggerMs ?? 1_000;
    jobs.forEach((job, index) => {
      if (!this.nextDue.has(job.name)) this.nextDue.set(job.name, now.getTime() + index * stagger);
    });
    for (const job of jobs) await this.maybeEnqueue(job, now);
    this.lastTickAt = now;
  }

  private async maybeEnqueue(job: ScheduledJob, now: Date): Promise<void> {
    const due = this.nextDue.get(job.name) ?? now.getTime();
    if (now.getTime() < due) return;
    const slot = Math.floor(now.getTime() / job.everyMs) * job.everyMs;
    const nextSlot = slot + job.everyMs;
    try {
      const previous = this.lastJobId.get(job.name);
      if (previous && (await this.deps.queue.isPending("scheduled", previous))) {
        this.nextDue.set(job.name, nextSlot);
        this.deps.logger.warn(
          { job: job.name, slot: new Date(slot).toISOString() },
          "run sebelumnya masih berjalan; slot jadwal dilewati",
        );
        return;
      }
      const jobId = queueJobId("scheduled", job.name, String(slot));
      const added = await this.deps.queue.enqueue<ScheduledJobData>("scheduled", {
        jobId,
        data: { name: job.name, slot: new Date(slot).toISOString() },
        attempts: this.options.attempts,
        backoffMs: this.options.backoffMs,
        // Catatan slot disimpan melewati slot berikutnya agar leader baru tidak menjadwalkan slot yang sama.
        retainMs: Math.max(2 * job.everyMs, 60_000),
      });
      this.lastJobId.set(job.name, jobId);
      this.nextDue.set(job.name, nextSlot);
      if (added) this.statusFor(job.name).lastEnqueuedAt = now;
      else this.deps.logger.debug({ job: job.name, job_id: jobId }, "slot jadwal sudah ada di antrean (dedup)");
    } catch (error) {
      this.nextDue.set(job.name, now.getTime() + Math.min(job.everyMs, ENQUEUE_RETRY_MAX_MS));
      this.deps.logger.warn({ job: job.name, error: safeError(error) }, "gagal menjadwalkan job; dicoba lagi");
    }
  }

  private statusFor(name: string) {
    let status = this.jobStatus.get(name);
    if (!status) {
      status = { lastEnqueuedAt: null, lastStartedAt: null, lastFinishedAt: null, lastStatus: null };
      this.jobStatus.set(name, status);
    }
    return status;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlightTick = this.tick()
        .catch((error) => this.deps.logger.error({ error: safeError(error) }, "tick penjadwal gagal"))
        .finally(() => {
          this.inFlightTick = null;
          this.schedule(this.options.tickMs);
        });
    }, delayMs);
  }
}
