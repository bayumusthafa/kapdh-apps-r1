import "reflect-metadata";
import type { PGlite } from "@electric-sql/pglite";
import type { ServerEnv } from "@kapdh/config";
import { schema } from "@kapdh/database";
import { drizzle } from "drizzle-orm/pglite";
import { inject } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import type { Clock } from "../../src/infra/clock.js";
import type { Db } from "../../src/infra/db.js";
import { MemoryMailer } from "../../src/infra/mailer.js";
import { dumpMigratedTemplate, pgliteFromTemplate, readTemplateFile } from "./pglite-template.js";

export const testEnv: ServerEnv = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: "postgres://unused",
  REDIS_URL: "redis://unused",
  JWT_ACCESS_SECRET: "t".repeat(40),
  JWT_ISSUER: "http://test",
  QR_SIGNING_KEYS: "k1:" + "q".repeat(32),
  OTP_HMAC_SECRET: "h".repeat(40),
  TOTP_ENC_KEY: "ab".repeat(32),
  BCRYPT_COST: 4,
  PUBLIC_WEB_URL: "http://web.test",
  ADMIN_ORIGIN: "http://admin.test",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_ROOT: "/tmp",
  MAIL_FROM: "test@kapdh.test",
  LOG_LEVEL: "error",
};

/** Jam yang bisa dimajukan untuk menguji kedaluwarsa dan idle timeout. */
export class TestClock implements Clock {
  constructor(private current = new Date("2026-10-13T02:00:00Z")) {}
  now() {
    return new Date(this.current);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

let cachedTemplate: Promise<Blob> | undefined;

/**
 * Template database yang sudah dimigrasi: dari globalSetup (sekali per run) bila tersedia, selain itu dimigrasi
 * sekali per berkas uji lalu di-dump. Migrasi selalu memakai migrator Drizzle dan urutan `_journal.json`, persis
 * seperti job migrasi production (ARCHITECTURE §5.2).
 */
function migratedTemplate(): Promise<Blob> {
  if (!cachedTemplate) {
    const path = inject("pgliteTemplate");
    cachedTemplate = path ? Promise.resolve(readTemplateFile(path)) : dumpMigratedTemplate();
  }
  return cachedTemplate;
}

/** PGlite baru yang sudah dimigrasi, terpisah per pemanggilan. */
export async function createTestDatabase(): Promise<{ pg: PGlite; db: Db }> {
  const pg = await pgliteFromTemplate(await migratedTemplate());
  // Instance PGlite memiliki API kueri yang sama; dipasang pada token DB bertipe postgres-js.
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { pg, db };
}

export async function createTestApp() {
  const { pg, db } = await createTestDatabase();
  const mailer = new MemoryMailer();
  const clock = new TestClock();
  const app = await createApp({ env: testEnv, db, mailer, clock }, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  // Tutup PGlite bersama aplikasi agar tidak ada instance WASM yang tertinggal per berkas uji.
  const closeApp = app.close.bind(app);
  app.close = async () => {
    await closeApp();
    if (!pg.closed) await pg.close();
  };
  return { app, db, mailer, clock, pg };
}
