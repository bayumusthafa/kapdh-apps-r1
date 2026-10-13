// Gerbang build situs publik (N-07): build gagal bila HTML di dist/ tidak kompatibel dengan CSP nginx
// `script-src 'self'; style-src 'self'` (infra/nginx-web.conf). Aturan ada di csp-check.mjs.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cspViolations } from "./csp-check.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

/** @param {string} dir @returns {Promise<string[]>} */
async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return htmlFiles(path);
      return Promise.resolve(e.name.endsWith(".html") ? [path] : []);
    }),
  );
  return nested.flat();
}

const files = await htmlFiles(DIST);
if (files.length === 0) {
  console.error("dist kosong: jalankan astro build lebih dahulu.");
  process.exit(1);
}
let failed = false;
for (const file of files) {
  const problems = cspViolations(await readFile(file, "utf8"));
  if (problems.length > 0) {
    failed = true;
    console.error(`${relative(DIST, file)}: ${problems.join(", ")}`);
  }
}
if (failed) {
  console.error("Gerbang CSP gagal: hasil build tidak kompatibel dengan CSP infra/nginx-web.conf.");
  process.exit(1);
}
console.log(`Gerbang CSP lulus untuk ${files.length} halaman.`);
