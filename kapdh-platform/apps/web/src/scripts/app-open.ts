/**
 * Halaman cadangan tautan aplikasi https://kapdh.or.id/app/... (pages/app/index.astro): tampil bila aplikasi belum
 * terpasang atau domain belum terverifikasi (Android App Links, iOS Universal Links; apps/web/app-links.json). Tombol
 * "Buka di aplikasi KAPDH" diarahkan ke skema kapdh://app dengan path dan query yang sama (DeepLinks di kapdh-mobile)
 * HANYA bila keduanya lolos penyaringan; selain itu tetap ke kapdh://app (beranda aplikasi). Nilai dipasang lewat
 * properti href, tidak pernah lewat HTML.
 */

export const APP_SCHEME_ROOT = "kapdh://app";
/** Batas panjang tautan yang diterima aplikasi (DeepLinks.parse di kapdh-mobile). */
export const MAX_APP_LINK_LENGTH = 2048;

const WEB_PREFIX = "/app";
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
// Query: karakter aman tanpa pengodean ulang; "%" hanya sebagai pengodean persen yang utuh.
const QUERY = /^\?(?:[A-Za-z0-9._~&=+,;:@/?-]|%[0-9A-Fa-f]{2})*$/;

/** kapdh://app<path setelah /app><query> untuk lokasi halaman ini, atau kapdh://app bila tidak lolos penyaringan. */
export function appSchemeHref(pathname: string, search: string): string {
  if (pathname !== WEB_PREFIX && !pathname.startsWith(`${WEB_PREFIX}/`)) return APP_SCHEME_ROOT;
  let rest = pathname.slice(WEB_PREFIX.length);
  if (rest.includes("//")) return APP_SCHEME_ROOT;
  // "/app/" dan "/app/payments/" sama dengan tanpa garis miring akhir (DeepLinks.normalize).
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  const segments = rest === "" ? [] : rest.slice(1).split("/");
  if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return APP_SCHEME_ROOT;
  const query = search === "?" ? "" : search;
  if (query !== "" && !QUERY.test(query)) return APP_SCHEME_ROOT;
  const href = `${APP_SCHEME_ROOT}${rest}${query}`;
  return href.length <= MAX_APP_LINK_LENGTH ? href : APP_SCHEME_ROOT;
}

/** Memasang tujuan tombol buka aplikasi dari lokasi halaman; mengembalikan href yang dipasang. */
export function mountAppOpen(
  anchor: HTMLAnchorElement,
  location: { pathname: string; search: string },
): string {
  const href = appSchemeHref(location.pathname, location.search);
  anchor.href = href;
  return href;
}
