import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Jalur PostgreSQL 17 nyata (ARCHITECTURE §9.2): `pnpm --filter @kapdh/api test:pg`. Tidak termasuk `pnpm test`.
 * Satu cluster embedded-postgres per run (test/pg/global-setup.ts); setiap berkas memakai database kloning template.
 */
export default defineConfig({
  test: {
    include: ["test/pg/**/*.pg.test.ts"],
    environment: "node",
    globalSetup: ["test/pg/global-setup.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
