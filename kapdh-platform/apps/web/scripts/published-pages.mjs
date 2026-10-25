// Salinan naskah TAYANG halaman informasi/legal (GET /public/pages/{slug}, F-08) yang ditanam statis di situs publik
// sehingga terbaca tanpa JavaScript: URL kebijakan privasi yang diisi di Google Play dan App Store wajib menampilkan
// naskah, bukan kerangka (docs/runbooks/app-store-submission.md bagian 7). Salinan ada di src/published-pages/, ditarik
// dari API oleh sync-published-pages.mjs, dirender saat build oleh src/lib/published-pages.ts, dan diperiksa pada dist/
// oleh assert-published-pages.mjs. Sumbernya API, bukan docs/legal: berkas di sana dapat memuat revisi yang belum
// terbit. Aturan di sini diuji src/scripts/published-pages.test.ts.
import { JSDOM } from "jsdom";

/** API production (sama dengan src/lib/site.ts PROD_API_URL; diuji). */
export const DEFAULT_PAGES_API = "https://api.kapdh.or.id/api/v1";

/** Kunci berkas salinan (bentuk PublicPage, packages/contracts/openapi/domains/content.yaml) dalam urutan tetap. */
export const PUBLISHED_PAGE_KEYS = [
  "slug",
  "title",
  "version",
  "published_at",
  "legal_document",
  "body_html",
];

const LEGAL_DOCUMENTS = new Set(["privacy", "terms", "community"]);

/**
 * Penanda naskah yang tidak boleh tayang: tanggal berlaku revisi yang belum diisi (docs/legal/README.md, revisi profil
 * berulang) dan kerangka DRAF seed referensi (apps/api/src/cli/golive-gate.ts DRAFT_SHELL_MARKER).
 */
export const UNPUBLISHED_MARKERS = ["[tanggal terbit]", "naskah resmi halaman ini belum disahkan"];

/** @type {DOMParser | null} */
let parser = null;

/** @param {string} html */
function parseHtml(html) {
  if (parser === null) {
    const { window } = new JSDOM("");
    parser = new window.DOMParser();
  }
  return parser.parseFromString(html, "text/html");
}

/**
 * Teks terbaca sebuah elemen: tanpa isi skrip/gaya/noscript dan petunjuk pembaca layar (`.sr-only`, mis. "tautan
 * luar" yang ditambahkan sanitizer), spasi dirapatkan.
 * @param {Element} element
 */
function readableText(element) {
  const copy = /** @type {Element} */ (element.cloneNode(true));
  for (const hidden of Array.from(copy.querySelectorAll("script, style, template, noscript, .sr-only"))) {
    hidden.remove();
  }
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** @param {string} html */
const bodyText = (html) => readableText(parseHtml(html).body);

/**
 * Masalah pada satu salinan naskah tayang (kosong bila sah).
 * @param {unknown} value
 * @param {string} slug slug yang diharapkan (nama berkas)
 * @returns {string[]}
 */
export function publishedPageProblems(value, slug) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["bukan objek PublicPage"];
  const page = /** @type {Record<string, unknown>} */ (value);
  /** @type {string[]} */
  const problems = [];
  if (page.slug !== slug) problems.push(`slug ${JSON.stringify(page.slug)} bukan "${slug}"`);
  if (typeof page.title !== "string" || page.title.trim() === "") problems.push("title kosong");
  if (typeof page.version !== "string" || !/^[1-9][0-9]*$/.test(page.version)) {
    problems.push("version bukan bilangan bulat positif");
  }
  if (typeof page.published_at !== "string" || Number.isNaN(Date.parse(page.published_at))) {
    problems.push("published_at bukan tanggal");
  }
  const legal = page.legal_document;
  if (!(legal === null || (typeof legal === "string" && LEGAL_DOCUMENTS.has(legal)))) {
    problems.push("legal_document tidak dikenal");
  }
  if (typeof page.body_html !== "string" || bodyText(page.body_html) === "") {
    problems.push("body_html tanpa teks");
  } else {
    for (const marker of UNPUBLISHED_MARKERS) {
      if (page.body_html.includes(marker)) problems.push(`body_html memuat penanda belum terbit "${marker}"`);
    }
  }
  const unknown = Object.keys(page).filter((key) => !PUBLISHED_PAGE_KEYS.includes(key));
  if (unknown.length > 0) problems.push(`kunci tidak dikenal: ${unknown.join(", ")}`);
  return problems;
}

/**
 * Hanya kunci PublicPage dari respons API, dalam urutan berkas.
 * @param {Record<string, unknown>} page
 * @returns {Record<string, unknown>}
 */
export function pickPublishedPage(page) {
  return Object.fromEntries(PUBLISHED_PAGE_KEYS.map((key) => [key, page[key]]));
}

/**
 * Isi berkas salinan: indentasi 2 spasi dan baris baru di akhir (sama dengan keluaran Prettier untuk JSON) sehingga
 * format:check lulus dan diff hanya memuat perubahan naskah.
 * @param {Record<string, unknown>} page
 */
export function serializePublishedPage(page) {
  return `${JSON.stringify(pickPublishedPage(page), null, 2)}\n`;
}

/**
 * Pelanggaran halaman informasi/legal pada HTML hasil build: setiap salinan wajib sah dan punya `<slug>/index.html`
 * yang tanpa JavaScript memuat SELURUH teks naskahnya di <article id="info-body">, baris versi dan tanggal terbit di
 * #info-meta, dan tanpa penanda belum terbit; sebaliknya setiap halaman ber-#info-body wajib punya salinan.
 * @param {Map<string, string>} pages Path relatif dist ("kebijakan-privasi/index.html") ke isi HTML.
 * @param {Map<string, unknown>} snapshots Slug ke isi berkas salinan.
 * @returns {string[]}
 */
export function publishedPagesViolations(pages, snapshots) {
  /** @type {string[]} */
  const problems = [];
  for (const [slug, value] of snapshots) {
    const invalid = publishedPageProblems(value, slug);
    if (invalid.length > 0) {
      for (const problem of invalid) problems.push(`src/published-pages/${slug}.json: ${problem}`);
      continue;
    }
    const page = /** @type {{ version: string; body_html: string }} */ (value);
    const path = `${slug}/index.html`;
    const html = pages.get(path);
    if (html === undefined) {
      problems.push(`${path}: tidak ada di dist`);
      continue;
    }
    const doc = parseHtml(html);
    const content = doc.querySelector('#info-body > [data-state="static"]');
    if (content === null) {
      problems.push(`${path}: #info-body tanpa isi naskah statis`);
    } else if (readableText(content) !== bodyText(page.body_html)) {
      problems.push(`${path}: teks #info-body berbeda dari salinan naskah versi ${page.version}`);
    }
    const meta = doc.getElementById("info-meta")?.textContent ?? "";
    if (!meta.includes(`Versi ${page.version} · Diterbitkan `)) {
      problems.push(`${path}: #info-meta tanpa "Versi ${page.version} · Diterbitkan ..."`);
    }
    for (const marker of UNPUBLISHED_MARKERS) {
      if (html.includes(marker)) problems.push(`${path}: memuat penanda belum terbit "${marker}"`);
    }
  }
  for (const [path, html] of pages) {
    const slug = path.replace(/\/index\.html$/, "");
    if (/\sid\s*=\s*["']?info-body["'\s>]/.test(html) && !snapshots.has(slug)) {
      problems.push(`${path}: halaman informasi tanpa salinan naskah src/published-pages/${slug}.json`);
    }
  }
  return [...new Set(problems)];
}
