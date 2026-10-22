import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sitemapXml } from "../pages/sitemap.xml";
import { ORGANIZATION } from "./organization";
import {
  DEV_API_URL,
  FOOTER_LINKS,
  INFO_PAGES,
  LEGAL_SECTION_HREF,
  LEGAL_SECTION_ID,
  PROD_API_URL,
  infoPage,
  isCurrentPath,
  resolveApiBase,
} from "./site";

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

  it("footer menautkan bagian Legalitas statis di /tentang tepat setelah dokumen legal", () => {
    const labels = FOOTER_LINKS.map((l) => l.label);
    expect(labels.indexOf("Legalitas")).toBe(labels.indexOf("Ketentuan Komunitas") + 1);
    expect(LEGAL_SECTION_ID).toBe("legalitas");
    expect(LEGAL_SECTION_HREF).toBe("/tentang#legalitas");
    expect(FOOTER_LINKS.find((l) => l.label === "Legalitas")?.href).toBe(LEGAL_SECTION_HREF);
    const slugs: readonly string[] = INFO_PAGES.map((p) => p.slug);
    for (const link of FOOTER_LINKS) {
      const path = link.href.split("#")[0]!;
      expect(path.startsWith("/")).toBe(true);
      if (link.href.includes("#")) expect(slugs).toContain(path.slice(1));
    }
  });

  it("cuplikan /tentang memakai nama badan hukum persis", () => {
    expect(infoPage("tentang")?.description).toBe(
      `Tentang ${ORGANIZATION.legalName} (${ORGANIZATION.shortName}) dan KAPDH Apps.`,
    );
  });

  it("sitemap hanya memuat halaman yang boleh diindeks (tanpa /kta, /delete-account dan /app)", () => {
    const xml = sitemapXml(new URL("https://kapdh.or.id"));
    expect(xml).toContain("<loc>https://kapdh.or.id/kebijakan-privasi</loc>");
    expect(xml).toContain("<loc>https://kapdh.or.id/unduh</loc>");
    expect(xml).not.toContain("/kta");
    expect(xml).not.toContain("/delete-account");
    expect(xml).not.toMatch(/\/app(\/|<)/);
  });

  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("robots.txt menutup KTA dan hapus akun, tetapi tidak /app (aturan prefiks, noindex harus terbaca)", () => {
    const disallowed = [...read("../../public/robots.txt").matchAll(/^Disallow: (\S+)$/gm)].map((m) => m[1]);
    // Disallow adalah prefiks: "/app" ikut menutup /apply dan /apps, dan perayap yang dilarang tidak pernah membaca
    // noindex halaman cadangan tautan aplikasi. /app cukup noindex (meta robots di bawah, header X-Robots-Tag di
    // infra/nginx-web.conf yang diuji nginx-config.test.ts dan infra/scripts/smoke-static.sh).
    expect(disallowed).toEqual(["/kta/", "/delete-account"]);
  });

  it("halaman cadangan /app memakai meta robots noindex dari Base.astro", () => {
    expect(read("../pages/app/index.astro")).toMatch(/<Base\b[^>]*\snoindex\b[^>]*>/);
    expect(read("../layouts/Base.astro")).toContain(
      '{noindex ? <meta name="robots" content="noindex, nofollow" /> : <link rel="canonical" href={canonical} />}',
    );
  });
});
