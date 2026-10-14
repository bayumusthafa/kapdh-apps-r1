import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Uji klien terhadap API nyata berjalan di jalur terpisah (vitest.live.config.ts, `test:live`).
    exclude: [...configDefaults.exclude, "src/live/**"],
    css: false,
    // Uji alur penuh (router + server tiruan + timer palsu) lebih lambat saat suite berjalan paralel.
    testTimeout: 20_000,
  },
});
