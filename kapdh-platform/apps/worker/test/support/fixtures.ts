/**
 * Utilitas uji worker: PGlite yang dimigrasi dengan migrator production, jam uji, logger memori (JSON pino yang sama
 * dengan production, termasuk redaksi), registri palsu (JobRegistry + handler uji), dan sisipan outbox langsung.
 */
import { PGlite } from "@electric-sql/pglite";
import { type Clock, createRootLogger, type Db, JobRegistry, JobRunner } from "@kapdh/api/worker";
import { MIGRATIONS_FOLDER, outboxEvents, schema } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";

export const T0 = new Date("2026-10-13T02:00:00.000Z");

export class TestClock implements Clock {
  private current: number;
  constructor(start: Date = T0) {
    this.current = start.getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(at: Date): void {
    this.current = at.getTime();
  }
}

export interface TestDatabase {
  pg: PGlite;
  db: Db;
  close(): Promise<void>;
}

/** PGlite baru dengan seluruh migrasi journal (sama dengan job migrasi production). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { pg, db: db as unknown as Db, close: () => pg.close() };
}

export async function clearOutbox(db: Db): Promise<void> {
  await db.delete(outboxEvents);
}

export interface LogCapture {
  logger: Logger;
  lines: Record<string, unknown>[];
}

/** Logger root production (`createRootLogger`) ke memori: setiap baris JSON di-parse untuk diperiksa. */
export function memoryLogger(level = "debug"): LogCapture {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger({
    level,
    service: "kapdh-worker",
    destination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  });
  return { logger, lines };
}

export const silentLogger = (): Logger => createRootLogger({ level: "silent", service: "kapdh-worker" });

export interface OutboxSeed {
  topic?: string;
  payload?: Record<string, unknown>;
  status?: "pending" | "failed" | "dead" | "dispatched";
  attempts?: number;
  nextAttemptAt?: Date;
  lockedUntil?: Date | null;
  createdAt?: Date;
  requestId?: string | null;
}

/** Menyisipkan event outbox langsung (seperti OutboxService.publish di transaksi bisnis). */
export async function insertOutboxEvent(db: Db, clock: Clock, seed: OutboxSeed = {}): Promise<string> {
  const id = uuidv7();
  const topic = seed.topic ?? "event.cancelled";
  await db.insert(outboxEvents).values({
    id,
    topic,
    dedupKey: `${topic}:${id}`,
    payload: seed.payload ?? { event_id: uuidv7() },
    status: seed.status ?? "pending",
    attempts: seed.attempts ?? 0,
    nextAttemptAt: seed.nextAttemptAt ?? clock.now(),
    lockedUntil: seed.lockedUntil ?? null,
    requestId: seed.requestId === undefined ? `req-${id}` : seed.requestId,
    createdAt: seed.createdAt ?? clock.now(),
    ...(seed.status === "dispatched" ? { dispatchedAt: clock.now() } : {}),
  });
  return id;
}

export async function outboxRow(db: Db, id: string) {
  const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  if (!row) throw new Error(`event outbox ${id} tidak ada`);
  return row;
}

/** Catatan pemanggilan handler uji. */
export interface HandledCall {
  id: string;
  topic: string;
  attempts: number;
  payload: unknown;
  jobId: string;
  requestId: string;
}

/**
 * Registri palsu: JobRegistry asli berisi handler topik uji yang mencatat pemanggilan, dapat dibuat gagal
 * (`failNext`), atau ditahan sampai `release()` (simulasi job panjang).
 */
export function fakeRegistry(topics: string[] = ["event.cancelled", "audit.export.requested"]) {
  const registry = new JobRegistry();
  const calls: HandledCall[] = [];
  const control = {
    failNext: 0,
    failAlways: false,
    gate: null as Promise<void> | null,
    onHandle: null as ((call: HandledCall) => Promise<void> | void) | null,
  };
  let releaseGate: (() => void) | null = null;
  for (const topic of topics) {
    registry.registerTopicHandler({
      topic: topic as "event.cancelled",
      handle: async (event, ctx) => {
        const call: HandledCall = {
          id: event.id,
          topic: event.topic,
          attempts: event.attempts,
          payload: event.payload,
          jobId: ctx.jobId,
          requestId: ctx.requestId,
        };
        calls.push(call);
        await control.onHandle?.(call);
        if (control.gate) await control.gate;
        if (control.failAlways || control.failNext > 0) {
          control.failNext = Math.max(0, control.failNext - 1);
          // Pesan berisi data yang TIDAK boleh tersimpan di last_error/log (N-14).
          throw Object.assign(new Error("SMTP menolak rahasia@contoh.id"), { code: "ECONNRESET" });
        }
      },
    });
  }
  return {
    registry,
    calls,
    control,
    hold() {
      control.gate = new Promise<void>((resolve) => (releaseGate = resolve));
    },
    release() {
      control.gate = null;
      releaseGate?.();
      releaseGate = null;
    },
  };
}

export function createJobRunner(registry: JobRegistry, db: Db, clock: Clock, logger: Logger): JobRunner {
  return new JobRunner(registry, db, clock, logger);
}

/** Menunggu kondisi asinkron (polling singkat) sampai batas waktu. */
export async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("kondisi tidak terpenuhi sebelum batas waktu");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
