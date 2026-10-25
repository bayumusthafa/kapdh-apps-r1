// Gerbang build situs publik: build gagal bila halaman informasi/legal di dist/ tidak memuat naskah tayang tanpa
// JavaScript (salinan src/published-pages/<slug>.json) atau memuat penanda belum terbit. Aturan ada di
// published-pages.mjs.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readDistHtml } from "./dist-html.mjs";
import { publishedPagesViolations } from "./published-pages.mjs";

const DIR = fileURLToPath(new URL("../src/published-pages/", import.meta.url));

const pages = await readDistHtml();
if (pages.size === 0) {
  console.error("dist kosong: jalankan astro build lebih dahulu.");
  process.exit(1);
}
/** @type {Map<string, unknown>} */
const snapshots = new Map();
for (const name of (await readdir(DIR)).filter((file) => file.endsWith(".json")).sort()) {
  snapshots.set(name.slice(0, -5), JSON.parse(await readFile(`${DIR}${name}`, "utf8")));
}
const problems = publishedPagesViolations(pages, snapshots);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error("Gerbang naskah tayang gagal: halaman informasi/legal tidak terbaca tanpa JavaScript.");
  process.exit(1);
}
console.log(`Gerbang naskah tayang lulus untuk ${snapshots.size} halaman informasi/legal.`);
