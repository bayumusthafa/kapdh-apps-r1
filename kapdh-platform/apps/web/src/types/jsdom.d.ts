/**
 * Deklarasi minimal jsdom (paketnya tidak membawa tipe): hanya yang dipakai untuk merender dan memeriksa naskah
 * halaman informasi/legal saat build (lib/published-pages.ts, scripts/published-pages.mjs).
 */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
