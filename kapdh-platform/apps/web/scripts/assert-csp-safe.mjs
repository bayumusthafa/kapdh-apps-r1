// Gerbang build situs publik (N-07): build gagal bila HTML di dist/ tidak kompatibel dengan CSP nginx
// `script-src 'self'; style-src 'self'` (infra/nginx-web.conf). Aturan ada di csp-check.mjs.
import { cspViolations } from "./csp-check.mjs";
import { readDistHtml } from "./dist-html.mjs";

const pages = await readDistHtml();
if (pages.size === 0) {
  console.error("dist kosong: jalankan astro build lebih dahulu.");
  process.exit(1);
}
let failed = false;
for (const [path, html] of pages) {
  const problems = cspViolations(html);
  if (problems.length > 0) {
    failed = true;
    console.error(`${path}: ${problems.join(", ")}`);
  }
}
if (failed) {
  console.error("Gerbang CSP gagal: hasil build tidak kompatibel dengan CSP infra/nginx-web.conf.");
  process.exit(1);
}
console.log(`Gerbang CSP lulus untuk ${pages.size} halaman.`);
