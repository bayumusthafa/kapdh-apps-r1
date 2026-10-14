import { describe, expect, it } from "vitest";
import { compileRoutes, matchRoute, type MockModule } from "./http";

/**
 * Integritas router server tiruan (integrasi Fase C). `index.ts` memuat setiap berkas area secara alfabetis dan
 * menjawab dengan rute PERTAMA yang cocok, sehingga dua area yang menulis rute sama (mis. kategori event yang dahulu
 * ditiru area content dan events) diam-diam saling menutupi: uji area yang kalah tetap hijau saat dijalankan sendiri,
 * tetapi dev:mock dan uji alur memakai tiruan yang salah. Uji ini memastikan setiap rute benar-benar dapat dicapai.
 */
const modules = import.meta.glob<MockModule>(["./*.ts", "!./index.ts", "!./http.ts", "!./*.test.ts"], {
  eager: true,
});

/** Semua rute dengan nama berkas asalnya, dalam urutan yang sama dengan index.ts. */
const entries = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .flatMap(([file, m]) => (m.routes ?? []).map((route) => ({ file, route })));
const compiled = compileRoutes(entries.map((e) => e.route));

/** Path contoh untuk template: setiap parameter diganti nilai yang tidak mungkin sama dengan segmen literal. */
const samplePath = (template: string) => template.replace(/\{\w+\}/g, "__param__");

describe("router server tiruan admin", () => {
  it("memuat rute dari beberapa area", () => {
    expect(new Set(entries.map((e) => e.file)).size).toBeGreaterThan(1);
  });

  it("setiap rute (metode + template path) hanya didaftarkan satu kali di seluruh area", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const { file, route } of entries) {
      const key = `${route.method} ${route.path.replace(/\{\w+\}/g, "{}")}`;
      const first = seen.get(key);
      if (first) duplicates.push(`${key} (${first} dan ${file})`);
      else seen.set(key, file);
    }
    expect(duplicates).toEqual([]);
  });

  it("tidak ada rute yang tertutup rute lain yang dimuat lebih dahulu", () => {
    const shadowed: string[] = [];
    compiled.forEach((route, index) => {
      const match = matchRoute(compiled, route.method, samplePath(route.path));
      if (match && match.route !== route) {
        const winner = compiled.indexOf(match.route);
        shadowed.push(
          `${route.method} ${route.path} (${entries[index]!.file}) tertutup ${match.route.path} (${entries[winner]!.file})`,
        );
      }
    });
    expect(shadowed).toEqual([]);
  });
});
