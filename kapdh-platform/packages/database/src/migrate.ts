/**
 * Job migrasi deployment tunggal (PRD 5.5, ARCHITECTURE §5.2): menjalankan migrator Drizzle (journal
 * `migrations/meta/_journal.json`, seluruh migrasi tertunda dalam SATU transaksi) di dalam `pg_advisory_lock`
 * sehingga dua job yang berjalan bersamaan tidak pernah menerapkan migrasi yang sama. Tidak dijalankan saat startup
 * replica API/worker.
 *
 *   DATABASE_URL=postgres://kapdh_migrator:...@db:5432/kapdh pnpm --filter @kapdh/database migrate
 *   DATABASE_URL=... node node_modules/@kapdh/database/dist/bin/migrate.js   # image production (pnpm deploy)
 *
 * CLI ada di bin/migrate.ts (selalu dijalankan, tanpa deteksi "dipanggil langsung" yang gagal lewat symlink).
 * Keluar dengan kode bukan nol bila gagal. URL koneksi (berisi sandi) tidak pernah dicetak.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/** Folder migrasi SQL terversi; berlaku dari sumber (src/) maupun hasil build (dist/src/). */
function findMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../migrations"), resolve(here, "../../migrations")];
  return candidates.find((dir) => existsSync(join(dir, "meta", "_journal.json"))) ?? candidates[1]!;
}

export const MIGRATIONS_FOLDER = findMigrationsFolder();

/** Kunci advisory lock tetap untuk job migrasi KAPDH (bigint). Jangan dipakai untuk keperluan lain. */
export const MIGRATION_LOCK_KEY = 4_711_000_517;

export interface MigrateOptions {
  url: string;
  migrationsFolder?: string;
  /** Batas menunggu lock milik job lain (ms). Default 10 menit. */
  lockWaitMs?: number;
  log?: (message: string) => void;
}

/** Menjalankan migrasi tertunda. Melempar galat bila gagal; lock selalu dilepas. */
export async function runMigrations(options: MigrateOptions): Promise<{ applied: number }> {
  const log = options.log ?? (() => {});
  const lockWaitMs = options.lockWaitMs ?? 10 * 60_000;
  // Satu koneksi saja: advisory lock tingkat sesi harus berada di koneksi yang sama dengan migrasi.
  const sql = postgres(options.url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "kapdh-migrate" },
  });
  try {
    const pid = await backendPid(sql);
    await sql.unsafe(`set lock_timeout = ${Math.max(1, Math.floor(lockWaitMs))}`);
    log("Menunggu lock migrasi...");
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    await sql.unsafe("set lock_timeout = 0");
    try {
      const before = await countApplied(sql);
      log(`Lock diperoleh. Migrasi tercatat sebelum: ${before}.`);
      await migrate(drizzle(sql), { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
      const after = await countApplied(sql);
      if ((await backendPid(sql)) !== pid) {
        // Koneksi tersambung ulang di tengah proses sehingga lock sesi mungkin hilang; anggap gagal agar diperiksa.
        throw new Error("Koneksi migrasi terputus selama proses; periksa status migrasi sebelum mengulang.");
      }
      log(`Migrasi selesai. Diterapkan: ${after - before}. Total tercatat: ${after}.`);
      return { applied: after - before };
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function backendPid(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  if (!row) throw new Error("pg_backend_pid() tidak mengembalikan baris.");
  return row.pid;
}

async function countApplied(sql: postgres.Sql): Promise<number> {
  const [exists] = await sql<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (!exists?.present) return 0;
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return row?.n ?? 0;
}

/** Pesan galat aman: kode SQLSTATE dan pesan PostgreSQL tanpa parameter query (N-14). */
function safeError(e: unknown): string {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const inner = err?.cause ?? err;
  return [inner?.code, inner?.message?.split("\n")[0]].filter(Boolean).join(" ");
}

/**
 * Titik masuk CLI job migrasi (dipanggil bin/migrate.ts). Mengembalikan kode keluar: 0 sukses, 1 gagal. Galat dicetak
 * tanpa parameter query maupun URL koneksi (N-14). Modul ini sendiri tidak pernah berjalan otomatis saat diimpor, jadi
 * tidak bergantung pada cara Node memanggilnya (symlink pnpm di image production, PRD 5.5).
 */
export async function runMigrateCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const url = env.DATABASE_URL;
    if (!url || !/^postgres(ql)?:\/\//.test(url)) {
      throw new Error("DATABASE_URL wajib diisi dengan URL postgres:// milik role kapdh_migrator.");
    }
    await runMigrations({ url, log: (m) => process.stdout.write(`[migrate] ${m}\n`) });
    return 0;
  } catch (e) {
    process.stderr.write(`[migrate] Gagal: ${safeError(e)}\n`);
    return 1;
  }
}
