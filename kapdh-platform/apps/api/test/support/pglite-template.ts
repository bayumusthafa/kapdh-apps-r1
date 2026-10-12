/**
 * Template PGlite untuk jalur uji bawaan (ARCHITECTURE §9.1). Migrasi diterapkan dengan migrator Drizzle yang sama
 * dengan job production (urutan `_journal.json`, seluruh migrasi tertunda dalam satu transaksi), sekali per
 * `pnpm test`, lalu data directory-nya di-dump. Setiap createTestApp() memuat dump tersebut sehingga tidak perlu
 * mengulang migrasi per berkas uji.
 *
 * Catatan fidelitas: PGlite adalah PostgreSQL 18 satu koneksi; skenario konkurensi dan kompatibilitas PG 17
 * dibuktikan di jalur `pnpm test:pg` (embedded PostgreSQL 17, test/pg).
 */
import { PGlite } from "@electric-sql/pglite";
import { type Database, MIGRATIONS_FOLDER, schema } from "@kapdh/database";
import { seedReference } from "@kapdh/database/seeds/reference";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Path dump data directory PGlite yang sudah dimigrasi; null bila globalSetup tidak dipakai. */
    pgliteTemplate: string | null;
  }
}

/** PGlite baru yang dimigrasi dari nol dengan migrator Drizzle (perilaku sama dengan `pnpm migrate`). */
export async function migrateFreshPglite(): Promise<PGlite> {
  const pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_FOLDER });
  return pg;
}

/** Waktu seed referensi pada template (sebelum TestClock default 2026-10-13T02:00Z). */
export const TEMPLATE_SEEDED_AT = new Date("2026-10-01T00:00:00Z");

/**
 * Dump data directory PGlite yang sudah dimigrasi DAN diisi seed referensi production (app_settings, master usulan
 * nonaktif, kerangka halaman legal draf), sama seperti inisialisasi lingkungan PRD 8.2 langkah 2-4.
 */
export async function dumpMigratedTemplate(): Promise<Blob> {
  const pg = await migrateFreshPglite();
  await seedReference(drizzle(pg, { schema }) as unknown as Database, {
    now: TEMPLATE_SEEDED_AT,
    requestId: "seed-reference-template-uji",
  });
  try {
    return await pg.dumpDataDir("none");
  } finally {
    await pg.close();
  }
}

/** Membuka instance PGlite baru dari dump template. */
export function pgliteFromTemplate(template: Blob): Promise<PGlite> {
  return PGlite.create({ loadDataDir: template });
}

/** Membaca dump template dari berkas yang disiapkan globalSetup. */
export function readTemplateFile(path: string): Blob {
  return new Blob([readFileSync(path)]);
}

/** globalSetup Vitest: migrasi sekali per run, dump ke berkas sementara, dibersihkan saat teardown. */
export default async function setup(project: TestProject) {
  const path = join(tmpdir(), `kapdh-pglite-template-${process.pid}-${Date.now()}.tar`);
  const dump = await dumpMigratedTemplate();
  writeFileSync(path, Buffer.from(await dump.arrayBuffer()));
  project.provide("pgliteTemplate", path);
  return () => {
    rmSync(path, { force: true });
  };
}
