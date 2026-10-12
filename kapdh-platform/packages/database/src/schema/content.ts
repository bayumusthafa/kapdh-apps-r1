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
    /** Penghitung like dijaga dalam transaksi yang sama dengan post_likes (AC F08-3). */
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
    check("posts_slug_chk", sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check("posts_title_chk", sql`char_length(btrim(${t.title})) between 1 and 200`),
    check("posts_like_count_chk", sql`${t.likeCount} >= 0`),
    check("posts_published_chk", sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
    check("posts_announced_chk", sql`${t.announcedAt} is null or ${t.publishedAt} is not null`),
  ],
);

/** Satu like per pengguna per berita (AC F08-3). */
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
    check("banners_window_chk", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("banners_target_chk", sql`(${t.targetType} = 'none') = (${t.targetValue} is null)`),
    check("banners_url_chk", sql`${t.targetType} <> 'url' or ${t.targetValue} ~ '^https://'`),
    check("banners_title_chk", sql`char_length(btrim(${t.title})) between 1 and 120`),
  ],
);

/**
 * Halaman informasi dan legal (privasi, ketentuan, ketentuan komunitas, bantuan, tentang). published_at null =
 * draf; version adalah versi legal yang dirujuk persetujuan pengguna (users.policy_version) dan optimistic lock.
 */
export const pages = app.table(
  "pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull(),
    version: version(),
    publishedAt: tstz("published_at"),
    updatedByAdminId: uuid("updated_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pages_slug_key").on(t.slug),
    check("pages_slug_chk", sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check("pages_title_chk", sql`char_length(btrim(${t.title})) between 1 and 200`),
  ],
);
