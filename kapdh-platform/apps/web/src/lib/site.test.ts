import { describe, expect, it } from "vitest";
import { sitemapXml } from "../pages/sitemap.xml";
import { DEV_API_URL, INFO_PAGES, PROD_API_URL, infoPage, isCurrentPath, resolveApiBase } from "./site";

describe("resolveApiBase (PUBLIC_API_URL)", () => {
  it("default localhost saat dev dan api.kapdh.or.id saat build (D12)", () => {
    expect(resolveApiBase({ DEV: true })).toBe(DEV_API_URL);
    expect(DEV_API_URL).toMatch(/^http:\/\/localhost:\d+\/api\/v1$/);
    expect(resolveApiBase({ DEV: false })).toBe(PROD_API_URL);
    expect(resolveApiBase({ PUBLIC_API_URL: "  ", DEV: false })).toBe(PROD_API_URL);
  });

  it("memakai nilai env dan membuang garis miring akhir", () => {
    expect(resolveApiBase({ PUBLIC_API_URL: "https://api.staging.kapdh.or.id/api/v1/", DEV: false })).toBe(
      "https://api.staging.kapdh.or.id/api/v1",
    );
    expect(resolveApiBase({ PUBLIC_API_URL: "http://127.0.0.1:3000/api/v1", DEV: false })).toBe(
      "http://127.0.0.1:3000/api/v1",
    );
  });

  it("N-07: build produksi menolak API http non-lokal, skema lain, dan URL rusak", () => {
    expect(() => resolveApiBase({ PUBLIC_API_URL: "http://api.kapdh.or.id/api/v1", DEV: false })).toThrow(
      /https/,
    );
    expect(() => resolveApiBase({ PUBLIC_API_URL: "ftp://x/api", DEV: false })).toThrow();
    expect(() => resolveApiBase({ PUBLIC_API_URL: "bukan url", DEV: false })).toThrow();
    expect(() =>
      resolveApiBase({ PUBLIC_API_URL: "https://api.kapdh.or.id/api/v1?x=1", DEV: false }),
    ).toThrow();
    expect(resolveApiBase({ PUBLIC_API_URL: "http://192.168.1.5:3000/api/v1", DEV: true })).toBe(
      "http://192.168.1.5:3000/api/v1",
    );
  });
});

describe("halaman informasi (F-08, PRD 3.8)", () => {
  it("memuat kelima slug baku content.yaml", () => {
    expect(INFO_PAGES.map((p) => p.slug)).toEqual([
      "kebijakan-privasi",
      "ketentuan",
      "ketentuan-komunitas",
      "bantuan",
      "tentang",
    ]);
    expect(infoPage("ketentuan")?.legal).toBe(true);
    expect(infoPage("bantuan")?.legal).toBe(false);
    expect(infoPage("tidak-ada")).toBeNull();
  });

  it("menandai navigasi aktif tanpa peduli garis miring akhir", () => {
    expect(isCurrentPath("/kontak", "/kontak/")).toBe(true);
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath("/", "/kontak")).toBe(false);
  });

  it("sitemap hanya memuat halaman yang boleh diindeks (tanpa /kta dan /delete-account)", () => {
    const xml = sitemapXml(new URL("https://kapdh.or.id"));
    expect(xml).toContain("<loc>https://kapdh.or.id/kebijakan-privasi</loc>");
    expect(xml).toContain("<loc>https://kapdh.or.id/unduh</loc>");
    expect(xml).not.toContain("/kta");
    expect(xml).not.toContain("/delete-account");
  });
});
