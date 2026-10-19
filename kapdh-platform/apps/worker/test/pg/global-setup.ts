/**
 * Jalur PostgreSQL 17 nyata worker (ARCHITECTURE §9.2). Satu cluster embedded-postgres per run:
 *   1. initdb ke direktori sementara unik (prefix sendiri, terpisah dari jalur API sehingga keduanya dapat berjalan
 *      paralel lewat `pnpm test:pg`); pembersihan di teardown dengan toleransi EBUSY/EPERM Windows,
 *   2. database template dimigrasi dengan job migrasi production (`runMigrations`) dan diisi seed referensi production
 *      (app_settings, master, halaman legal; PRD 8.2), sama dengan inisialisasi lingkungan,
 *   3. infra/db/roles.sql diterapkan, lalu role LOGIN kapdh_worker diberi sandi acak sehingga worker tersambung sebagai
 *      role aplikasi sebenarnya (least privilege, PRD 5.1), bukan superuser,
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

export interface WorkerPgLaneConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  template: string;
  /** Sandi LOGIN role kapdh_worker pada cluster uji. */
  workerPassword: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    kapdhWorkerPg: WorkerPgLaneConfig;
  }
}

const DIR_PREFIX = "kapdh-worker-pg-lane-";
const TEMPLATE_DB = "kapdh_worker_template";
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

/** Hapus direktori data; di Windows berkas bisa masih terkunci sesaat setelah proses dihentikan. */
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

/** Sapu sisa direktori run sebelumnya yang gagal dibersihkan (lebih tua dari 1 jam). */
async function sweepStaleDirs(): Promise<void> {
  const root = tmpdir();
  const cutoff = Date.now() - 3600_000;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).mtimeMs < cutoff) await removeDir(dir);
    } catch {
      // Milik run lain yang masih berjalan atau terkunci: abaikan.
    }
  }
}

export default async function setup(project: TestProject) {
  // embedded-postgres memasang async-exit-hook saat dimuat, dengan dua efek samping yang dilepas di teardown setelah
  // cluster dihentikan sendiri (penanganan SIGINT/SIGTERM modul itu tetap aktif selama run):
  // - hook "beforeExit" memanggil process.exit(0) dan menimpa exitCode 1 dari vitest, sehingga uji yang gagal tetap
  //   berakhir sukses;
  // - hook "exit" menjalankan gracefulShutdown TANPA callback (event exit tidak mendukung hook async), sehingga
  //   `done()` di dalamnya melempar "TypeError: done is not a function" pada SETIAP akhir run, gagal maupun
  //   sukses. Kini tidak berbahaya hanya karena vitest keluar lewat process.exit(); pada keluar alami galat itu
  //   mengubah exit code run yang lulus menjadi 1.
  const before = new Set([...process.listeners("beforeExit"), ...process.listeners("exit")]);
  const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
    default: typeof EmbeddedPostgresType;
  };
  const exitHooks = {
    beforeExit: process.listeners("beforeExit").filter((listener) => !before.has(listener)),
    exit: process.listeners("exit").filter((listener) => !before.has(listener)),
  };
  await sweepStaleDirs();
  const databaseDir = join(tmpdir(), `${DIR_PREFIX}${process.pid}-${Date.now()}`);
  const port = await freePort();
  const user = "postgres";
  const password = randomBytes(12).toString("hex");
  const workerPassword = randomBytes(12).toString("hex");
  const logs: string[] = [];
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user,
    password,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
    onLog: (m) => {
      logs.push(String(m));
      if (logs.length > 200) logs.shift();
    },
    onError: (e) => logs.push(String(e)),
  });

  const fail = async (stage: string, e: unknown): Promise<never> => {
    process.stderr.write(`[worker-pg-lane] gagal pada ${stage}:\n${logs.slice(-30).join("")}\n`);
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
    await runMigrations({ url: `${base}/${TEMPLATE_DB}` });
    const template = createDb(`${base}/${TEMPLATE_DB}`, { max: 1 });
    try {
      await seedReference(template.db as unknown as Database, { requestId: "seed-reference-worker-pg-lane" });
      await template.sql.file(ROLES_SQL);
      // Sandi hex acak (tanpa kutip) untuk role LOGIN uji; cluster sekali pakai, tidak pernah dicetak.
      await template.sql.unsafe(`alter role kapdh_worker password '${workerPassword}'`);
    } finally {
      await template.sql.end({ timeout: 5 });
    }
  } catch (e) {
    await admin.end({ timeout: 5 });
    await fail("migrasi template", e);
  }
  await admin.end({ timeout: 5 });

  project.provide("kapdhWorkerPg", {
    host: "127.0.0.1",
    port,
    user,
    password,
    template: TEMPLATE_DB,
    workerPassword,
  });

  return async () => {
    await pg.stop();
    for (const listener of exitHooks.beforeExit) process.off("beforeExit", listener);
    for (const listener of exitHooks.exit) process.off("exit", listener);
    if (!(await removeDir(databaseDir))) {
      process.stderr.write(
        `[worker-pg-lane] direktori ${databaseDir} masih terkunci; disapu pada run berikutnya.\n`,
      );
    }
  };
}
