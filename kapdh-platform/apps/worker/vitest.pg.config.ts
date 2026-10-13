import { defineConfig } from "vitest/config";

/**
 * Jalur PostgreSQL 17 nyata worker (ARCHITECTURE §9.2): `pnpm --filter @kapdh/worker test:pg` (juga ikut
 * `pnpm test:pg` di root). Satu cluster embedded-postgres per run (test/pg/global-setup.ts); setiap berkas memakai
 * database klon template yang sudah dimigrasi dan diberi grant infra/db/roles.sql, dan worker tersambung sebagai role
 * LOGIN `kapdh_worker` (least privilege, PRD 5.1).
 */
export default defineConfig({
  test: {
    include: ["test/pg/**/*.pg.test.ts"],
    environment: "node",
    globalSetup: ["test/pg/global-setup.ts"],
    pool: "forks",
    testTimeout: 90_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
});
