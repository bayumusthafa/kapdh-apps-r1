import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Situs publik statis kapdh.or.id (D12, PRD 4.6). /kta/{nomor} dilayani shell /kta/index.html lewat aturan nginx
// (infra/nginx-web.conf). Skrip dan gaya TIDAK PERNAH di-inline (assetsInlineLimit 0, inlineStylesheets never)
// sehingga CSP `script-src 'self'; style-src 'self'` di nginx berlaku tanpa 'unsafe-inline' (N-07);
// scripts/assert-csp-safe.mjs memeriksa hasil build.
export default defineConfig({
  site: "https://kapdh.or.id",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory", inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    build: { assetsInlineLimit: 0 },
  },
});
