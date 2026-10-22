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

/**
 * Membuat database KOSONG (tanpa migrasi), misalnya untuk menguji job migrasi itu sendiri. `createOptions` ditambahkan
 * ke CREATE DATABASE, mis. locale lain dari template0 (cluster uji memakai --locale=C).
 */
export function createEmptyPgDatabase(
  label: string,
  poolSize = 4,
  createOptions = "",
): Promise<PgTestDatabase> {
  return createDatabase(label, poolSize, false, createOptions);
}

async function createDatabase(
  label: string,
  poolSize: number,
  fromTemplate: boolean,
  createOptions = "",
): Promise<PgTestDatabase> {
  const config = laneConfig();
  const name = `kapdh_t_${label.replace(/[^a-z0-9_]/g, "_")}_${randomBytes(4).toString("hex")}`;
  const admin = createDb(`${baseUrl(config)}/postgres`, { max: 1 }).sql;
  try {
    await admin.unsafe(
      fromTemplate
        ? `create database "${name}" template "${config.template}"`
        : `create database "${name}" ${createOptions}`.trimEnd(),
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

/**
 * Koneksi nyata sebagai role LOGIN aplikasi (kapdh_app = API, kapdh_worker = worker) ke database uji, bukan superuser,
 * sehingga grant dan keanggotaan role (infra/db/roles.sql) teruji persis seperti production. Pemanggil wajib end().
 */
export function connectAs(
  database: PgTestDatabase,
  role: "kapdh_app" | "kapdh_worker" | "kapdh_backup" | "kapdh_monitor",
  poolSize = 2,
) {
  const config = laneConfig();
  const url = `postgres://${role}:${config.rolePassword}@${config.host}:${config.port}/${database.name}`;
  return createDb(url, { max: poolSize, applicationName: `kapdh-pg-test-${role}` });
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

/** Batas tunggu bawaan sampai backend lain terlihat menunggu lock. */
export const LOCK_WAIT_TIMEOUT_MS = 10_000;

/**
 * Bukti konkurensi DETERMINISTIK (PRD 9.2, ARCHITECTURE §9.2): transaksi yang lebih dulu memegang kunci menahan
 * commit lewat `hold()` sampai probe pada koneksi TERSENDIRI melihat backend lain database ini menunggu lock
 * (`pg_stat_activity.wait_event_type = 'Lock'`: baris, transaksi, atau advisory), atau sampai batas waktu. Jendela
 * pengamatan tidak lagi bergantung pada `sleep` (probe lama sesekali gagal di mesin yang sibuk), dan koneksi probe
 * tidak bersaing dengan pool uji yang penuh oleh transaksi peserta.
 *
 *   const { result, lockWaitObserved } = await withLockWaitGate(tdb, (hold) =>
 *     Promise.allSettled([0, 1].map(() => sql.begin(async (tx) => { await tx`...`; await hold(); }))),
 *   );
 *   expect(lockWaitObserved).toBe(true);
 *
 * `lockWaitObserved` false berarti tidak ada transaksi yang pernah menunggu dalam batas waktu (transaksi berjalan
 * berurutan; regresi penguncian).
 */
export async function withLockWaitGate<T>(
  database: Pick<PgTestDatabase, "url">,
  work: (hold: () => Promise<void>) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<{ result: T; lockWaitObserved: boolean }> {
  const probe = createDb(database.url, { max: 1, applicationName: "kapdh-pg-test-lock-probe" }).sql;
  let settle!: (seen: boolean) => void;
  const observed = new Promise<boolean>((resolve) => (settle = resolve));
  let stopped = false;
  const watcher = (async () => {
    const deadline = Date.now() + (options.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS);
    try {
      while (!stopped && Date.now() < deadline) {
        const [row] = await probe<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`;
        if ((row?.n ?? 0) > 0) {
          settle(true);
          return;
        }
        await sleep(5);
      }
    } catch {
      // Probe gagal = tidak ada bukti menunggu; hasil false membuat uji gagal dengan jelas.
    }
    settle(false);
  })();
  try {
    const result = await work(async () => {
      await observed;
    });
    return { result, lockWaitObserved: await observed };
  } finally {
    stopped = true;
    settle(false);
    await watcher;
    await probe.end({ timeout: 5 });
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

/** Versi persetujuan registrasi uji (sama dengan test/support/factories.ts TEST_CONSENT_VERSION; F-01). */
export const PG_CONSENT_VERSION = "privacy:1;terms:1";

/** Menerbitkan versi legal 1 di app_settings `legal` sehingga POST /auth/register terbuka (F-01, PRD 8.2). */
export async function publishLegalVersions(sql: Sql): Promise<string> {
  const value = { privacy_version: "1", terms_version: "1", community_version: "1" };
  await sql`
    insert into app.app_settings (key, value, version, updated_at)
    values ('legal', ${JSON.stringify(value)}::jsonb, 1, now())
    on conflict (key) do update set value = excluded.value, version = app.app_settings.version + 1,
                                    updated_at = excluded.updated_at`;
  return PG_CONSENT_VERSION;
}

export async function insertAdmin(
  sql: Sql,
  opts: { role?: "super_admin" | "admin"; status?: "invited" | "active" | "disabled" } = {},
): Promise<string> {
  return (await insertAdminAccount(sql, opts)).adminId;
}

/** Akun users berjenis admin + baris admins; mengembalikan keduanya (penjaga Super Admin memeriksa status akun). */
export async function insertAdminAccount(
  sql: Sql,
  opts: { role?: "super_admin" | "admin"; status?: "invited" | "active" | "disabled" } = {},
): Promise<{ adminId: string; userId: string }> {
  const userId = await insertUser(sql, { kind: "admin" });
  const adminId = id();
  const status = opts.status ?? "active";
  await sql`
    insert into app.admins (id, user_id, display_name, role, status, activated_at, disabled_at)
    values (${adminId}, ${userId}, 'Admin Uji', ${opts.role ?? "admin"}, ${status},
            case when ${status !== "invited"} then now() end, case when ${status === "disabled"} then now() end)`;
  return { adminId, userId };
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
