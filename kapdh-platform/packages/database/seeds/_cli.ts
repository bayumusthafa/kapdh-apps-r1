/** Utilitas bersama skrip seed: koneksi, pesan galat aman, dan deteksi eksekusi langsung. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDb, type Database } from "../src/client.js";

export function invokedDirectly(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && moduleUrl === pathToFileURL(resolve(entry!)).href;
}

/** Pesan galat tanpa parameter query (Drizzle menaruh parameter di message; N-14). */
export function safeError(e: unknown): string {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const inner = err?.cause ?? err;
  return [inner?.code, inner?.message?.split("\n")[0]].filter(Boolean).join(" ");
}

/** Menjalankan seed terhadap DATABASE_URL lalu menutup pool; keluar dengan kode bukan nol bila gagal. */
export function runSeedCli(label: string, run: (db: Database) => Promise<unknown>): void {
  const url = process.env.DATABASE_URL;
  const main = async () => {
    if (!url || !/^postgres(ql)?:\/\//.test(url))
      throw new Error("DATABASE_URL wajib diisi dengan URL postgres://.");
    const { db, sql } = createDb(url, { max: 1, applicationName: `kapdh-${label}` });
    try {
      const summary = await run(db);
      process.stdout.write(`[${label}] selesai: ${JSON.stringify(summary)}\n`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
  main().then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`[${label}] gagal: ${safeError(e)}\n`);
      process.exit(1);
    },
  );
}
