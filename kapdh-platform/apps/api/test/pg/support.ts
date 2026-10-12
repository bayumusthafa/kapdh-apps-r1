/**
 * Utilitas jalur PostgreSQL nyata: database terpisah per berkas uji (klon template yang sudah dimigrasi) dengan pool
 * postgres-js sungguhan sehingga transaksi benar-benar berjalan bersamaan (bukan diserialkan seperti PGlite).
 */
import { createDb } from "@kapdh/database";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { inject } from "vitest";
import type { PgLaneConfig } from "./global-setup.js";

export type Sql = ReturnType<typeof createDb>["sql"];
export type PgDb = ReturnType<typeof createDb>["db"];

export interface PgTestDatabase {
  name: string;
  url: string;
  db: PgDb;
  sql: Sql;
  /** Menutup pool dan menghapus database uji. */
  drop(): Promise<void>;
}

function laneConfig(): PgLaneConfig {
  const config = inject("kapdhPg");
  if (!config)
    throw new Error("Jalur PG belum disiapkan; jalankan lewat `pnpm --filter @kapdh/api test:pg`.");
  return config;
}

function baseUrl(config: PgLaneConfig): string {
  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}`;
}

/** Membuat database baru dari template yang sudah dimigrasi dan diberi grant (infra/db/roles.sql). */
export function createPgTestDatabase(label: string, poolSize = 12): Promise<PgTestDatabase> {
  return createDatabase(label, poolSize, true);
}

/** Membuat database KOSONG (tanpa migrasi), misalnya untuk menguji job migrasi itu sendiri. */
export function createEmptyPgDatabase(label: string, poolSize = 4): Promise<PgTestDatabase> {
  return createDatabase(label, poolSize, false);
}

async function createDatabase(
  label: string,
  poolSize: number,
  fromTemplate: boolean,
): Promise<PgTestDatabase> {
  const config = laneConfig();
  const name = `kapdh_t_${label.replace(/[^a-z0-9_]/g, "_")}_${randomBytes(4).toString("hex")}`;
  const admin = createDb(`${baseUrl(config)}/postgres`, { max: 1 }).sql;
  try {
    await admin.unsafe(
      fromTemplate ? `create database "${name}" template "${config.template}"` : `create database "${name}"`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = `${baseUrl(config)}/${name}`;
  const { db, sql } = createDb(url, { max: poolSize, applicationName: `kapdh-pg-test-${label}` });
  return {
    name,
    url,
    db,
    sql,
    async drop() {
      await sql.end({ timeout: 5 });
      const cleanup = createDb(`${baseUrl(config)}/postgres`, { max: 1 }).sql;
      try {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}

/** Penghalang sederhana: setiap peserta menunggu sampai semua peserta tiba. */
export function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await all;
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bukti konkurensi nyata: selama `work` berjalan, hitung jumlah maksimum backend database ini yang sedang menunggu
 * lock (row/transaction/advisory). Nilai > 0 berarti transaksi benar-benar saling menunggu, bukan berurutan.
 */
export async function withLockWaitProbe<T>(
  sql: Sql,
  work: Promise<T>,
): Promise<{ result: T; maxWaiting: number }> {
  let done = false;
  let maxWaiting = 0;
  const probe = (async () => {
    while (!done) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      maxWaiting = Math.max(maxWaiting, row?.n ?? 0);
      await sleep(10);
    }
  })();
  try {
    return { result: await work, maxWaiting };
  } finally {
    done = true;
    await probe;
  }
}

/** Galat PostgreSQL dari postgres-js (langsung) atau dibungkus Drizzle (`cause`). */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message?: string;
}

export function pgError(e: unknown): PgErrorInfo {
  const err = e as { code?: string; constraint_name?: string; message?: string; cause?: unknown };
  const inner = (err?.code ? err : (err?.cause as typeof err | undefined)) ?? err;
  return { code: inner?.code, constraint: inner?.constraint_name, message: inner?.message };
}

export const id = () => uuidv7();

// ------------------------------------------------------------------ Fixture minimal (SQL langsung, tanpa API)

export async function insertUser(
  sql: Sql,
  opts: { kind?: "alumni" | "admin"; email?: string; status?: string } = {},
): Promise<string> {
  const userId = id();
  await sql`
    insert into app.users (id, email, password_hash, status, kind)
    values (${userId}, ${opts.email ?? `u-${userId}@contoh.test`}, 'hash-uji', ${opts.status ?? "active"},
            ${opts.kind ?? "alumni"})`;
  return userId;
}

export async function insertAdmin(
  sql: Sql,
  opts: { role?: "super_admin" | "admin"; status?: "invited" | "active" | "disabled" } = {},
): Promise<string> {
  const userId = await insertUser(sql, { kind: "admin" });
  const adminId = id();
  const status = opts.status ?? "active";
  await sql`
    insert into app.admins (id, user_id, display_name, role, status, activated_at, disabled_at)
    values (${adminId}, ${userId}, 'Admin Uji', ${opts.role ?? "admin"}, ${status},
            case when ${status !== "invited"} then now() end, case when ${status === "disabled"} then now() end)`;
  return adminId;
}

export async function insertEvent(
  sql: Sql,
  opts: { seatsTotal?: number; price?: string } = {},
): Promise<string> {
  const eventId = id();
  await sql`
    insert into app.events (id, title, starts_at, ends_at, registration_opens_at, registration_closes_at,
                            price, seats_total, status)
    values (${eventId}, 'Event Uji', now() + interval '10 days', now() + interval '10 days 4 hours',
            now() - interval '1 day', now() + interval '9 days', ${opts.price ?? "50000.00"},
            ${opts.seatsTotal ?? 100}, 'open')`;
  return eventId;
}
