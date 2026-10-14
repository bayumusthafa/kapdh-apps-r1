import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import mainSource from "./main.tsx?raw";

/**
 * Satu index.html SPA melayani semua rute, termasuk /invite#t=<token> dan /login/enroll. Kontrak admin-auth: origin
 * admin mengirim Referrer-Policy no-referrer dan halaman /invite tidak memuat sumber pihak ketiga (ARCHITECTURE §2
 * butir 3), sehingga pihak ketiga tidak mengetahui ada undangan admin yang dibuka.
 */
describe("index.html web admin (F-16, kontrak admin-auth /invite)", () => {
  const doc = new DOMParser().parseFromString(indexHtml, "text/html");

  it("F-16: tidak ada link, script, gambar atau frame yang memuat origin lain", () => {
    const urls = [...doc.querySelectorAll("link[href], script[src], img[src], iframe[src], source[src]")].map(
      (el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "",
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => /^(https?:)?\/\//i.test(u))).toEqual([]);
    expect(indexHtml).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("F-16: referrer no-referrer agar fragmen token undangan tidak bocor", () => {
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
  });

  it("font Poppins di-bundel dari paket lokal @fontsource, bukan dimuat dari CDN", () => {
    for (const weight of [400, 500, 600, 700])
      expect(mainSource).toContain(`import "@fontsource/poppins/${weight}.css";`);
    expect(mainSource).not.toMatch(/https?:\/\//);
  });
});
