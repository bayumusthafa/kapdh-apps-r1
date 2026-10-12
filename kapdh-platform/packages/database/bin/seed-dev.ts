#!/usr/bin/env node
/**
 * CLI seed fixture sintetis untuk dev/staging (seeds/dev.ts). Menolak NODE_ENV=production SEBELUM membuka koneksi
 * (PRD 8.2: fixture tidak pernah dijalankan pada production). Keluar 0 bila sukses, 1 bila gagal/ditolak.
 */
import { runSeedCli, safeError } from "../seeds/_cli.js";
import { assertNotProduction, seedDev } from "../seeds/dev.js";

let code: number;
try {
  assertNotProduction();
  code = await runSeedCli("seed:dev", (db) => seedDev(db));
} catch (e) {
  process.stderr.write(`[seed:dev] ${safeError(e)}\n`);
  code = 1;
}
process.exit(code);
