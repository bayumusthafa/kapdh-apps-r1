import { z } from "zod";
import { queryBool } from "../../core/validation/validate.js";
import { CATEGORY_SLUG_MAX, PAGE_SLUG_MAX, POST_SLUG_MAX, SLUG_PATTERN } from "./content.util.js";

/**
 * Skema masukan web admin konten (kontrak admin-content.yaml; galat 400 VALIDATION_ERROR dengan field_errors,
 * PRD 5.2). Teks judul/label dipangkas; HTML disanitasi layanan setelah validasi panjang.
 */

const SLUG_MESSAGE = "Slug hanya huruf kecil, angka, dan tanda hubung (contoh: kegiatan-alumni).";
const slug = (max: number) =>
  z.string().min(1, "Slug wajib diisi.").max(max, `Slug maksimal ${max} karakter.`).regex(SLUG_PATTERN, SLUG_MESSAGE);
const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} wajib diisi.`)
    .max(max, `${label} maksimal ${max} karakter.`);
const html = z
  .string()
  .min(1, "Isi wajib diisi.")
  .max(200_000, "Isi maksimal 200.000 karakter.");
const dateTime = z.iso.datetime({ offset: true, message: "Format waktu ISO 8601 dengan zona waktu." });
const id = z.uuid({ message: "Format id tidak valid." });

/** PATCH: minimal satu field dikirim (kontrak minProperties 1). */
function atLeastOne<T extends z.ZodObject>(schema: T) {
  return schema.refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Kirim minimal satu perubahan.",
    path: ["_"],
  });
}

// ------------------------------------------------------------------------------------------------- berita

export const postCreateSchema = z.object({
  title: text(200, "Judul"),
  slug: slug(POST_SLUG_MAX).optional(),
  excerpt: z.string().max(300, "Ringkasan maksimal 300 karakter.").nullable().optional(),
  body_html: html,
  cover_file_id: id.nullable().optional(),
  category_id: id.nullable().optional(),
});

export const postUpdateSchema = atLeastOne(
  z.object({
    title: text(200, "Judul").optional(),
    slug: slug(POST_SLUG_MAX).optional(),
    excerpt: z.string().max(300, "Ringkasan maksimal 300 karakter.").nullable().optional(),
    body_html: html.optional(),
    cover_file_id: id.nullable().optional(),
    category_id: id.nullable().optional(),
  }),
);

export const postPublishSchema = z.object({ published_at: dateTime.nullable().optional() });

export const postListQuerySchema = z.object({
  q: z.string().trim().max(100, "Pencarian maksimal 100 karakter.").optional(),
  state: z.enum(["draft", "scheduled", "published", "archived"]).optional(),
  category_id: id.optional(),
  sort: z.enum(["updated_at_desc", "published_at_desc", "created_at_desc", "title_asc"]).default("updated_at_desc"),
});

// ------------------------------------------------------------------------------------------------- banner

const targetType = z.enum(["none", "post", "event", "page", "url"]);
const targetValue = z.string().max(2048, "Nilai target maksimal 2048 karakter.").nullable();
const sortOrder = z.number().int("Urutan harus bilangan bulat.").min(0).max(32767);

export const bannerCreateSchema = z.object({
  title: text(120, "Judul"),
  image_file_id: id,
  target_type: targetType,
  target_value: targetValue,
  sort_order: sortOrder.default(0),
  starts_at: dateTime,
  ends_at: dateTime.nullable().optional(),
  active: z.boolean().default(true),
});

export const bannerUpdateSchema = atLeastOne(
  z.object({
    title: text(120, "Judul").optional(),
    image_file_id: id.optional(),
    target_type: targetType.optional(),
    target_value: targetValue.optional(),
    sort_order: sortOrder.optional(),
    starts_at: dateTime.optional(),
    ends_at: dateTime.nullable().optional(),
    active: z.boolean().optional(),
  }),
);

export const bannerListQuerySchema = z.object({
  q: z.string().trim().max(100, "Pencarian maksimal 100 karakter.").optional(),
  state: z.enum(["inactive", "scheduled", "live", "ended"]).optional(),
  sort: z.enum(["sort_order_asc", "starts_at_desc", "updated_at_desc", "title_asc"]).default("sort_order_asc"),
});

// ------------------------------------------------------------------------------------------------ halaman

export const pageCreateSchema = z.object({
  slug: slug(PAGE_SLUG_MAX),
  title: text(200, "Judul"),
  body_html: html,
});

export const pageUpdateSchema = atLeastOne(
  z.object({
    slug: slug(PAGE_SLUG_MAX).optional(),
    title: text(200, "Judul").optional(),
    body_html: html.optional(),
  }),
);

export const pagePublishSchema = z.object({
  change_note: z.string().trim().max(500, "Catatan perubahan maksimal 500 karakter.").nullable().optional(),
});

export const pageListQuerySchema = z.object({
  q: z.string().trim().max(100, "Pencarian maksimal 100 karakter.").optional(),
  sort: z.enum(["system_first", "title_asc", "updated_at_desc", "published_at_desc"]).default("system_first"),
});

// ----------------------------------------------------------------------------------------------- kategori

export const categoryCreateSchema = z.object({
  label: text(80, "Label"),
  slug: slug(CATEGORY_SLUG_MAX).optional(),
  sort_order: sortOrder.default(0),
  active: z.boolean().default(true),
});

export const categoryUpdateSchema = atLeastOne(
  z.object({
    label: text(80, "Label").optional(),
    slug: slug(CATEGORY_SLUG_MAX).optional(),
    sort_order: sortOrder.optional(),
    active: z.boolean().optional(),
  }),
);

export const categoryListQuerySchema = z.object({
  active: queryBool().optional(),
  q: z.string().trim().max(80, "Pencarian maksimal 80 karakter.").optional(),
  sort: z.enum(["sort_order_asc", "label_asc", "usage_desc", "updated_at_desc"]).default("sort_order_asc"),
});

/** Waktu ISO tervalidasi -> Date (null/undefined dipertahankan). */
export function toDate(value: string): Date;
export function toDate(value: string | null): Date | null;
export function toDate(value: string | null | undefined): Date | null | undefined;
export function toDate(value: string | null | undefined): Date | null | undefined {
  return value === undefined || value === null ? value : new Date(value);
}
