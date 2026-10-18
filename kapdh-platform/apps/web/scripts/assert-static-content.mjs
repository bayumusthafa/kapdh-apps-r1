// Gerbang build situs publik: build gagal bila identitas badan hukum KAPDH (footer setiap halaman, bagian Legalitas
// di /tentang, JSON-LD organisasi) tidak terbaca tanpa JavaScript di HTML dist/. Aturan ada di
// static-content-check.mjs.
import { readDistHtml } from "./dist-html.mjs";
import { staticContentViolations } from "./static-content-check.mjs";

const pages = await readDistHtml();
if (pages.size === 0) {
  console.error("dist kosong: jalankan astro build lebih dahulu.");
  process.exit(1);
}
const problems = staticContentViolations(pages);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error("Gerbang isi statis gagal: identitas badan hukum tidak lengkap di hasil build.");
  process.exit(1);
}
console.log(`Gerbang isi statis lulus untuk ${pages.size} halaman.`);
