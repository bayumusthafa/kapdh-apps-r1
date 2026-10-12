import { MIGRATION_LOCK_KEY } from "@kapdh/database";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "./types.js";

/**
 * Kunci advisory PostgreSQL yang dipakai sistem (satu ruang nama int8). Kunci baru ditambahkan di sini agar tidak
 * pernah bertabrakan: migrasi (packages/database MIGRATION_LOCK_KEY), penjaga Super Admin terakhir (trigger 0002), dan
 * bootstrap CLI.
 */
export const ADVISORY_LOCK_KEYS = {
  /** Job migrasi tunggal (packages/database runMigrations). */
  migration: MIGRATION_LOCK_KEY,
  /** Trigger admins_last_super_admin_chk (migrasi 0002). */
  lastSuperAdmin: 4711000518,
  /** Bootstrap Super Admin pertama (PRD 8.2 langkah 3). */
  bootstrapSuperAdmin: 4711000519,
} as const;

/**
 * `pg_advisory_xact_lock`: menunggu kunci dan melepasnya otomatis saat transaksi selesai (commit/rollback). Untuk
 * invarian lintas baris yang tidak bisa dijaga satu baris terkunci (mis. "belum ada X" lalu buat X). Wajib dipanggil di
 * dalam transaksi (ARCHITECTURE §2 butir 11).
 */
export async function advisoryXactLock(tx: DbOrTx, key: number | bigint): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BigInt(key).toString()}::bigint)`);
}
