import { Injectable } from "@nestjs/common";
import type { OutboxPayload, OutboxTopic } from "../outbox/topics.js";

/**
 * Registri job (ARCHITECTURE §4.8): modul mendaftarkan job terjadwal dan handler topik outbox di `onModuleInit`,
 * sehingga prosesor hidup di modulnya (teruji dengan PGlite) dan apps/worker hanya menjalankannya.
 *
 *   constructor(private readonly jobs: JobRegistry, private readonly reservations: ReservationService) {}
 *   onModuleInit() {
 *     this.jobs.registerScheduled({ name: "reservations.expire", intervalMs: 60_000, run: () => this.reservations.expireDue() });
 *     this.jobs.registerTopicHandler("event.cancelled", (payload) => this.fanout(payload.event_id));
 *   }
 *
 * Handler WAJIB idempoten: outbox dapat dikirim ulang setelah crash (PRD 5.1).
 */
export interface ScheduledJob {
  /** Nama unik bertitik, mis. `reservations.expire` (dipakai sebagai job_id prefix di log). */
  name: string;
  /** Interval antar-eksekusi. */
  intervalMs: number;
  run(): Promise<void>;
}

export interface OutboxEventMeta {
  id: string;
  topic: OutboxTopic;
  dedupKey: string;
  attempts: number;
  requestId: string | null;
}

export type TopicHandler<T extends OutboxTopic> = (payload: OutboxPayload<T>, event: OutboxEventMeta) => Promise<void>;

@Injectable()
export class JobRegistry {
  private readonly scheduled = new Map<string, ScheduledJob>();
  private readonly handlers = new Map<OutboxTopic, TopicHandler<OutboxTopic>>();

  registerScheduled(job: ScheduledJob): void {
    if (!/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/.test(job.name)) throw new Error(`Nama job tidak valid: ${job.name}`);
    if (job.intervalMs < 1000) throw new Error(`Interval job ${job.name} minimal 1 detik`);
    if (this.scheduled.has(job.name)) throw new Error(`Job ${job.name} sudah terdaftar`);
    this.scheduled.set(job.name, job);
  }

  /** Satu handler per topik; fanout ke beberapa efek dilakukan di dalam handler itu sendiri. */
  registerTopicHandler<T extends OutboxTopic>(topic: T, handler: TopicHandler<T>): void {
    if (this.handlers.has(topic)) throw new Error(`Handler topik ${topic} sudah terdaftar`);
    this.handlers.set(topic, handler as unknown as TopicHandler<OutboxTopic>);
  }

  scheduledJobs(): ScheduledJob[] {
    return [...this.scheduled.values()];
  }

  scheduledJob(name: string): ScheduledJob | undefined {
    return this.scheduled.get(name);
  }

  handlerFor(topic: OutboxTopic): TopicHandler<OutboxTopic> | undefined {
    return this.handlers.get(topic);
  }

  topics(): OutboxTopic[] {
    return [...this.handlers.keys()];
  }
}
