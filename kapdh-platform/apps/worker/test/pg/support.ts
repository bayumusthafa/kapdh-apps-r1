/**
 * Utilitas jalur PostgreSQL nyata worker: database terpisah per berkas uji (klon template yang sudah dimigrasi, diisi
 * seed referensi, dan diberi grant roles.sql) dengan koneksi sungguhan sebagai role LOGIN kapdh_worker.
 */
import type { Db } from "@kapdh/api/worker";
import { createDb } from "@kapdh/database";
import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import type { WorkerPgLaneConfig } from "./global-setup.js";

export type Sql = ReturnType<typeof createDb>["sql"];

export interface WorkerPgDatabase {
  name: string;
  /** URL role kapdh_worker (least privilege) ke database uji: DATABASE_URL worker. */
  workerUrl: string;
  /** Pool superuser untuk menyiapkan/memeriksa keadaan (pg_stat_activity, pg_terminate_backend). */
  admin: Sql;
  drop(): Promise<void>;
}

function laneConfig(): WorkerPgLaneConfig {
  const config = inject("kapdhWorkerPg");
  if (!config)
    throw new Error("Jalur PG worker belum disiapkan; jalankan `pnpm --filter @kapdh/worker test:pg`.");
  return config;
}

export async function createWorkerPgDatabase(label: string): Promise<WorkerPgDatabase> {
  const config = laneConfig();
  const superBase = `postgres://${config.user}:${config.password}@${config.host}:${config.port}`;
  const name = `kapdh_w_${label.replace(/[^a-z0-9_]/g, "_")}_${randomBytes(4).toString("hex")}`;
  const bootstrap = createDb(`${superBase}/postgres`, { max: 1 }).sql;
  try {
    await bootstrap.unsafe(`create database "${name}" template "${config.template}"`);
  } finally {
    await bootstrap.end({ timeout: 5 });
  }
  const admin = createDb(`${superBase}/${name}`, { max: 2, applicationName: "kapdh-pg-test-admin" }).sql;
  return {
    name,
    workerUrl: `postgres://kapdh_worker:${config.workerPassword}@${config.host}:${config.port}/${name}`,
    admin,
    async drop() {
      await admin.end({ timeout: 5 });
      const cleanup = createDb(`${superBase}/postgres`, { max: 1 }).sql;
      try {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}

/** Pool kerja sebagai kapdh_worker (seperti createWorkerDeps). Pemanggil wajib menutup `sql`. */
export function connectWorker(
  database: WorkerPgDatabase,
  applicationName: string,
  max = 6,
): { db: Db; sql: Sql } {
  const { db, sql } = createDb(database.workerUrl, { max, applicationName });
  return { db: db as unknown as Db, sql };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
