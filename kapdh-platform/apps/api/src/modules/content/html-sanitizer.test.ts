import { describe, expect, it } from "vitest";
import { createContentSanitizer, EXTERNAL_LINK_CLASS, safeHttpsUrl } from "./html-sanitizer.js";

const API = "https://api.kapdh.test";
const sanitize = createContentSanitizer(API);
const FILE_ID = "0192f1e2-3c4d-7a5b-8c9d-0e1f2a3b4c5d";
const IMG = `${API}/api/v1/files/public/${FILE_ID}`;

describe("PRD 3.8: sanitasi rich text berita/halaman (server, daftar putih)", () => {
  it("PRD 3.8: script, style, iframe, atribut on* dan style dibuang; teks dasar dipertahankan", () => {
    const out = sanitize(
      `<h1 onclick="x()">Judul</h1><script>alert(1)</script><style>p{}</style>` +
        `<p style="color:red" onmouseover="steal()">Halo <b>tebal</b> <i>miring</i> <del>coret</del></p>` +
        `<iframe src="https://evil.test">isi</iframe><div><span>teks span</span></div><table><tr><td>sel</td></tr></table>`,
    );
    expect(out.html).toBe(
      "<h2>Judul</h2><p>Halo <strong>tebal</strong> <em>miring</em> <s>coret</s></p>teks spansel",
    );
    expect(out.hasContent).toBe(true);
  });

  it("PRD 3.8: tautan luar https diberi target, rel noopener noreferrer nofollow, data-external dan kelas penanda", () => {
    const out = sanitize(
      `<p><a href="https://contoh.test/a?b=1" target="_self" rel="opener" class="x" data-external="false" onclick="y()">luar</a></p>`,
    );
    expect(out.html).toBe(
      `<p><a href="https://contoh.test/a?b=1" target="_blank" rel="noopener noreferrer nofollow" data-external="true" class="${EXTERNAL_LINK_CLASS}">luar</a></p>`,
    );
  });

  it("PRD 3.8: javascript:, data:, http:, relatif dan URL berkredensial kehilangan tautannya; mailto dipertahankan", () => {
    const out = sanitize(
      `<p><a href="javascript:alert(1)">a</a> <a href=" java&#x0A;script:alert(1)">b</a> ` +
        `<a href="data:text/html,x">c</a> <a href="http://contoh.test">d</a> <a href="/news/x">e</a> ` +
        `<a href="https://user:pass@contoh.test">f</a> <a href="mailto:bantuan@kapdh.or.id">g</a></p>`,
    );
    expect(out.html).toBe(`<p>a b c d e f <a href="mailto:bantuan@kapdh.or.id">g</a></p>`);
  });

  it("PRD 3.8: img hanya dari berkas publik KAPDH dengan teks alternatif; id berkas dikembalikan", () => {
    const out = sanitize(
      `<p><img src="${IMG}" alt="Foto kegiatan" onerror="x()" width="10"></p>` +
        `<img src="https://cdn.lain.test/a.jpg" alt="luar"><img src="${IMG}"><img src="data:image/png;base64,AAA" alt="d">`,
    );
    expect(out.html).toBe(`<p><img src="${IMG}" alt="Foto kegiatan" /></p>`);
    expect(out.imageFileIds).toEqual([FILE_ID]);
  });

  it("PRD 3.8: tag yang dibuang tidak merusak penutup tag sesudahnya (struktur tetap seimbang)", () => {
    const out = sanitize(
      `<ul><li><img src="https://luar.test/a.png" alt="x"></li><li><a href="javascript:x">j</a></li><li>c</li></ul>` +
        `<p><a href="ftp://x">a</a><strong>b</strong><a href="https://ok.test">c</a></p>`,
    );
    expect(out.html).toBe(
      `<ul><li></li><li>j</li><li>c</li></ul><p>a<strong>b</strong><a href="https://ok.test/" target="_blank" ` +
        `rel="noopener noreferrer nofollow" data-external="true" class="${EXTERNAL_LINK_CLASS}">c</a></p>`,
    );
  });

  it("PRD 3.8: hasil sanitasi idempoten (aman disanitasi ulang saat terbit)", () => {
    const once = sanitize(
      `<h2>A</h2><p><a href="https://contoh.test">x</a> <a href="mailto:a@b.test">m</a><img src="${IMG}" alt="g"></p><ul><li><p>i</p></li></ul><hr><blockquote>q</blockquote>`,
    );
    expect(sanitize(once.html).html).toBe(once.html);
  });

  it("PRD 3.8: konten yang kosong setelah sanitasi ditandai tidak berisi", () => {
    expect(sanitize("<script>x</script><p>&nbsp; </p>").hasContent).toBe(false);
    expect(sanitize(`<p><img src="${IMG}" alt="g"></p>`).hasContent).toBe(true);
  });

  it("PRD 3.8: safeHttpsUrl hanya menerima https tanpa kredensial", () => {
    expect(safeHttpsUrl("https://kapdh.or.id/info")).toBe("https://kapdh.or.id/info");
    expect(safeHttpsUrl("http://kapdh.or.id")).toBeNull();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("https://a:b@kapdh.or.id")).toBeNull();
    expect(safeHttpsUrl("bukan url")).toBeNull();
  });
});
