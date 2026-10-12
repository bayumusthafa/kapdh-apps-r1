import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Jalur uji bawaan (ARCHITECTURE §9.1): unit + e2e dengan PGlite. Template database dimigrasi sekali per run oleh
 * globalSetup. Jalur PostgreSQL 17 nyata (test/pg) dijalankan terpisah lewat `pnpm test:pg` (vitest.pg.config.ts).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/pg/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    globalSetup: ["test/support/pglite-template.ts"],
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
