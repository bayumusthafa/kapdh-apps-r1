import { defineConfig } from "vitest/config";

/**
 * Uji PGlite paket database. Migrasi journal di PGlite (WASM) dalam beforeAll dapat melewati batas bawaan 10 detik saat
 * `pnpm test` menjalankan semua paket paralel (turbo); batasnya disamakan dengan apps/api (ARCHITECTURE §9.1) agar
 * hasil verifikasi deterministik.
 */
export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
