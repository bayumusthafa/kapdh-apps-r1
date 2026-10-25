/**
 * Komponen .astro yang diimpor dari berkas TypeScript (uji render lewat Container API, lib/published-pages.test.ts)
 * untuk `tsc`, yang tidak mengenal ekstensi .astro; astro-check tetap memakai tipe komponen yang sebenarnya.
 */
declare module "*.astro" {
  const Component: import("astro/runtime/server/index.js").AstroComponentFactory;
  export default Component;
}
