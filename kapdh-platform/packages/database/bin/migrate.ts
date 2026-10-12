#!/usr/bin/env node
/**
 * CLI job migrasi deployment tunggal (PRD 5.5, ARCHITECTURE §5.2). Selalu menjalankan migrasi saat berkas ini dieksekusi,
 * juga lewat symlink pnpm di image production (`node node_modules/@kapdh/database/dist/bin/migrate.js` setelah
 * `pnpm deploy`). Keluar 0 bila sukses, 1 bila gagal; URL koneksi tidak pernah dicetak.
 */
import { runMigrateCli } from "../src/migrate.js";

process.exit(await runMigrateCli());
