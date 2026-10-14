import type { components } from "@kapdh/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { type MutationRequestContext, unwrap } from "../../api/query";

/**
 * Bantuan bersama area Manajemen Konten (F-08, F-15) di atas kontrak admin-content (C4). Semua bentuk data diambil
 * dari tipe kontrak yang dibangkitkan; tidak ada model API yang ditulis tangan.
 */
export type S = components["schemas"];
export type AdminPost = S["AdminPost"];
export type AdminPostSummary = S["AdminPostSummary"];
export type AdminPostState = S["AdminPostState"];
export type AdminBanner = S["AdminBanner"];
export type AdminInfoPage = S["AdminInfoPage"];
export type AdminInfoPageSummary = S["AdminInfoPageSummary"];
export type AdminContentCategory = S["AdminContentCategory"];
export type ContentImage = S["ContentImage"];
export type BannerTargetType = S["BannerTargetType"];

/** Ukuran halaman tabel konten (server: bawaan 30, maks 100). */
export const CONTENT_PAGE_SIZE = 20;

/** Kunci query area konten; mutasi menyegarkan seluruh `contentKeys.all` agar tabel lain ikut mutakhir. */
export const contentKeys = {
  all: ["admin-content"] as const,
  posts: ["admin-content", "posts"] as const,
  postList: (filters: unknown) => ["admin-content", "posts", "list", filters] as const,
  post: (postId: string) => ["admin-content", "posts", "detail", postId] as const,
  banners: ["admin-content", "banners"] as const,
  bannerList: (filters: unknown) => ["admin-content", "banners", "list", filters] as const,
  pages: ["admin-content", "pages"] as const,
  pageList: (filters: unknown) => ["admin-content", "pages", "list", filters] as const,
  page: (pageId: string) => ["admin-content", "pages", "detail", pageId] as const,
  /**
   * Kategori berita (content.manage). Kategori event dikelola halaman Event & Tiket (guideline p14) lewat
   * /admin/content/event-categories dengan izin events.manage, bukan dari area ini.
   */
  categoryList: (filters: unknown) => ["admin-content", "categories", "post", "list", filters] as const,
  categoryOptions: ["admin-content", "categories", "post", "options"] as const,
};

/** Header If-Match (versi yang dilihat admin, AC F15-4) dan Idempotency-Key per niat (PRD 4.3). */
export function versionHeaders(
  version: string,
  ctx: Pick<MutationRequestContext, "idempotencyKey">,
): { "If-Match": string; "Idempotency-Key": string } {
  return { "If-Match": version, "Idempotency-Key": ctx.idempotencyKey };
}

/**
 * Objek terbaru dari 409 VERSION_CONFLICT (`current`), bila bentuknya cocok dengan objek yang sedang disunting.
 * Galat konflik lain (mis. IDEMPOTENCY_CONFLICT) tidak membawa `current`.
 */
export function conflictCurrent<T extends { id: string; version: string }>(
  error: ApiError,
  id: string,
): T | null {
  if (error.code !== "VERSION_CONFLICT") return null;
  const current = error.current as Partial<T> | null | undefined;
  return current && current.id === id && typeof current.version === "string" ? (current as T) : null;
}

/**
 * Penyebab konflik untuk pemberitahuan yang jujur (PRD 4.5, AC F15-4, F15-5):
 * - `edited`: VERSION_CONFLICT dan versi server berbeda dari yang dilihat admin (diubah pengurus lain);
 * - `state_changed`: VERSION_CONFLICT dengan versi yang sama, yaitu keadaan turunan server berubah tanpa ada yang
 *   menyunting (mis. jadwal terbit tiba sehingga berita sudah tampil dan jadwalnya tidak dapat dibatalkan);
 * - `unconfirmed`: galat reload_latest lain (mis. IDEMPOTENCY_CONFLICT); tidak boleh disebut "diubah pengurus lain".
 */
export type ConflictCause = "edited" | "state_changed" | "unconfirmed";

export interface ConflictState<T> {
  cause: ConflictCause;
  /** Objek terbaru dari `current` (hanya VERSION_CONFLICT); null bila server tidak mengirimnya. */
  latest: T | null;
}

export function conflictState<T extends { id: string; version: string }>(
  error: ApiError,
  base: Pick<T, "id" | "version">,
): ConflictState<T> {
  if (error.code !== "VERSION_CONFLICT") return { cause: "unconfirmed", latest: null };
  const latest = conflictCurrent<T>(error, base.id);
  return { cause: latest && latest.version === base.version ? "state_changed" : "edited", latest };
}

/**
 * Pesan galat yang paling jelas untuk toast: galat formulir umum (`_`, mis. "kategori masih dipakai", "tidak ada
 * perubahan") atau galat field pertama, lalu pesan server.
 */
export function errorText(error: ApiError): string {
  const general = error.fieldErrors._?.join(" ");
  if (general) return general;
  const first = Object.values(error.fieldErrors)[0]?.join(" ");
  return first || error.message;
}

/** Segarkan semua tabel konten setelah perubahan (detail diperbarui terpisah dengan setQueryData). */
export function invalidateContent(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: contentKeys.all });
}

/** Pilihan kategori berita untuk formulir dan filter (maks 100; jumlah kategori kecil). */
export function fetchPostCategoryOptions({
  signal,
  headers,
}: {
  signal: AbortSignal;
  headers: Record<string, string>;
}) {
  return api.GET("/admin/content/post-categories", {
    params: { query: { sort: "sort_order_asc", limit: 100 } },
    signal,
    headers,
  });
}

/** POST /admin/content/media multipart (N-10): cover berita atau gambar banner. */
export function uploadContentMedia(
  purpose: S["ContentMediaPurpose"],
  file: File,
  signal?: AbortSignal,
): Promise<S["ContentMedia"]> {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", file, file.name);
  return unwrap(
    api.POST("/admin/content/media", {
      // openapi-fetch meneruskan FormData apa adanya dan membiarkan peramban menetapkan boundary multipart.
      body: form as unknown as S["AdminContentMediaUploadRequest"],
      signal,
    }),
  );
}

/** Slug dari judul untuk saran (server tetap membangkitkan dan memastikan unik bila dikosongkan). */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_HINT = "Huruf kecil, angka dan tanda hubung, misalnya kabar-alumni.";
