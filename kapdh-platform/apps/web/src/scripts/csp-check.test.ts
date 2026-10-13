import { describe, expect, it } from "vitest";
import { cspViolations } from "../../scripts/csp-check.mjs";

describe("N-07: gerbang CSP hasil build (script-src/style-src 'self')", () => {
  it("HTML yang hanya memakai berkas dari origin sendiri lolos", () => {
    const html =
      '<html><head><link rel="stylesheet" href="/_astro/Base.css"><script type="module" src="/_astro/a.js"></script></head>' +
      '<body><p>Bayar online = mudah</p><a href="/kontak">Kontak</a></body></html>';
    expect(cspViolations(html)).toEqual([]);
  });

  it("menolak skrip inline, blok style, atribut style/on*, javascript: dan aset pihak ketiga", () => {
    expect(cspViolations("<script>alert(1)</script>")).toContain("skrip inline");
    expect(cspViolations('<script type="module">import "/x.js"</script>')).toContain("skrip inline");
    expect(cspViolations("<style>p{}</style>")).toContain("blok <style> inline");
    expect(cspViolations('<div style="color:red">x</div>')).toContain("atribut style inline");
    expect(cspViolations('<img src="/a.png" onerror="x()">')).toContain("atribut event handler inline (on*)");
    expect(cspViolations('<a href="javascript:void(0)">x</a>')).toContain("URL javascript:");
    expect(cspViolations('<script src="https://cdn.example/x.js"></script>')[0]).toMatch(/origin lain/);
    expect(cspViolations('<link rel="stylesheet" href="https://fonts.googleapis.com/css2">')[0]).toMatch(
      /origin lain/,
    );
  });

  it("blok data JSON tidak dieksekusi sehingga diizinkan", () => {
    expect(cspViolations('<script type="application/ld+json">{"a":1}</script>')).toEqual([]);
  });
});
