import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, tstz, updatedAt, version } from "./_common.js";
import { admins, users } from "./identity.js";
import { files } from "./platform.js";

export const categoryKind = app.enum("category_kind", ["post", "event"]);
/** Siklus berita: draft, published (terjadwal lewat published_at), archived (F-08). */
export const postStatus = app.enum("post_status", ["draft", "published", "archived"]);
export const bannerTargetType = app.enum("banner_target_type", ["none", "post", "event", "page", "url"]);

const SLUG_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";

/** Kategori berita dan event (guideline "Manajemen Kategori"); dipakai FK RESTRICT agar kategori terpakai tidak hilang. */
export const categories = app.table(
  "categories",
  {
    id: id(),
    kind: categoryKind("kind").notNull(),
    label: text("label").notNull(),
    slug: text("slug").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("categories_kind_slug_key").on(t.kind, t.slug),
    check("categories_slug_chk", sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check("categories_label_chk", sql`char_length(btrim(${t.label})) between 1 and 80`),
  ],
);

/**
 * Berita (F-08). body_html sudah disanitasi server sebelum disimpan. Feed hanya menampilkan published yang
 * published_at <= now (AC F08-1); announced_at memastikan job pengumuman terjadwal berjalan sekali (AC F15-5).
 */
export const posts = app.table(
  "posts",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    bodyHtml: text("body_html").notNull(),
    coverFileId: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    status: postStatus("status").notNull().default("draft"),
    publishedAt: tstz("published_at"),
    announcedAt: tstz("announced_at"),
    /**
     * Penghitung like dipelihara HANYA oleh trigger `app.post_likes_count` (migrasi 0005) pada INSERT/DELETE
     * post_likes, termasuk penghapusan kaskade saat akun dihapus (F-14), sehingga selalu sama dengan jumlah baris
     * post_likes (AC F08-3, PRD 6.2). Layanan tidak boleh mengubah kolom ini sendiri.
     */
    likeCount: integer("like_count").notNull().default(0),
    authorAdminId: uuid("author_admin_id").references(() => admins.id, { onDelete: "set null" }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("posts_slug_key").on(t.slug),
    index("posts_status_published_at_idx").on(t.status, t.publishedAt),
    index("posts_category_id_idx").on(t.categoryId),
    index("posts_cover_file_id_idx")
      .on(t.coverFileId)
      .where(sql`${t.coverFileId} is not null`),
    index("posts_author_admin_id_idx")
      .on(t.authorAdminId)
      .where(sql`${t.authorAdminId} is not null`),
    check("posts_slug_chk", sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check("posts_title_chk", sql`char_length(btrim(${t.title})) between 1 and 200`),
    check("posts_like_count_chk", sql`${t.likeCount} >= 0`),
    check("posts_published_chk", sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
    check("posts_announced_chk", sql`${t.announcedAt} is null or ${t.publishedAt} is not null`),
  ],
);

/** Satu like per pengguna per berita (AC F08-3); posts.like_count mengikuti tabel ini lewat trigger (migrasi 0005). */
export const postLikes = app.table(
  "post_likes",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] }), index("post_likes_user_id_idx").on(t.userId)],
);

/**
 * Banner beranda (F-08). Tampil hanya dalam jendela tanggalnya (AC F08-2). Target tervalidasi: none tanpa nilai,
 * post/event/page menunjuk id/slug, url hanya https.
 */
export const banners = app.table(
  "banners",
  {
    id: id(),
    title: text("title").notNull(),
    imageFileId: uuid("image_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    targetType: bannerTargetType("target_type").notNull().default("none"),
    targetValue: text("target_value"),
    sortOrder: smallint("sort_order").notNull().default(0),
    startsAt: tstz("starts_at").notNull(),
    endsAt: tstz("ends_at"),
    active: boolean("active").notNull().default(true),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("banners_image_file_id_idx").on(t.imageFileId),
    check("banners_window_chk", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("banners_target_chk", sql`(${t.targetType} = 'none') = (${t.targetValue} is null)`),
    check("banners_url_chk", sql`${t.targetType} <> 'url' or ${t.targetValue} ~ '^https://'`),
    check("banners_title_chk", sql`char_length(btrim(${t.title})) between 1 and 120`),
  ],
);

/**
 * Halaman informasi dan legal (privasi, ketentuan, ketentuan komunitas, bantuan, tentang; F-08, PRD 6.2). Dua salinan
 * dipisahkan agar teks yang disetujui pengguna dapat direproduksi (F-01 "persetujuan dicatat beserta versi"):
 * - title/body_html = DRAF kerja pengurus; setiap simpan menaikkan `version` (optimistic lock If-Match, AC F15-4) dan
 *   tidak mengubah teks yang tayang.
 * - published_title/published_body_html = teks yang TAYANG; hanya berubah saat terbit, dan setiap terbit menaikkan
 *   `published_version`, yaitu versi legal yang dirujuk users.policy_version dan app_settings `legal`.
 * published_* null = belum pernah terbit. Entri audit `page.published` (append-only, F-17) menyimpan
 * published_version beserta teks yang diterbitkan sehingga versi lama yang pernah disetujui tetap dapat ditampilkan.
 */
export const pages = app.table(
  "pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull(),
    version: version(),
    publishedTitle: text("published_title"),
    publishedBodyHtml: text("published_body_html"),
    publishedVersion: integer("published_version"),
    publishedAt: tstz("published_at"),
    updatedByAdminId: uuid("updated_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pages_slug_key").on(t.slug),
    index("pages_updated_by_admin_id_idx")
      .on(t.updatedByAdminId)
      .where(sql`${t.updatedByAdminId} is not null`),
    check("pages_slug_chk", sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check("pages_title_chk", sql`char_length(btrim(${t.title})) between 1 and 200`),
    // Salinan tayang lengkap atau tidak ada sama sekali; versi legal mulai 1 (F-01, PRD 6.2).
    check(
      "pages_published_chk",
      sql`(${t.publishedVersion} is null and ${t.publishedAt} is null and ${t.publishedTitle} is null and ${t.publishedBodyHtml} is null) or (${t.publishedVersion} >= 1 and ${t.publishedAt} is not null and ${t.publishedTitle} is not null and char_length(btrim(${t.publishedTitle})) between 1 and 200 and ${t.publishedBodyHtml} is not null)`,
    ),
  ],
);
