/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config";

// getViteConfig memuat plugin Astro sehingga uji dapat merender halaman .astro lewat Container API (mis. halaman
// informasi/legal tanpa JavaScript di src/lib/published-pages.test.ts).
export default getViteConfig({ test: { include: ["src/**/*.test.ts"] } });
