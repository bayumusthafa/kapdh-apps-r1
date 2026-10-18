/**
 * Konstanta situs publik kapdh.or.id (D12, PRD 4.6) yang dipakai saat build. Murni dan teruji
 * (site.test.ts); tidak boleh mengakses DOM.
 */

/** API lokal saat `astro dev` (apps/api mendengarkan di :3000, prefix /api/v1). */
export const DEV_API_URL = "http://localhost:3000/api/v1";
/** API produksi (D12: api.kapdh.or.id). */
export const PROD_API_URL = "https://api.kapdh.or.id/api/v1";

/**
 * Email resmi KAPDH (PRD 8.3): kontak resmi pada identitas badan hukum (lib/organization) sekaligus kanal bantuan
 * awal sebelum /public/config terbaca (scripts/config.ts DEFAULT_SUPPORT_EMAIL).
 */
export const OFFICIAL_EMAIL = "bantuan@kapdh.or.id";

/** Id bagian statis "Legalitas organisasi" di /tentang (components/OrganizationLegal.astro) dan tautannya. */
export const LEGAL_SECTION_ID = "legalitas";
export const LEGAL_SECTION_HREF = `/tentang#${LEGAL_SECTION_ID}` as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Basis URL API dari env build `PUBLIC_API_URL`; default localhost saat dev dan api.kapdh.or.id saat build.
 * Build produksi menolak URL non-https selain localhost agar halaman HTTPS tidak memanggil API tanpa TLS (N-07).
 */
export function resolveApiBase(env: { PUBLIC_API_URL?: string | undefined; DEV: boolean }): string {
  const raw = env.PUBLIC_API_URL?.trim();
  if (!raw) return env.DEV ? DEV_API_URL : PROD_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_API_URL tidak valid: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`PUBLIC_API_URL harus http(s): ${raw}`);
  }
  if (url.protocol === "http:" && !env.DEV && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`PUBLIC_API_URL harus https untuk build produksi: ${raw}`);
  }
  if (url.search || url.hash) throw new Error(`PUBLIC_API_URL tidak boleh memuat query atau fragmen: ${raw}`);
  return url.href.replace(/\/+$/, "");
}

/** Halaman informasi/legal yang isinya dibaca saat runtime dari GET /public/pages/{slug} (F-08, PRD 3.8). */
export const INFO_PAGES = [
  {
    slug: "kebijakan-privasi",
    title: "Kebijakan Privasi",
    description: "Kebijakan privasi KAPDH Apps: data yang dikumpulkan, penggunaannya, dan hak Anda.",
    legal: true,
  },
  {
    slug: "ketentuan",
    title: "Ketentuan Layanan",
    description: "Ketentuan layanan aplikasi keanggotaan KAPDH.",
    legal: true,
  },
  {
    slug: "ketentuan-komunitas",
    title: "Ketentuan Komunitas",
    description: "Pedoman berinteraksi di jejaring dan chat alumni KAPDH.",
    legal: true,
  },
  {
    slug: "bantuan",
    title: "Bantuan",
    description: "Panduan dan jawaban atas pertanyaan umum seputar aplikasi KAPDH.",
    legal: false,
  },
  {
    slug: "tentang",
    title: "Tentang KAPDH",
    // Cuplikan halaman identitas badan hukum: nama badan hukum persis (lib/organization, site.test.ts).
    description: "Tentang Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH) dan KAPDH Apps.",
    legal: false,
  },
] as const;

export type InfoPageSlug = (typeof INFO_PAGES)[number]["slug"];

export function infoPage(slug: string) {
  return INFO_PAGES.find((p) => p.slug === slug) ?? null;
}

/** Navigasi utama (PRD 4.6: beranda, unduh aplikasi, legal, kontak, KTA verify, delete-account). */
export const MAIN_NAV = [
  { href: "/", label: "Beranda" },
  { href: "/tentang", label: "Tentang" },
  { href: "/bantuan", label: "Bantuan" },
  { href: "/kontak", label: "Kontak" },
] as const;

export const FOOTER_LINKS = [
  { href: "/kebijakan-privasi", label: "Kebijakan Privasi" },
  { href: "/ketentuan", label: "Ketentuan Layanan" },
  { href: "/ketentuan-komunitas", label: "Ketentuan Komunitas" },
  /** Bagian statis Legalitas organisasi di /tentang (components/OrganizationLegal.astro). */
  { href: LEGAL_SECTION_HREF, label: "Legalitas" },
  { href: "/bantuan", label: "Bantuan" },
  { href: "/kontak", label: "Kontak" },
  { href: "/kta", label: "Verifikasi KTA" },
  { href: "/delete-account", label: "Hapus Akun" },
] as const;

/** Menandai tautan navigasi aktif (aria-current) dengan mengabaikan garis miring akhir. */
export function isCurrentPath(href: string, pathname: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(href) === norm(pathname);
}
