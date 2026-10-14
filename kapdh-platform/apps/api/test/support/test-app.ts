import "reflect-metadata";
import type { PGlite } from "@electric-sql/pglite";
import type { ApiEnv } from "@kapdh/config";
import { schema } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import type { DynamicModule, Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { DestinationStream } from "pino";
import { inject } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { commitAwareDb } from "../../src/core/db/tx.js";
import type { Db } from "../../src/core/db/types.js";
import { JobRunner } from "../../src/core/jobs/job-runner.js";
import { MemoryRateLimitStore } from "../../src/core/rate-limit/store.js";
import { SettingsService } from "../../src/core/settings/settings.service.js";
import { FakePush, TestClock } from "./fakes.js";
import { dumpMigratedTemplate, pgliteFromTemplate, readTemplateFile } from "./pglite-template.js";

export { FakePush, TestClock } from "./fakes.js";

/** Env uji lengkap (ApiEnv). Variabel baru di packages/config wajib ditambahkan di sini dan di .env.example. */
export const testEnv: ApiEnv = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: "postgres://unused",
  REDIS_URL: undefined,
  LOG_LEVEL: "error",
  PUBLIC_WEB_URL: "http://web.test",
  API_PUBLIC_URL: "http://api.test",
  ADMIN_ORIGIN: "http://admin.test",
  SMTP_URL: undefined,
  MAIL_FROM: "test@kapdh.test",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_ROOT: "/tmp",
  S3_ENDPOINT: undefined,
  S3_REGION: undefined,
  S3_BUCKET: undefined,
  S3_ACCESS_KEY_ID: undefined,
  S3_SECRET_ACCESS_KEY: undefined,
  S3_FORCE_PATH_STYLE: false,
  STORAGE_FALLBACK_LOCAL_ROOT: undefined,
  FILE_URL_SECRET: "f".repeat(40),
  FCM_PROJECT_ID: undefined,
  FCM_SERVICE_ACCOUNT_JSON: undefined,
  SENTRY_DSN: undefined,
  SENTRY_ENVIRONMENT: undefined,
  SENTRY_RELEASE: undefined,
  TRUST_PROXY_HOPS: 0,
  HSTS_ENABLED: false,
  JWT_ACCESS_SECRET: "t".repeat(40),
  JWT_ISSUER: "http://test",
  QR_SIGNING_KEYS: "k1:" + "q".repeat(32),
  OTP_HMAC_SECRET: "h".repeat(40),
  TOTP_ENC_KEY: "ab".repeat(32),
  BCRYPT_COST: 4,
};

let cachedTemplate: Promise<Blob> | undefined;

/**
 * Template database yang sudah dimigrasi + seed referensi: dari globalSetup (sekali per run) bila tersedia, selain
 * itu dibuat sekali per berkas uji. Migrasi selalu memakai migrator Drizzle dan urutan `_journal.json`, persis seperti
 * job migrasi production (ARCHITECTURE §5.2).
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

export interface TestAppOptions {
  /** Menimpa sebagian env uji (mis. TRUST_PROXY_HOPS, HSTS_ENABLED). */
  env?: Partial<ApiEnv>;
  clock?: TestClock;
  /** Storage pengganti (mis. MemoryDriver yang dibuat gagal untuk menguji readiness). */
  storage?: MemoryDriver;
  /** Modul tambahan (controller penguji). Rute di luar kontrak hanya untuk aplikasi uji khusus. */
  extraModules?: (Type | DynamicModule)[];
  /** Tujuan log JSON; tanpa nilai log dimatikan. */
  logDestination?: DestinationStream;
}

export interface TestApp {
  app: NestFastifyApplication;
  /** DB yang SAMA dengan token DB aplikasi (commit-aware: `t.db.transaction` dapat memanggil kernel core). */
  db: Db;
  mailer: MemoryMailer;
  clock: TestClock;
  push: FakePush;
  storage: MemoryDriver;
  /** Eksekutor job dan dispatcher outbox (ARCHITECTURE §4.8): `await jobs.dispatchOutbox()`. */
  jobs: JobRunner;
  settings: SettingsService;
  rateLimits: MemoryRateLimitStore;
  pg: PGlite;
  env: ApiEnv;
}

/** Store rate limit aplikasi uji yang masih hidup; dikosongkan sebelum setiap tes (test/support/setup.ts). */
const liveRateLimitStores = new Set<MemoryRateLimitStore>();

export function resetRateLimits(): void {
  for (const store of liveRateLimitStores) store.clear();
}

/**
 * Aplikasi API lengkap di atas PGlite (ARCHITECTURE §9.1): TestClock, MemoryMailer, FakePush, MemoryDriver, rate limit
 * memori yang direset per tes. `app.close()` juga menutup PGlite.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { pg, db: rawDb } = await createTestDatabase();
  const db = commitAwareDb(rawDb);
  const env: ApiEnv = { ...testEnv, ...options.env };
  const mailer = new MemoryMailer();
  const clock = options.clock ?? new TestClock();
  const push = new FakePush();
  const storage = options.storage ?? new MemoryDriver();
  const rateLimits = new MemoryRateLimitStore();
  const app = await createApp(
    { env, db, mailer, clock, push, storage, redis: null },
    {
      logger: options.logDestination !== undefined,
      logDestination: options.logDestination,
      rateLimitStore: rateLimits,
      extraModules: options.extraModules,
    },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  liveRateLimitStores.add(rateLimits);
  // Tutup PGlite bersama aplikasi agar tidak ada instance WASM yang tertinggal per berkas uji.
  const closeApp = app.close.bind(app);
  app.close = async () => {
    liveRateLimitStores.delete(rateLimits);
    await closeApp();
    if (!pg.closed) await pg.close();
  };
  return {
    app,
    db,
    mailer,
    clock,
    push,
    storage,
    jobs: app.get(JobRunner),
    settings: app.get(SettingsService),
    rateLimits,
    pg,
    env,
  };
}
