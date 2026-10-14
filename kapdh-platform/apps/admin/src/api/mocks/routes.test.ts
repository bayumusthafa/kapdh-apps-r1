import { describe, expect, it } from "vitest";
import { matchMockRoute, mockRouteTable } from "./index";

/**
 * Integritas router server tiruan (integrasi Fase C). `index.ts` memuat setiap berkas area secara alfabetis dan
 * menjawab dengan rute PERTAMA yang cocok, sehingga dua area yang menulis rute sama (mis. kategori event yang dahulu
 * ditiru area content dan events) diam-diam saling menutupi: uji area yang kalah tetap hijau saat dijalankan sendiri,
 * tetapi dev:mock dan uji alur memakai tiruan yang salah. Uji ini memastikan setiap rute benar-benar dapat dicapai.
 * Tabel rute dan pencocokannya diambil langsung dari index.ts (yang dipakai mockFetch), bukan disalin, sehingga
 * perubahan pola glob, pengecualian atau urutan di router ikut diperiksa.
 */

/** Path contoh untuk template: setiap parameter diganti nilai yang tidak mungkin sama dengan segmen literal. */
const samplePath = (template: string) => template.replace(/\{\w+\}/g, "__param__");

describe("router server tiruan admin", () => {
  it("memuat rute dari beberapa area", () => {
    expect(new Set(mockRouteTable.map((e) => e.file)).size).toBeGreaterThan(1);
  });

  it("tidak memuat berkas uji atau perangkat router sebagai area", () => {
    const files = new Set(mockRouteTable.map((e) => e.file));
    for (const file of files) expect(file).not.toMatch(/(\.test\.ts|\/index\.ts|\/http\.ts)$/);
  });

  it("setiap rute (metode + template path) hanya didaftarkan satu kali di seluruh area", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const { file, route } of mockRouteTable) {
      const key = `${route.method} ${route.path.replace(/\{\w+\}/g, "{}")}`;
      const first = seen.get(key);
      if (first) duplicates.push(`${key} (${first} dan ${file})`);
      else seen.set(key, file);
    }
    expect(duplicates).toEqual([]);
  });

  it("tidak ada rute yang tertutup rute lain yang dimuat lebih dahulu", () => {
    const shadowed: string[] = [];
    for (const { file, route } of mockRouteTable) {
      const match = matchMockRoute(route.method, samplePath(route.path));
      if (match?.route === route) continue;
      const winner = mockRouteTable.find((e) => e.route === match?.route);
      shadowed.push(
        `${route.method} ${route.path} (${file}) ${
          winner ? `tertutup ${winner.route.path} (${winner.file})` : "tidak dapat dicapai"
        }`,
      );
    }
    expect(shadowed).toEqual([]);
  });
});
