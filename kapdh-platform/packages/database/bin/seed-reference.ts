#!/usr/bin/env node
/**
 * CLI seed data referensi yang aman untuk production (PRD 8.2 langkah 4). Lihat seeds/reference.ts. Selalu berjalan
 * saat berkas ini dieksekusi (juga lewat symlink pnpm); keluar 0 bila sukses, 1 bila gagal.
 */
import { runSeedCli } from "../seeds/_cli.js";
import { seedReference } from "../seeds/reference.js";

process.exit(await runSeedCli("seed:reference", (db) => seedReference(db)));
