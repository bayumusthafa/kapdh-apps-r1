import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Static: /kta/{nomor} dilayani shell /kta/index.html lewat aturan nginx (infra/nginx-web.conf).
export default defineConfig({
  site: "https://kapdh.or.id",
  output: "static",
  build: { format: "directory" },
  vite: { plugins: [tailwindcss()] },
});
