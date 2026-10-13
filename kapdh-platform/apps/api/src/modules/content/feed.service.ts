import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { categories, files, postLikes, posts } from "@kapdh/database";
import { and, desc, eq, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import { decodeCursor, keysetAfter, pageOf, type PageQuery } from "../../core/pagination/cursor.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { ContentMediaService } from "./content-media.service.js";
import { iso } from "./content.util.js";

type PostSummary = components["schemas"]["PostSummary"];
type Post = components["schemas"]["Post"];
type PostPage = components["schemas"]["PostPage"];
type LikeState = components["schemas"]["LikeState"];

const POST_GONE = "Berita tidak lagi tersedia.";

/** AC F08-1: hanya berita published yang published_at-nya sudah lewat (waktu server). */
export function visiblePost(now: Date): SQL {
  return and(eq(posts.status, "published"), lte(posts.publishedAt, now))!;
}

const FEED_CURSOR = z.object({ published_at: z.coerce.date(), id: z.uuid() });

/**
 * Feed, detail dan like berita untuk anggota aktif (F-08, PRD 3.8). Draft, terjadwal masa depan dan archived tidak
 * pernah dikirim (AC F08-1); like idempoten lewat INSERT ... ON CONFLICT DO NOTHING / DELETE pada post_likes dan
 * like_count hanya dipelihara trigger database (AC F08-3).
 */
@Injectable()
export class FeedService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly media: ContentMediaService,
  ) {}

  private summaryColumns(userId: string) {
    return {
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      excerpt: posts.excerpt,
      publishedAt: posts.publishedAt,
      likeCount: posts.likeCount,
      coverId: files.id,
      categoryId: categories.id,
      categorySlug: categories.slug,
      categoryLabel: categories.label,
      likedByMe: sql<boolean>`exists (select 1 from ${postLikes} where ${postLikes.postId} = ${posts.id} and ${postLikes.userId} = ${userId})`,
    };
  }

  /** GET /posts: keyset published_at turun lalu id turun; slug kategori tak dikenal = daftar kosong. */
  async list(userId: string, page: PageQuery, categorySlug: string | undefined): Promise<PostPage> {
    const now = this.clock.now();
    const after = page.cursor ? decodeCursor(page.cursor, FEED_CURSOR) : null;
    const rows = await this.db
      .select(this.summaryColumns(userId))
      .from(posts)
      .leftJoin(categories, eq(categories.id, posts.categoryId))
      .leftJoin(
        files,
        and(eq(files.id, posts.coverFileId), eq(files.status, "ready"), eq(files.visibility, "public")),
      )
      .where(
        and(
          visiblePost(now),
          categorySlug ? and(eq(categories.kind, "post"), eq(categories.slug, categorySlug)) : undefined,
          after
            ? keysetAfter([
                { column: posts.publishedAt, value: after.published_at, direction: "desc" },
                { column: posts.id, value: after.id, direction: "desc" },
              ])
            : undefined,
        ),
      )
      .orderBy(desc(posts.publishedAt), desc(posts.id))
      .limit(page.limit + 1);
    return pageOf(rows, page.limit, {
      cursorOf: (row) => ({ published_at: row.publishedAt, id: row.id }),
      toItem: (row) => this.toSummary(row),
    });
  }

  /** Berita terbaru untuk Beranda (maksimal `limit`). */
  async latest(userId: string, limit: number, db: DbOrTx = this.db): Promise<PostSummary[]> {
    const now = this.clock.now();
    const rows = await db
      .select(this.summaryColumns(userId))
      .from(posts)
      .leftJoin(categories, eq(categories.id, posts.categoryId))
      .leftJoin(
        files,
        and(eq(files.id, posts.coverFileId), eq(files.status, "ready"), eq(files.visibility, "public")),
      )
      .where(visiblePost(now))
      .orderBy(desc(posts.publishedAt), desc(posts.id))
      .limit(limit);
    return rows.map((row) => this.toSummary(row));
  }

  /** GET /posts/{slug}: berita yang tidak tampil di feed -> 404 yang sama dengan slug tak dikenal (N-09). */
  async get(userId: string, slug: string): Promise<Post> {
    const now = this.clock.now();
    const [row] = await this.db
      .select({ ...this.summaryColumns(userId), bodyHtml: posts.bodyHtml, updatedAt: posts.updatedAt })
      .from(posts)
      .leftJoin(categories, eq(categories.id, posts.categoryId))
      .leftJoin(
        files,
        and(eq(files.id, posts.coverFileId), eq(files.status, "ready"), eq(files.visibility, "public")),
      )
      .where(and(eq(posts.slug, slug), visiblePost(now)));
    if (!row) throw notFound(POST_GONE);
    return { ...this.toSummary(row), body_html: row.bodyHtml, updated_at: iso(row.updatedAt) };
  }

  /**
   * PUT/DELETE /posts/{slug}/like (AC F08-3). Baris berita dikunci FOR NO KEY UPDATE lebih dulu dengan predikat
   * tampil (berita tidak dapat diarsipkan di tengah like; urutan kunci posts -> post_likes sama dengan kaskade hapus
   * berita), lalu hanya INSERT ... ON CONFLICT DO NOTHING atau DELETE pada post_likes. like_count dibaca setelah
   * trigger statement memperbaruinya di transaksi yang sama.
   */
  async setLike(userId: string, slug: string, liked: boolean): Promise<LikeState> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [post] = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.slug, slug), visiblePost(now)))
        .for("no key update");
      if (!post) throw notFound(POST_GONE);
      if (liked)
        await tx
          .insert(postLikes)
          .values({ postId: post.id, userId, createdAt: now })
          .onConflictDoNothing({ target: [postLikes.postId, postLikes.userId] });
      else await tx.delete(postLikes).where(and(eq(postLikes.postId, post.id), eq(postLikes.userId, userId)));
      const [current] = await tx.select({ likeCount: posts.likeCount }).from(posts).where(eq(posts.id, post.id));
      return { liked, like_count: current!.likeCount };
    });
  }

  private toSummary(row: {
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    publishedAt: Date | null;
    likeCount: number;
    coverId: string | null;
    categoryId: string | null;
    categorySlug: string | null;
    categoryLabel: string | null;
    likedByMe: boolean;
  }): PostSummary {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      cover_url: row.coverId ? this.media.publicUrl(row.coverId) : null,
      category:
        row.categoryId && row.categorySlug && row.categoryLabel
          ? { id: row.categoryId, slug: row.categorySlug, label: row.categoryLabel }
          : null,
      // Selalu terisi untuk berita yang tampil (posts_published_chk).
      published_at: iso(row.publishedAt!),
      like_count: row.likeCount,
      liked_by_me: row.likedByMe === true,
    };
  }
}
