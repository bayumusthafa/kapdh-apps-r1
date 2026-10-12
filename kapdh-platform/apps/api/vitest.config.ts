import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Jalur uji bawaan (ARCHITECTURE §9.1): unit + e2e dengan PGlite. Template database (migrasi + seed referensi)
 * dibuat sekali per run oleh globalSetup; setupFiles mereset rate limit sebelum setiap tes. Jalur PostgreSQL 17 nyata
 * (test/pg) dijalankan terpisah lewat `pnpm test:pg` (vitest.pg.config.ts).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/pg/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    globalSetup: ["test/support/pglite-template.ts"],
    setupFiles: ["test/support/setup.ts"],
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
