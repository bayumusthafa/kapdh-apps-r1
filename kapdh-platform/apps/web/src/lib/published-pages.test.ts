import { readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import astroConfig from "../../astro.config.mjs";
import {
  DEFAULT_PAGES_API,
  publishedPagesViolations,
  serializePublishedPage,
  UNPUBLISHED_MARKERS,
} from "../../scripts/published-pages.mjs";
import InfoPage from "../pages/[slug].astro";
import { pageMetaText, type PublicPage } from "../scripts/info-page";
import { publishedPage, renderPublishedBody } from "./published-pages";
import { INFO_PAGES, PROD_API_URL } from "./site";

/**
 * Naskah tayang halaman informasi/legal terbaca tanpa JavaScript (Google Play/App Store: URL kebijakan privasi wajib
 * berisi naskah; docs/runbooks/app-store-submission.md bagian 7): salinan src/published-pages/ dan halaman
 * [slug].astro yang dirender seperti hasil build, lalu dibaca seperti `curl` (tanpa menjalankan skrip).
 */
const SITE = String(astroConfig.site);
const LEGAL_DOCUMENT: Record<string, PublicPage["legal_document"]> = {
  "kebijakan-privasi": "privacy",
  ketentuan: "terms",
  "ketentuan-komunitas": "community",
  bantuan: null,
  tentang: null,
};

async function renderInfoPage(page: (typeof INFO_PAGES)[number]): Promise<string> {
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });
  return container.renderToString(InfoPage, { params: { slug: page.slug }, props: { page } });
}

/** Kalimat pertama paragraf pertama naskah, untuk dicari di HTML mentah seperti `curl ... | grep`. */
function firstSentence(bodyHtml: string): string {
  const paragraph = /<p>([^<]+)/.exec(bodyHtml)?.[1] ?? "";
  return paragraph.split(". ")[0] ?? "";
}

describe("salinan naskah tayang (src/published-pages)", () => {
  it.each(INFO_PAGES.map((page) => [page.slug, page] as const))(
    "%s: sah, sesuai INFO_PAGES, tanpa penanda belum terbit, dan persis keluaran pages:sync",
    (slug, info) => {
      const page = publishedPage(slug);
      expect(page.slug).toBe(slug);
      expect(page.title).toBe(info.title);
      expect(page.legal_document).toBe(LEGAL_DOCUMENT[slug]);
      expect(page.legal_document !== null).toBe(info.legal);
      for (const marker of UNPUBLISHED_MARKERS) expect(page.body_html).not.toContain(marker);
      const file = readFileSync(new URL(`../published-pages/${slug}.json`, import.meta.url), "utf8");
      expect(file.replace(/\r\n/g, "\n")).toBe(serializePublishedPage(page));
    },
  );

  it("pages:sync menarik dari API production yang sama dengan build", () => {
    expect(DEFAULT_PAGES_API).toBe(PROD_API_URL);
  });

  it("isi statis memakai sanitizer runtime: heading turun, jangkar berawalan, tautan luar bertanda, skrip dibuang", () => {
    const page: PublicPage = {
      ...publishedPage("bantuan"),
      body_html:
        '<h1>Judul</h1><p id="a">Isi <a href="#a">jangkar</a> <a href="https://contoh.id">mitra</a> ' +
        '<a href="https://kapdh.or.id/kontak">kontak</a></p><script>alert(1)</script><p onclick="x()">b</p>',
    };
    expect(renderPublishedBody(page, SITE)).toBe(
      '<h2>Judul</h2><p id="isi-a">Isi <a href="#isi-a">jangkar</a> <a href="https://contoh.id/" target="_blank" ' +
        'rel="noopener noreferrer nofollow external" data-external="true">mitra<span class="sr-only"> (tautan luar, ' +
        'terbuka di tab baru)</span></a> <a href="https://kapdh.or.id/kontak">kontak</a></p><p>b</p>',
    );
  });
});

describe("halaman informasi/legal tanpa JavaScript (render [slug].astro)", () => {
  it.each(INFO_PAGES.map((page) => [page.slug, page] as const))(
    "/%s memuat seluruh naskah tayang, versi dan tanggal terbitnya di HTML",
    async (slug, info) => {
      const page = publishedPage(slug);
      const html = await renderInfoPage(info);
      // Aturan gerbang build (scripts/assert-published-pages.mjs): seluruh teks naskah di #info-body statis.
      expect(
        publishedPagesViolations(new Map([[`${slug}/index.html`, html]]), new Map([[slug, page]])),
      ).toEqual([]);
      const sentence = firstSentence(page.body_html);
      expect(sentence.length).toBeGreaterThan(20);
      expect(html.split(sentence).length - 1).toBeGreaterThanOrEqual(1);
      expect(html).toContain(pageMetaText(page));
      expect(html).toContain(`data-state="static" data-version="${page.version}"`);
      expect(html).not.toContain("Aktifkan JavaScript");
    },
  );

  it("/kebijakan-privasi menyebut pengendali data, hak subjek data, dan kontak bantuan tanpa JavaScript", async () => {
    const html = await renderInfoPage(INFO_PAGES[0]);
    expect(INFO_PAGES[0].slug).toBe("kebijakan-privasi");
    for (const sentence of [
      "Pengendali data pribadi untuk layanan yang dijelaskan dalam kebijakan ini",
      "Hak Anda sebagai Subjek Data Pribadi",
      "mailto:bantuan@kapdh.or.id",
    ]) {
      expect(html).toContain(sentence);
    }
  });
});
