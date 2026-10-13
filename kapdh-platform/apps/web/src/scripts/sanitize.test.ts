// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { safeImageSrc, safeLink, sanitizeRichHtml } from "./sanitize";

const SITE = "https://kapdh.or.id";

function render(html: string): HTMLDivElement {
  const host = document.createElement("div");
  host.append(sanitizeRichHtml(html, document, SITE));
  return host;
}

describe("F-08: sanitasi HTML halaman legal (defense in depth)", () => {
  it("mempertahankan struktur teks yang aman", () => {
    const out = render(
      '<h2>Data</h2><p>Kami <strong>tidak</strong> meminta <em>NIK</em>.</p><ul><li>satu</li></ul><ol start="3"><li>tiga</li></ol><blockquote>kutipan</blockquote>',
    );
    expect(out.innerHTML).toBe(
      '<h2>Data</h2><p>Kami <strong>tidak</strong> meminta <em>NIK</em>.</p><ul><li>satu</li></ul><ol start="3"><li>tiga</li></ol><blockquote>kutipan</blockquote>',
    );
  });

  it("membuang script, style, iframe, form, svg beserta isinya", () => {
    const out = render(
      '<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe><form><input value="x"></form><svg><script>alert(2)</script></svg><noscript>n</noscript><p>b</p>',
    );
    expect(out.innerHTML).toBe("<p>a</p><p>b</p>");
  });

  it("tidak pernah menyalin atribut event, style, class atau data-*; id hanya dengan awalan isi-", () => {
    const out = render(
      '<p onclick="alert(1)" style="color:red" class="x" id="y" data-foo="1">teks</p><img src="https://cdn.kapdh.or.id/a.png" onerror="alert(1)" alt="a" id="gambar">',
    );
    expect(out.innerHTML).not.toMatch(/onclick|onerror|style=|class=|data-foo/);
    expect(out.querySelector("p")!.textContent).toBe("teks");
    expect(out.querySelector("p")!.id).toBe("isi-y");
    // Gambar bukan tujuan jangkar: id tidak disalin.
    expect(out.querySelector("img")!.hasAttribute("id")).toBe(false);
    expect(out.querySelector("#y")).toBeNull();
  });

  it("F-08: daftar isi dalam halaman (href=#x) menunjuk id berawalan isi- dan tidak bentrok dengan id halaman", () => {
    const out = render(
      [
        '<ol><li><a href="#pengumpulan">Pengumpulan data</a></li><li><a href="#konten">Konten</a></li>',
        '<li><a href="#tidak-ada">Bagian yang tidak ada</a></li><li><a href="#ganda">Ganda</a></li></ol>',
        '<h2 id="pengumpulan">Pengumpulan data</h2><p>isi</p>',
        '<h3 id="konten">Konten</h3>',
        '<h3 id="ganda">Pertama</h3><h3 id="ganda">Kedua</h3>',
        '<p id="1-angka">id diawali angka</p><p id="ada spasi">spasi</p><p id="x&quot;onmouseover=&quot;y">kutip</p>',
        '<a href="javascript:alert(1)" id="bahaya">teks</a>',
      ].join(""),
    );
    const toc = Array.from(out.querySelectorAll("ol a"));
    expect(toc.map((a) => a.getAttribute("href"))).toEqual(["#isi-pengumpulan", "#isi-konten", "#isi-ganda"]);
    // Setiap tautan jangkar yang tersisa punya tujuan di isi tersanitasi.
    for (const a of toc) expect(out.querySelector(a.getAttribute("href")!)).not.toBeNull();
    expect(out.querySelector("#isi-pengumpulan")!.tagName).toBe("H2");
    // id halaman (mis. #konten untuk "Lewati ke konten") tidak pernah tertimpa isi pengurus.
    expect(out.querySelector("#konten")).toBeNull();
    // id ganda hanya pada kemunculan pertama.
    expect(out.querySelectorAll("[id='isi-ganda']")).toHaveLength(1);
    expect(out.querySelector("#isi-ganda")!.textContent).toBe("Pertama");
    // Tautan tanpa tujuan dibuka menjadi teks biasa (tidak ada tautan mati).
    expect(out.querySelector("ol li:nth-child(3)")!.innerHTML).toBe("Bagian yang tidak ada");
    // id yang tidak sah tidak disalin; elemen yang dibuka (tautan berbahaya) tidak membawa id.
    const ids = Array.from(out.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids).toEqual(["isi-pengumpulan", "isi-konten", "isi-ganda"]);
    expect(out.innerHTML).not.toContain("onmouseover");
  });

  it("menolak tautan javascript:, data:, vbscript: (isi tetap tampil sebagai teks)", () => {
    for (const href of [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<b>x",
      "vbscript:x",
    ]) {
      const out = render(`<p><a href="${href}">klik</a></p>`);
      expect(out.querySelector("a")).toBeNull();
      expect(out.textContent).toBe("klik");
    }
  });

  it("PRD 3.8: tautan luar diberi tanda, tab baru, rel aman, dan teks pembaca layar", () => {
    const out = render('<p><a href="https://contoh.id/x" data-external="false" target="_self">Mitra</a></p>');
    const a = out.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://contoh.id/x");
    expect(a.getAttribute("data-external")).toBe("true");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow external");
    expect(a.textContent).toBe("Mitra (tautan luar, terbuka di tab baru)");
    expect(a.querySelector(".sr-only")).not.toBeNull();
  });

  it("tautan internal, relatif, mailto, tel dan jangkar tidak diberi tanda luar", () => {
    const out = render(
      '<a href="/kontak">k</a><a href="https://kapdh.or.id/bantuan">b</a><a href="mailto:bantuan@kapdh.or.id">m</a><a href="tel:+62811">t</a><a href="#bagian-2">j</a><h2 id="bagian-2">Bagian 2</h2>',
    );
    const anchors = Array.from(out.querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://kapdh.or.id/kontak",
      "https://kapdh.or.id/bantuan",
      "mailto:bantuan@kapdh.or.id",
      "tel:+62811",
      "#isi-bagian-2",
    ]);
    expect(anchors.every((a) => !a.hasAttribute("target"))).toBe(true);
  });

  it("h1 diturunkan menjadi h2 dan pembungkus tidak dikenal dibuka", () => {
    const out = render("<h1>Judul</h1><div><section><span>isi</span></section></div><font>f</font>");
    expect(out.innerHTML).toBe("<h2>Judul</h2>isif");
  });

  it("gambar hanya https atau situs sendiri, dengan lazy dan tanpa Referer", () => {
    const out = render(
      '<img src="https://api.kapdh.or.id/a.png" alt="Logo" width="120" height="x"><img src="http://evil.example/a.png" alt="b"><img src="data:image/png;base64,AAAA" alt="c">',
    );
    const imgs = out.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toBe("https://api.kapdh.or.id/a.png");
    expect(imgs[0]!.getAttribute("width")).toBe("120");
    expect(imgs[0]!.hasAttribute("height")).toBe(false);
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
    expect(imgs[0]!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("tabel dibungkus agar dapat digulir sendiri di layar ponsel", () => {
    const out = render(
      '<table><tr><th scope="col" colspan="2" style="x">A</th><td rowspan="999">B</td></tr></table>',
    );
    const frame = out.firstElementChild!;
    expect(frame.className).toBe("prose-table");
    const th = frame.querySelector("th")!;
    expect(th.getAttribute("scope")).toBe("col");
    expect(th.getAttribute("colspan")).toBe("2");
    expect(frame.querySelector("td")!.hasAttribute("rowspan")).toBe(false);
  });

  it("komentar dibuang dan teks di-escape (bukan ditafsirkan sebagai HTML)", () => {
    const out = render("<p>&lt;script&gt;alert(1)&lt;/script&gt;<!-- rahasia --></p>");
    expect(out.querySelector("script")).toBeNull();
    expect(out.textContent).toBe("<script>alert(1)</script>");
    expect(out.innerHTML).not.toContain("rahasia");
  });

  it("struktur sangat dalam tidak menghentikan render", () => {
    const deep = "<b>".repeat(200) + "isi" + "</b>".repeat(200);
    expect(render(deep).textContent).toBe("isi");
  });
});

describe("safeLink / safeImageSrc", () => {
  it("klasifikasi tautan", () => {
    expect(safeLink("https://kapdh.or.id/a", SITE)).toEqual({
      href: "https://kapdh.or.id/a",
      external: false,
    });
    expect(safeLink("http://contoh.id", SITE)?.external).toBe(true);
    expect(safeLink("https://user:pw@contoh.id", SITE)).toBeNull();
    expect(safeLink("#<x>", SITE)).toBeNull();
    expect(safeLink("", SITE)).toBeNull();
    expect(safeImageSrc("/logo-kapdh.png", SITE)).toBe("https://kapdh.or.id/logo-kapdh.png");
    expect(safeImageSrc("javascript:alert(1)", SITE)).toBeNull();
  });
});
