import { describe, expect, it } from "vitest";
import {
  pickPublishedPage,
  publishedPageProblems,
  publishedPagesViolations,
  serializePublishedPage,
} from "../../scripts/published-pages.mjs";

const PAGE = {
  slug: "kebijakan-privasi",
  title: "Kebijakan Privasi",
  version: "4",
  published_at: "2026-10-21T15:59:41.440Z",
  legal_document: "privacy",
  body_html:
    '<p>Kami menjelaskan data yang dikumpulkan.</p><p><strong>Berlaku sejak 16 Oktober 2026.</strong></p><p>Lihat <a href="https://contoh.id" data-external="true">mitra</a>.</p>',
};

/** Isi #info-body seperti keluaran sanitizer: tautan luar mendapat petunjuk pembaca layar. */
const STATIC_BODY =
  '<p>Kami menjelaskan data yang dikumpulkan.</p><p><strong>Berlaku sejak 16 Oktober 2026.</strong></p><p>Lihat <a href="https://contoh.id/" target="_blank" data-external="true">mitra<span class="sr-only"> (tautan luar, terbuka di tab baru)</span></a>.</p>';

function page({
  meta = "Versi 4 · Diterbitkan 21 Oktober 2026",
  body = `<div class="prose-kapdh" data-state="static" data-version="4">${STATIC_BODY}</div>`,
} = {}): string {
  return `<!doctype html><html><body><h1 id="info-title">Kebijakan Privasi</h1><p id="info-meta">${meta}</p><article id="info-body" data-slug="kebijakan-privasi">${body}</article><script type="module" src="/_astro/a.js"></script></body></html>`;
}

const dist = (html = page(), extra: Record<string, string> = {}) =>
  new Map(Object.entries({ "index.html": "<p>Beranda</p>", "kebijakan-privasi/index.html": html, ...extra }));
const snapshots = (value: unknown = PAGE) => new Map([["kebijakan-privasi", value]]);

describe("salinan naskah tayang: bentuk dan penanda belum terbit", () => {
  it("salinan sah tanpa masalah", () => {
    expect(publishedPageProblems(PAGE, "kebijakan-privasi")).toEqual([]);
    expect(publishedPageProblems({ ...PAGE, legal_document: null }, "kebijakan-privasi")).toEqual([]);
  });

  it("menolak revisi yang belum terbit ([tanggal terbit]) dan kerangka DRAF seed", () => {
    const pending = { ...PAGE, body_html: "<p><strong>Berlaku sejak [tanggal terbit].</strong></p>" };
    expect(publishedPageProblems(pending, "kebijakan-privasi")).toEqual([
      'body_html memuat penanda belum terbit "[tanggal terbit]"',
    ]);
    const draft = {
      ...PAGE,
      body_html: "<p><strong>DRAF</strong>: naskah resmi halaman ini belum disahkan pengurus</p>",
    };
    expect(publishedPageProblems(draft, "kebijakan-privasi")).toEqual([
      'body_html memuat penanda belum terbit "naskah resmi halaman ini belum disahkan"',
    ]);
  });

  it("menolak bentuk yang tidak sesuai PublicPage", () => {
    expect(publishedPageProblems(null, "x")).toEqual(["bukan objek PublicPage"]);
    expect(
      publishedPageProblems(
        {
          ...PAGE,
          slug: "ketentuan",
          title: " ",
          version: "v4",
          published_at: "kemarin",
          legal_document: "cookies",
          body_html: "<p> </p><script>x</script>",
          extra: 1,
        },
        "kebijakan-privasi",
      ),
    ).toEqual([
      'slug "ketentuan" bukan "kebijakan-privasi"',
      "title kosong",
      "version bukan bilangan bulat positif",
      "published_at bukan tanggal",
      "legal_document tidak dikenal",
      "body_html tanpa teks",
      "kunci tidak dikenal: extra",
    ]);
  });

  it("berkas salinan: hanya kunci PublicPage dalam urutan tetap, indentasi 2 spasi, baris baru di akhir", () => {
    // Urutan kunci respons API tidak menentukan isi berkas; kunci di luar PublicPage dibuang.
    const fromApi = {
      ...Object.fromEntries(Object.entries(PAGE).reverse()),
      consent: { policy_version: "privacy:4;terms:4" },
    };
    expect(Object.keys(pickPublishedPage(fromApi))).toEqual([
      "slug",
      "title",
      "version",
      "published_at",
      "legal_document",
      "body_html",
    ]);
    const file = serializePublishedPage(fromApi);
    expect(file).toBe(`${JSON.stringify(PAGE, null, 2)}\n`);
    expect(JSON.parse(file)).toEqual(PAGE);
  });
});

describe("gerbang naskah tayang pada dist/ (assert-published-pages.mjs)", () => {
  it("halaman dengan seluruh naskah statis, versi dan tanggal terbit lolos; petunjuk sr-only diabaikan", () => {
    expect(publishedPagesViolations(dist(), snapshots())).toEqual([]);
  });

  it("menolak kerangka yang hanya memuat isi lewat JavaScript", () => {
    const shell = page({ meta: "", body: "<noscript><p>Aktifkan JavaScript untuk membaca.</p></noscript>" });
    expect(publishedPagesViolations(dist(shell), snapshots())).toEqual([
      "kebijakan-privasi/index.html: #info-body tanpa isi naskah statis",
      'kebijakan-privasi/index.html: #info-meta tanpa "Versi 4 · Diterbitkan ..."',
    ]);
  });

  it("menolak naskah terpotong atau versi lain", () => {
    const partial = page({
      body: `<div data-state="static" data-version="4"><p>Kami menjelaskan data yang dikumpulkan.</p></div>`,
    });
    expect(publishedPagesViolations(dist(partial), snapshots())).toEqual([
      "kebijakan-privasi/index.html: teks #info-body berbeda dari salinan naskah versi 4",
    ]);
    const older = page({ meta: "Versi 3 · Diterbitkan 16 Oktober 2026" });
    expect(publishedPagesViolations(dist(older), snapshots())).toEqual([
      'kebijakan-privasi/index.html: #info-meta tanpa "Versi 4 · Diterbitkan ..."',
    ]);
  });

  it("menolak penanda belum terbit di salinan maupun di halaman", () => {
    const pending = { ...PAGE, body_html: PAGE.body_html.replace("16 Oktober 2026", "[tanggal terbit]") };
    expect(publishedPagesViolations(dist(), snapshots(pending))).toEqual([
      'src/published-pages/kebijakan-privasi.json: body_html memuat penanda belum terbit "[tanggal terbit]"',
    ]);
    const html = page().replace("<h1", "<p>Berlaku sejak [tanggal terbit].</p><h1");
    expect(publishedPagesViolations(dist(html), snapshots())).toContain(
      'kebijakan-privasi/index.html: memuat penanda belum terbit "[tanggal terbit]"',
    );
  });

  it("setiap salinan wajib punya halaman, dan setiap halaman informasi wajib punya salinan", () => {
    const missing = new Map([["index.html", "<p>Beranda</p>"]]);
    expect(publishedPagesViolations(missing, snapshots())).toEqual([
      "kebijakan-privasi/index.html: tidak ada di dist",
    ]);
    const orphan = dist(page(), { "ketentuan/index.html": '<article id="info-body"></article>' });
    expect(publishedPagesViolations(orphan, snapshots())).toEqual([
      "ketentuan/index.html: halaman informasi tanpa salinan naskah src/published-pages/ketentuan.json",
    ]);
  });
});
