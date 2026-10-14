import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Jalur uji klien terhadap API nyata (temuan audit D2-14, PRD 7.3/9.3): `pnpm test:live` dari root monorepo (turbo
 * membangun apps/api lebih dulu), atau `pnpm build` lalu `pnpm --filter @kapdh/admin test:live`. Tidak termasuk
 * `pnpm test` (butuh build API dan lebih lambat).
 *
 * - live/global-setup.mjs menjalankan API hasil merge (apps/api/dist) di port TCP lokal dengan PGlite + seed dev.
 * - Mode `live` (`--mode live` di skrip test:live; src/live/setup.ts menolak mode lain): klien API memakai fetch
 *   sungguhan, bukan server tiruan src/api/mocks yang hanya untuk mode `test`/`mock`. src/live/setup.ts lalu
 *   mengarahkan origin halaman jsdom ke API itu.
 * - Satu API dan satu database untuk seluruh jalur, sehingga berkas dijalankan berurutan.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/live/**/*.live.test.tsx"],
    environment: "jsdom",
    globalSetup: ["./live/global-setup.mjs"],
    setupFiles: ["./src/live/setup.ts"],
    css: false,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
