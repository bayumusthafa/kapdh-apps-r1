/**
 * Utilitas bersama CLI seed (bin/seed-reference.ts, bin/seed-dev.ts): koneksi, pesan galat aman, kode keluar.
 * Modul seed tidak pernah berjalan otomatis saat diimpor; titik masuk CLI selalu berada di bin/ sehingga perilakunya
 * sama saat dipanggil lewat symlink pnpm (image production, PRD 5.5).
 */
import { createDb, type Database } from "../src/client.js";

/** Pesan galat tanpa parameter query (Drizzle menaruh parameter di message; N-14). */
export function safeError(e: unknown): string {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const inner = err?.cause ?? err;
  return [inner?.code, inner?.message?.split("\n")[0]].filter(Boolean).join(" ");
}

/**
 * Menjalankan seed terhadap DATABASE_URL lalu menutup pool. Mengembalikan kode keluar: 0 sukses, 1 gagal (termasuk
 * DATABASE_URL kosong/salah dan penolakan production pada seed dev). URL koneksi tidak pernah dicetak.
 */
export async function runSeedCli(
  label: string,
  run: (db: Database) => Promise<unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const url = env.DATABASE_URL;
    if (!url || !/^postgres(ql)?:\/\//.test(url))
      throw new Error("DATABASE_URL wajib diisi dengan URL postgres://.");
    const { db, sql } = createDb(url, { max: 1, applicationName: `kapdh-${label}` });
    try {
      const summary = await run(db);
      process.stdout.write(`[${label}] selesai: ${JSON.stringify(summary)}\n`);
    } finally {
      await sql.end({ timeout: 5 });
    }
    return 0;
  } catch (e) {
    process.stderr.write(`[${label}] gagal: ${safeError(e)}\n`);
    return 1;
  }
}
