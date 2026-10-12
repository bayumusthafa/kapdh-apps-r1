import { Injectable } from "@nestjs/common";
import type { Logger } from "pino";
import type { OutboxPayload, OutboxTopic } from "../outbox/topics.js";

/**
 * Registri job (ARCHITECTURE §4.8): modul mendaftarkan job terjadwal dan handler topik outbox di `onModuleInit`,
 * sehingga prosesor hidup di modulnya (teruji dengan PGlite) dan apps/worker hanya menjalankannya.
 *
 *   constructor(private readonly jobs: JobRegistry, private readonly reservations: ReservationService) {}
 *   onModuleInit() {
 *     this.jobs.registerScheduled({
 *       name: "reservations.expire",
 *       everyMs: 60_000,
 *       run: (now) => this.reservations.expireDue(now),
 *     });
 *     this.jobs.registerTopicHandler({
 *       topic: "event.cancelled",
 *       handle: (event) => this.fanout(event.payload.event_id),
 *     });
 *   }
 *
 * Handler WAJIB idempoten: outbox dapat dikirim ulang setelah crash dan job terjadwal dapat berjalan ganda di dua
 * worker (PRD 5.1). Kunci domain (dedup_key, UNIQUE, kondisi UPDATE) yang menjamin hasil tidak berlipat.
 */

/** Konteks eksekusi job: id untuk log/korelasi (N-14) dan logger pino yang sudah terikat job_id. */
export interface JobContext {
  jobId: string;
  requestId: string;
  logger: Logger;
}

export interface ScheduledJob {
  /** Nama unik bertitik `<modul>.<job>`, mis. `reservations.expire` (prefix job_id di log). */
  name: string;
  /** Interval antar-eksekusi (minimal 1 detik). */
  everyMs: number;
  /** `now` = waktu Clock saat job dimulai; gunakan nilai ini, bukan `new Date()` (ARCHITECTURE §2.6). */
  run(now: Date, ctx: JobContext): Promise<void>;
}

/** Event outbox yang diklaim dispatcher, payload sudah divalidasi skema topik. */
export interface OutboxEvent<T extends OutboxTopic = OutboxTopic> {
  id: string;
  topic: T;
  dedupKey: string;
  /** Percobaan ke-n (dimulai 1). */
  attempts: number;
  /** request_id asal (request HTTP yang mempublikasikan event), untuk korelasi audit/log. */
  requestId: string | null;
  payload: OutboxPayload<T>;
}

export interface TopicHandler<T extends OutboxTopic = OutboxTopic> {
  topic: T;
  handle(event: OutboxEvent<T>, ctx: JobContext): Promise<void>;
}

const JOB_NAME = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

@Injectable()
export class JobRegistry {
  private readonly scheduled = new Map<string, ScheduledJob>();
  private readonly handlers = new Map<OutboxTopic, TopicHandler>();

  registerScheduled(job: ScheduledJob): void {
    if (!JOB_NAME.test(job.name)) throw new Error(`Nama job tidak valid: ${job.name}`);
    if (!Number.isInteger(job.everyMs) || job.everyMs < 1000)
      throw new Error(`Interval job ${job.name} minimal 1 detik`);
    if (this.scheduled.has(job.name)) throw new Error(`Job ${job.name} sudah terdaftar`);
    this.scheduled.set(job.name, job);
  }

  /** Satu handler per topik; fanout ke beberapa efek dilakukan di dalam handler itu sendiri. */
  registerTopicHandler<T extends OutboxTopic>(handler: TopicHandler<T>): void {
    if (this.handlers.has(handler.topic)) throw new Error(`Handler topik ${handler.topic} sudah terdaftar`);
    this.handlers.set(handler.topic, handler as unknown as TopicHandler);
  }

  scheduledJobs(): ScheduledJob[] {
    return [...this.scheduled.values()];
  }

  scheduledJob(name: string): ScheduledJob | undefined {
    return this.scheduled.get(name);
  }

  handlerFor(topic: OutboxTopic): TopicHandler | undefined {
    return this.handlers.get(topic);
  }

  topics(): OutboxTopic[] {
    return [...this.handlers.keys()];
  }
}
