import type { components } from "@kapdh/contracts";
import { type SQL, and, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isRetryableTransactionError } from "../../core/db/errors.js";
import { decodeCursor, encodeCursor } from "../../core/pagination/cursor.js";

/** Percobaan maksimum transaksi tulis konten yang dibatalkan PostgreSQL karena deadlock/serialisasi. */
export const CONTENT_TX_ATTEMPTS = 3;

/**
 * Menjalankan ulang SELURUH transaksi tulis konten bila PostgreSQL membatalkannya dengan 40P01 (deadlock) atau
 * 40001 (serialisasi), maksimal {@link CONTENT_TX_ATTEMPTS} kali (ARCHITECTURE §2: konkurensi; PRD 5.2:
 * INTERNAL_ERROR hanya untuk kegagalan nyata). Aman karena transaksi yang batal tidak meninggalkan perubahan maupun
 * efek afterCommit, dan setiap percobaan memeriksa ulang If-Match pada baris terkunci (409 bila sudah berubah).
 * Galat lain diteruskan apa adanya.
 */
export async function retryContentTransaction<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt >= CONTENT_TX_ATTEMPTS) throw error;
    }
  }
}

export type ContentCategoryRef = components["schemas"]["ContentCategoryRef"];
export type PageLegalDocument = components["schemas"]["PageLegalDocument"];
export type AdminPostState = components["schemas"]["AdminPostState"];
export type AdminBannerState = components["schemas"]["AdminBannerState"];

/** Pola slug bersama (posts/pages/categories `*_slug_chk`). */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const POST_SLUG_MAX = 160;
export const PAGE_SLUG_MAX = 120;
export const CATEGORY_SLUG_MAX = 80;
/**
 * Panjang maksimum `body_html` berita/halaman (kontrak: masukan <= 200.000 karakter). Batas yang sama berlaku untuk
 * HASIL sanitasi, karena atribut tautan luar dan escape karakter dapat memperpanjang isi; dengan begitu teks tayang
 * halaman legal selalu muat utuh di audit `page.published` (F-01, F-17).
 */
export const CONTENT_BODY_HTML_MAX = 200_000;

/**
 * Halaman baku dari seed referensi (PRD 8.2 langkah 4): tidak dapat dihapus, slug terkunci. Tiga dokumen legal
 * berversi mencerminkan versi tayangnya di `app_settings.legal` (F-01, ARCHITECTURE §5.4).
 */
export const SYSTEM_PAGES: readonly { slug: string; legal: PageLegalDocument | null }[] = [
  { slug: "kebijakan-privasi", legal: "privacy" },
  { slug: "ketentuan", legal: "terms" },
  { slug: "ketentuan-komunitas", legal: "community" },
  { slug: "bantuan", legal: null },
  { slug: "tentang", legal: null },
];

export function isSystemPage(slug: string): boolean {
  return SYSTEM_PAGES.some((page) => page.slug === slug);
}

export function legalDocumentOf(slug: string): PageLegalDocument | null {
  return SYSTEM_PAGES.find((page) => page.slug === slug)?.legal ?? null;
}

/** Kunci app_settings.legal untuk dokumen legal (F-01). */
export function legalSettingField(
  document: PageLegalDocument,
): "privacy_version" | "terms_version" | "community_version" {
  return `${document}_version`;
}

/**
 * Slug dari judul/label (huruf kecil, angka, tanda hubung; diakritik dibuang). String kosong bila judul tidak
 * menyisakan karakter yang sah; pemanggil memakai cadangan.
 */
export function slugify(input: string, maxLength: number): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** Slug kandidat `base`, `base-2`, ... yang tidak ada di `taken`, dipotong agar <= maxLength. */
export function nextFreeSlug(base: string, taken: ReadonlySet<string>, maxLength: number): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Tidak dapat membangkitkan slug unik");
}

/** Akhiran acak pendek untuk percobaan ulang ketika slug otomatis bertabrakan bersamaan. */
export function randomSlugSuffix(): string {
  return Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
}

/** Pola ILIKE "mengandung" dengan karakter khusus diloloskan. */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Judul/label/teks dari klien: spasi tepi dipangkas. */
export function trimmed(value: string): string {
  return value.trim();
}

/** Keadaan berita untuk pengurus, diturunkan dari status + published_at (kontrak `AdminPostState`, AC F08-1). */
export function postState(status: string, publishedAt: Date | null, now: Date): AdminPostState {
  if (status === "archived") return "archived";
  if (status === "draft") return "draft";
  return publishedAt && publishedAt.getTime() > now.getTime() ? "scheduled" : "published";
}

/** Berita pernah tampil ke anggota: slug terkunci (kontrak `AdminPost.slug_locked`). */
export function postSlugLocked(publishedAt: Date | null, now: Date): boolean {
  return publishedAt !== null && publishedAt.getTime() <= now.getTime();
}

/** Keadaan tayang banner (kontrak `AdminBannerState`, AC F08-2). */
export function bannerState(
  banner: { active: boolean; startsAt: Date; endsAt: Date | null },
  now: Date,
): AdminBannerState {
  if (!banner.active) return "inactive";
  if (banner.endsAt && banner.endsAt.getTime() <= now.getTime()) return "ended";
  if (banner.startsAt.getTime() > now.getTime()) return "scheduled";
  return "live";
}

export function iso(value: Date): string;
export function iso(value: Date | null): string | null;
export function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Harga Money "0.00" = event gratis (AC F09-3); dibandingkan sebagai teks, bukan float (ARCHITECTURE §2.5). */
export function isZeroMoney(value: string): boolean {
  return /^0+(\.0+)?$/.test(value);
}

// ------------------------------------------------------------------------------------- keyset admin terurut

export type SortKeyType = "timestamptz" | "text" | "int" | "uuid";

/**
 * Satu kolom urutan keyset tabel admin (kontrak: urutan selalu ditambah `id` sebagai pemutus seri). `expr` boleh
 * ekspresi turunan (peringkat halaman baku, jumlah pemakaian, coalesce published_at), sehingga nilainya dibaca
 * kembali dari baris sebagai teks (`::text`) dan dibandingkan dengan cast tipe yang sama: bulat-balik presisi
 * mikrodetik dan tidak bergantung driver (PGlite vs postgres-js).
 */
export interface SortKey {
  expr: SQL;
  type: SortKeyType;
  direction: "asc" | "desc";
}

export interface SortSpec {
  name: string;
  keys: SortKey[];
}

function cast(value: string, type: SortKeyType): SQL {
  switch (type) {
    case "timestamptz":
      return sql`cast(${value} as timestamptz)`;
    case "int":
      return sql`cast(${value} as integer)`;
    case "uuid":
      return sql`cast(${value} as uuid)`;
    case "text":
      return sql`cast(${value} as text)`;
  }
}

/** Kolom pilih tambahan `sk0..skN` berisi nilai kunci urutan sebagai teks. */
export function sortKeySelection(spec: SortSpec): Record<string, SQL<string>> {
  return Object.fromEntries(spec.keys.map((key, i) => [`sk${i}`, sql<string>`(${key.expr})::text`]));
}

export function sortOrderBy(spec: SortSpec): SQL[] {
  return spec.keys.map((key) => (key.direction === "asc" ? sql`${key.expr} asc` : sql`${key.expr} desc`));
}

/** Predikat "setelah posisi cursor" (k1 > v1) OR (k1 = v1 AND k2 > v2) OR … sesuai arah tiap kunci. */
export function sortAfter(spec: SortSpec, values: string[]): SQL {
  const branches = spec.keys.map((key, index) => {
    const equalities = spec.keys
      .slice(0, index)
      .map((prev, i) => sql`${prev.expr} = ${cast(values[i]!, prev.type)}`);
    const step =
      key.direction === "asc"
        ? sql`${key.expr} > ${cast(values[index]!, key.type)}`
        : sql`${key.expr} < ${cast(values[index]!, key.type)}`;
    return and(...equalities, step)!;
  });
  return (branches.length === 1 ? branches[0] : or(...branches))!;
}

/** Cursor tabel admin: nama urutan + nilai kunci; cursor dari urutan lain atau rusak -> 400 field cursor. */
export function decodeSortCursor(cursor: string, spec: SortSpec): string[] {
  const parsed = decodeCursor(
    cursor,
    z.object({ s: z.literal(spec.name), k: z.array(z.string().max(400)).length(spec.keys.length) }),
  );
  return parsed.k;
}

export function encodeSortCursor(spec: SortSpec, row: Record<string, unknown>): string {
  return encodeCursor({ s: spec.name, k: spec.keys.map((_, i) => String(row[`sk${i}`])) });
}

/** Halaman admin `{items, next_cursor, total}` dari baris `limit + 1` yang memuat kolom `sk*`. */
export function adminPageOf<Row extends Record<string, unknown>, Item>(
  rows: Row[],
  limit: number,
  spec: SortSpec,
  total: number,
  toItem: (row: Row) => Item,
): { items: Item[]; next_cursor: string | null; total: number } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toItem),
    next_cursor: hasMore && last ? encodeSortCursor(spec, last) : null,
    total,
  };
}
