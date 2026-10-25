import { JSDOM } from "jsdom";
import { publishedPageProblems } from "../../scripts/published-pages.mjs";
import bantuan from "../published-pages/bantuan.json";
import kebijakanPrivasi from "../published-pages/kebijakan-privasi.json";
import ketentuanKomunitas from "../published-pages/ketentuan-komunitas.json";
import ketentuan from "../published-pages/ketentuan.json";
import tentang from "../published-pages/tentang.json";
import type { PublicPage } from "../scripts/info-page";
import { sanitizeRichHtml } from "../scripts/sanitize";
import type { InfoPageSlug } from "./site";

/**
 * Salinan naskah TAYANG halaman informasi/legal (src/published-pages/, ditarik dari GET /public/pages/{slug} dengan
 * `pnpm --filter @kapdh/web pages:sync`) yang dirender statis saat build agar terbaca tanpa JavaScript. Setiap slug
 * INFO_PAGES wajib punya salinan (dicek tipe). Hanya untuk frontmatter halaman Astro (jsdom; tidak pernah ke peramban).
 */
const PUBLISHED: Record<InfoPageSlug, unknown> = {
  "kebijakan-privasi": kebijakanPrivasi,
  ketentuan,
  "ketentuan-komunitas": ketentuanKomunitas,
  bantuan,
  tentang,
};

/** Salinan tayang yang sah untuk `slug`; build gagal bila tidak sah atau memuat penanda belum terbit. */
export function publishedPage(slug: InfoPageSlug): PublicPage {
  const page = PUBLISHED[slug];
  const problems = publishedPageProblems(page, slug);
  if (problems.length > 0) throw new Error(`src/published-pages/${slug}.json: ${problems.join("; ")}`);
  return page as PublicPage;
}

let dom: JSDOM | null = null;

/**
 * HTML isi naskah lewat sanitizer yang sama dengan render runtime (scripts/sanitize.ts), sehingga isi statis dan isi
 * yang dimuat ulang saat JavaScript aktif identik: daftar izin tag, jangkar berawalan isi-, tautan luar bertanda.
 */
export function renderPublishedBody(page: PublicPage, siteOrigin: string): string {
  const doc = (dom ??= new JSDOM("")).window.document;
  const host = doc.createElement("div");
  host.append(sanitizeRichHtml(page.body_html, doc, siteOrigin));
  return host.innerHTML;
}
