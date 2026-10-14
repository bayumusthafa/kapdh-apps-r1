import type { APIRoute } from "astro";
import { INFO_PAGES } from "../lib/site";

/** Peta situs statis untuk halaman publik yang boleh diindeks (KTA dan hapus akun memakai noindex). */
export const PUBLIC_PATHS = ["/", "/unduh", "/kontak", ...INFO_PAGES.map((p) => `/${p.slug}`)];

export function sitemapXml(site: URL): string {
  const urls = PUBLIC_PATHS.map((path) => `  <url><loc>${new URL(path, site).href}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const GET: APIRoute = ({ site }) =>
  new Response(sitemapXml(site ?? new URL("https://kapdh.or.id")), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
