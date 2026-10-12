import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import type { ServerEnv } from "@kapdh/config";
import * as schema from "@kapdh/database";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/bootstrap.js";
import type { Clock } from "../../src/infra/clock.js";
import type { Db } from "../../src/infra/db.js";
import { MemoryMailer } from "../../src/infra/mailer.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/database/migrations");

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

export async function createTestApp() {
  const pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  const db = drizzle(pg, { schema }) as unknown as Db;
  const mailer = new MemoryMailer();
  const clock = new TestClock();
  const app = await createApp({ env: testEnv, db, mailer, clock }, { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, db, mailer, clock, pg };
}
