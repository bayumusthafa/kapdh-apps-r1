import { defineConfig } from "vitest/config";

/**
 * Jalur uji bawaan worker (`pnpm test`): unit + integrasi dengan PGlite (migrasi production) dan registri palsu.
 * Skenario konkurensi nyata (leader penjadwal dua worker, SKIP LOCKED lintas koneksi) ada di jalur PostgreSQL 17
 * `pnpm --filter @kapdh/worker test:pg` (vitest.pg.config.ts).
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/pg/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    // PGlite (WASM) memigrasi skema penuh per berkas uji.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
