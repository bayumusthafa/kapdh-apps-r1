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

/**
 * Ruang nama kunci advisory dua-int4 (`pg_advisory_xact_lock(int4, int4)`), terpisah dari ruang kunci bigint tunggal
 * di atas. Dipakai untuk mengunci identitas logis yang tidak memiliki baris untuk dikunci, misalnya kuota unggahan per
 * (pengguna, purpose) atau pasangan blokir. Nilai baru ditambahkan di sini agar tidak bertabrakan.
 */
export const ADVISORY_LOCK_NAMESPACES = {
  /** Kuota unggahan N-10 per (owner_user_id, purpose). */
  fileQuota: 47_110_001,
  /** Pasangan pengguna untuk blokir vs kirim direct/undangan (AC F12-1). */
  blockPair: 47_110_002,
  /** Satu entri terminal per ekspor audit (completed/failed), kunci = id ekspor (kontrak C7 AuditExport, AC F17-4). */
  auditExport: 47_110_003,
} as const;

/**
 * Kunci advisory transaksi pada `(namespace, hashtext(key))`. Tabrakan hash hanya menambah serialisasi, tidak pernah
 * melemahkan invarian. Wajib dipanggil di dalam transaksi.
 */
export async function advisoryXactLockFor(tx: DbOrTx, namespace: number, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${namespace}::int4, hashtext(${key}))`);
}
