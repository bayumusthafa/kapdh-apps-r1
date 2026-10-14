/**
 * Jalur uji PostgreSQL 17 nyata (ARCHITECTURE §9.2, PRD 9.2). Satu cluster embedded-postgres per run:
 *   1. initdb ke direktori sementara unik di os.tmpdir() (persistent: true agar embedded-postgres tidak menghapusnya
 *      sendiri; pembersihan dilakukan di teardown dengan toleransi EBUSY/EPERM Windows),
 *   2. database template `kapdh_template` dimigrasi dengan job migrasi production (`runMigrations`, advisory lock),
 *      lalu diisi seed referensi production (`seedReference`: app_settings termasuk `fees` versi 1, master usulan
 *      nonaktif, halaman legal draf; PRD 8.2 langkah 4), sama dengan jalur PGlite dan jalur PG worker. Tanpa seed,
 *      instruksi iuran ditolak karena nominal `fees` belum tersimpan (fail closed, temuan D4-02),
 *   3. infra/db/roles.sql diterapkan DUA KALI (role + grant, sekaligus bukti idempoten), lalu role LOGIN kapdh_app dan
 *      kapdh_worker diberi sandi acak sehingga uji dapat tersambung sebagai role aplikasi yang sebenarnya (bukan
 *      superuser) maupun memakai SET ROLE,
 *   4. setiap berkas uji membuat database sendiri dari template (test/pg/support.ts).
 */
import type EmbeddedPostgresType from "embedded-postgres";
import { createDb, type Database, runMigrations } from "@kapdh/database";
import { seedReference } from "@kapdh/database/seeds/reference";
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export interface PgLaneConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  template: string;
  /** Sandi LOGIN role aplikasi kapdh_app/kapdh_worker pada cluster uji (bukan superuser), untuk koneksi nyata. */
  rolePassword: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    kapdhPg: PgLaneConfig;
  }
}

const DIR_PREFIX = "kapdh-pg-lane-";
export const TEMPLATE_DB = "kapdh_template";
/** Waktu seed referensi template (sama dengan template PGlite; sebelum TestClock bawaan 2026-10-13T02:00Z). */
export const PG_TEMPLATE_SEEDED_AT = new Date("2026-10-01T00:00:00Z");
const ROLES_SQL = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../infra/db/roles.sql");

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("port")),
      );
    });
  });
}

/** Hapus direktori data; di Windows berkas bisa masih terkunci sesaat setelah proses dihentikan paksa. */
async function removeDir(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

/** Sapu sisa direktori dari run sebelumnya yang gagal dibersihkan (lebih tua dari 1 jam). */
async function sweepStaleDirs(): Promise<void> {
  const root = tmpdir();
  const cutoff = Date.now() - 3600_000;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).mtimeMs < cutoff) await removeDir(dir);
    } catch {
      // Direktori milik run lain yang masih berjalan atau terkunci: abaikan.
    }
  }
}

export default async function setup(project: TestProject) {
  // embedded-postgres memasang async-exit-hook saat dimuat; hook "beforeExit"-nya memanggil process.exit(0) dan menimpa
  // exitCode 1 dari vitest, sehingga uji yang gagal tetap berakhir sukses. Listener yang ditambahkan modul itu dicatat
  // di sini dan dilepas di teardown setelah cluster dihentikan sendiri.
  const listenersBefore = new Set(process.listeners("beforeExit"));
  const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
    default: typeof EmbeddedPostgresType;
  };
  const exitHookListeners = process
    .listeners("beforeExit")
    .filter((listener) => !listenersBefore.has(listener));
  await sweepStaleDirs();
  const databaseDir = join(tmpdir(), `${DIR_PREFIX}${process.pid}-${Date.now()}`);
  const port = await freePort();
  const user = "postgres";
  const password = randomBytes(12).toString("hex");
  const rolePassword = randomBytes(12).toString("hex");
  const logs: string[] = [];
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user,
    password,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    // Cluster sekali pakai: durability tidak diperlukan, kecepatan diutamakan.
    postgresFlags: ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
    onLog: (m) => {
      logs.push(String(m));
      if (logs.length > 200) logs.shift();
    },
    onError: (e) => logs.push(String(e)),
  });

  const fail = async (stage: string, e: unknown): Promise<never> => {
    process.stderr.write(`[pg-lane] gagal pada ${stage}:\n${logs.slice(-30).join("")}\n`);
    await pg.stop().catch(() => {});
    await removeDir(databaseDir).catch(() => false);
    throw e;
  };

  await pg.initialise().catch((e) => fail("initdb", e));
  await pg.start().catch((e) => fail("start", e));

  const base = `postgres://${user}:${password}@127.0.0.1:${port}`;
  const admin = createDb(`${base}/postgres`, { max: 1 }).sql;
  try {
    await admin.unsafe(`create database ${TEMPLATE_DB}`);
    // Migrasi template memakai job migrasi production (journal Drizzle dalam advisory lock, PRD 5.5).
    await runMigrations({ url: `${base}/${TEMPLATE_DB}` });
    const { db: templateDb, sql: template } = createDb(`${base}/${TEMPLATE_DB}`, { max: 1 });
    try {
      await seedReference(templateDb as unknown as Database, {
        now: PG_TEMPLATE_SEEDED_AT,
        requestId: "seed-reference-api-pg-lane",
      });
      await template.file(ROLES_SQL);
      await template.file(ROLES_SQL);
      // Sandi hex acak (tanpa kutip) untuk role LOGIN uji; cluster sekali pakai, tidak pernah dicetak.
      for (const role of ["kapdh_app", "kapdh_worker", "kapdh_backup", "kapdh_monitor"]) {
        await template.unsafe(`alter role ${role} password '${rolePassword}'`);
      }
    } finally {
      await template.end({ timeout: 5 });
    }
  } catch (e) {
    await admin.end({ timeout: 5 });
    await fail("migrasi template", e);
  }
  await admin.end({ timeout: 5 });

  project.provide("kapdhPg", {
    host: "127.0.0.1",
    port,
    user,
    password,
    template: TEMPLATE_DB,
    rolePassword,
  });

  return async () => {
    await pg.stop();
    for (const listener of exitHookListeners) process.off("beforeExit", listener);
    if (!(await removeDir(databaseDir))) {
      process.stderr.write(
        `[pg-lane] direktori ${databaseDir} masih terkunci; akan disapu pada run berikutnya.\n`,
      );
    }
  };
}
