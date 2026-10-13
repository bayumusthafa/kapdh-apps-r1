import { type AnyColumn, type SQL, and, eq, gt, lt, or } from "drizzle-orm";
import { z } from "zod";
import { AppException } from "../errors/app-exception.js";
import { queryInt, validateQuery } from "../validation/validate.js";

/**
 * Pagination keyset dengan cursor opaque base64url (ARCHITECTURE §4.2, §4.10; kontrak root.yaml Cursor/Limit):
 * `limit` bawaan 30, maksimum 100; respons `{items, next_cursor}` dan tabel admin `{items, next_cursor, total}`.
 *
 *   const page = parsePageQuery(query);
 *   const after = page.cursor ? decodeCursor(page.cursor, z.object({ created_at: z.coerce.date(), id: z.uuid() })) : null;
 *   const rows = await db.select().from(posts)
 *     .where(and(filter, after ? keysetAfter([
 *       { column: posts.createdAt, value: after.created_at, direction: "desc" },
 *       { column: posts.id, value: after.id, direction: "desc" },
 *     ]) : undefined))
 *     .orderBy(desc(posts.createdAt), desc(posts.id))
 *     .limit(page.limit + 1);
 *   return pageOf(rows, page.limit, { cursorOf: (r) => ({ created_at: r.createdAt, id: r.id }), toItem });
 *
 * Kolom keyset wajib NOT NULL dan kombinasi terakhirnya unik (biasanya id). Timestamp di cursor berpresisi
 * milidetik: isi kolom waktu dari Clock aplikasi (ARCHITECTURE §2.6), bukan default now() berpresisi mikrodetik.
 */
export const DEFAULT_PAGE_LIMIT = 30;
export const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;

export interface PageQuery {
  cursor: string | undefined;
  limit: number;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface AdminPage<T> extends Page<T> {
  total: number;
}

/** Membaca `cursor` dan `limit` dari query string; parameter lain diabaikan. */
export function parsePageQuery(
  query: unknown,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): PageQuery {
  const maxLimit = options.maxLimit ?? MAX_PAGE_LIMIT;
  const parsed = validateQuery(
    z.object({
      cursor: z.string().min(1).max(MAX_CURSOR_LENGTH, "Cursor tidak valid").optional(),
      limit: queryInt({ min: 1, max: maxLimit }).optional(),
    }),
    query,
  );
  return { cursor: parsed.cursor, limit: parsed.limit ?? options.defaultLimit ?? DEFAULT_PAGE_LIMIT };
}

export function encodeCursor(position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, p: position }), "utf8").toString("base64url");
}

/** Mendekode cursor dan memvalidasi isinya; cursor rusak/dimanipulasi menjadi 400 VALIDATION_ERROR field `cursor`. */
export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.infer<T> {
  const invalid = () =>
    new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
      fieldErrors: { cursor: ["Cursor tidak valid. Muat ulang daftar dari awal."] },
    });
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const envelope = decoded as { v?: unknown; p?: unknown } | null;
  if (!envelope || envelope.v !== 1) throw invalid();
  const parsed = schema.safeParse(envelope.p);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/**
 * Menyusun halaman dari baris yang diambil dengan `limit + 1`: baris ekstra menandakan masih ada halaman berikutnya.
 */
export function pageOf<Row, Item = Row>(
  rows: Row[],
  limit: number,
  options: { cursorOf: (row: Row) => Record<string, unknown>; toItem?: (row: Row) => Item },
): Page<Item>;
export function pageOf<Row, Item = Row>(
  rows: Row[],
  limit: number,
  options: { cursorOf: (row: Row) => Record<string, unknown>; toItem?: (row: Row) => Item; total: number },
): AdminPage<Item>;
export function pageOf<Row, Item = Row>(
  rows: Row[],
  limit: number,
  options: { cursorOf: (row: Row) => Record<string, unknown>; toItem?: (row: Row) => Item; total?: number },
): Page<Item> | AdminPage<Item> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const items = options.toItem ? pageRows.map(options.toItem) : (pageRows as unknown as Item[]);
  const page: Page<Item> = {
    items,
    next_cursor:
      hasMore && last !== undefined ? encodeCursor(serializePosition(options.cursorOf(last))) : null,
  };
  return options.total === undefined ? page : { ...page, total: options.total };
}

function serializePosition(position: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(position).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

export interface KeysetKey {
  column: AnyColumn;
  value: unknown;
  direction: "asc" | "desc";
}

/**
 * Predikat "setelah posisi cursor" untuk urutan multi-kolom dengan arah campuran:
 * (k1 > v1) OR (k1 = v1 AND k2 > v2) OR … (`<` untuk desc). Urutan ORDER BY harus sama dengan `keys`.
 */
export function keysetAfter(keys: KeysetKey[]): SQL {
  if (keys.length === 0) throw new Error("keysetAfter membutuhkan minimal satu kolom");
  const branches = keys.map((key, index) => {
    const equalities = keys.slice(0, index).map((prev) => eq(prev.column, prev.value));
    const step = key.direction === "asc" ? gt(key.column, key.value) : lt(key.column, key.value);
    return and(...equalities, step)!;
  });
  return (branches.length === 1 ? branches[0] : or(...branches))!;
}
