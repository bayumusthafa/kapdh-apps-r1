import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins, categories, files, posts } from "@kapdh/database";
import { and, count, eq, gt, ilike, lte, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { isRetryableTransactionError, isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { CategoriesService } from "./categories.service.js";
import { ContentMediaService } from "./content-media.service.js";
import {
  type AdminPostState,
  adminPageOf,
  containsPattern,
  decodeSortCursor,
  iso,
  nextFreeSlug,
  POST_SLUG_MAX,
  postSlugLocked,
  postState,
  randomSlugSuffix,
  slugify,
  type SortSpec,
  sortAfter,
  sortKeySelection,
  sortOrderBy,
} from "./content.util.js";

type AdminPost = components["schemas"]["AdminPost"];
type AdminPostSummary = components["schemas"]["AdminPostSummary"];
type AdminPostPage = components["schemas"]["AdminPostPage"];
export type AdminPostSort = components["schemas"]["AdminPostSort"];
type PostRow = typeof posts.$inferSelect;

export interface PostListQuery {
  q?: string;
  state?: AdminPostState;
  categoryId?: string;
  sort: AdminPostSort;
  cursor?: string;
  limit: number;
}

export interface PostCreateInput {
  title: string;
  slug?: string;
  excerpt?: string | null;
  body_html: string;
  cover_file_id?: string | null;
  category_id?: string | null;
}

export type PostUpdateInput = Partial<PostCreateInput>;

/** Kolom ringkasan berita untuk tabel pengurus (tanpa body agar daftar ringan). */
const summaryColumns = {
  id: posts.id,
  slug: posts.slug,
  title: posts.title,
  status: posts.status,
  publishedAt: posts.publishedAt,
  likeCount: posts.likeCount,
  version: posts.version,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,
  categoryId: categories.id,
  categorySlug: categories.slug,
  categoryLabel: categories.label,
  coverId: files.id,
};

type SummaryRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  publishedAt: Date | null;
  likeCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  categoryId: string | null;
  categorySlug: string | null;
  categoryLabel: string | null;
  coverId: string | null;
};

const EPOCH = sql`'1970-01-01T00:00:00Z'::timestamptz`;

function sortSpec(sort: AdminPostSort): SortSpec {
  const idDesc = { expr: sql`${posts.id}`, type: "uuid", direction: "desc" } as const;
  switch (sort) {
    case "updated_at_desc":
      return { name: sort, keys: [{ expr: sql`${posts.updatedAt}`, type: "timestamptz", direction: "desc" }, idDesc] };
    case "published_at_desc":
      return {
        name: sort,
        keys: [{ expr: sql`coalesce(${posts.publishedAt}, ${EPOCH})`, type: "timestamptz", direction: "desc" }, idDesc],
      };
    case "created_at_desc":
      return { name: sort, keys: [{ expr: sql`${posts.createdAt}`, type: "timestamptz", direction: "desc" }, idDesc] };
    case "title_asc":
      return {
        name: sort,
        keys: [
          { expr: sql`left(lower(${posts.title}), 60)`, type: "text", direction: "asc" },
          { expr: sql`${posts.id}`, type: "uuid", direction: "asc" },
        ],
      };
  }
}

/** Filter keadaan turunan (AdminPostState) dalam SQL; `scheduled` = published dengan published_at > now. */
function stateFilter(state: AdminPostState | undefined, now: Date): SQL | undefined {
  switch (state) {
    case undefined:
      return undefined;
    case "draft":
      return eq(posts.status, "draft");
    case "archived":
      return eq(posts.status, "archived");
    case "scheduled":
      return and(eq(posts.status, "published"), gt(posts.publishedAt, now));
    case "published":
      return and(eq(posts.status, "published"), lte(posts.publishedAt, now));
  }
}

function conflictField(field: string, message: string): AppException {
  return new AppException(409, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    fieldErrors: { [field]: [message] },
  });
}

const SLUG_TAKEN = "Slug sudah dipakai berita lain.";
const EMPTY_BODY = "Isi berita kosong setelah dibersihkan. Tulis isi berita.";

function excerptOf(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Berita untuk pengurus (F-08, F-15, kontrak admin-content): draft -> terjadwal/published -> archived dengan
 * invarian waktu terbit (berita yang pernah tampil menyimpan published_at pertamanya dan tidak dapat dijadwalkan
 * ulang). Setiap perubahan memakai If-Match pada baris yang dikunci FOR UPDATE dalam satu transaksi beserta audit
 * (AC F15-4, F17-1). Body disanitasi server (PRD 3.8); like_count hanya dipelihara trigger (AC F08-3).
 */
@Injectable()
export class PostsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly media: ContentMediaService,
    private readonly categoriesService: CategoriesService,
  ) {}

  async list(query: PostListQuery): Promise<AdminPostPage> {
    const now = this.clock.now();
    const spec = sortSpec(query.sort);
    const filter = and(
      stateFilter(query.state, now),
      query.categoryId ? eq(posts.categoryId, query.categoryId) : undefined,
      query.q ? or(ilike(posts.title, containsPattern(query.q)), ilike(posts.slug, containsPattern(query.q))) : undefined,
    );
    const after = query.cursor ? sortAfter(spec, decodeSortCursor(query.cursor, spec)) : undefined;
    const rows = await this.db
      .select({ ...summaryColumns, ...sortKeySelection(spec) })
      .from(posts)
      .leftJoin(categories, eq(categories.id, posts.categoryId))
      .leftJoin(files, and(eq(files.id, posts.coverFileId), eq(files.status, "ready")))
      .where(and(filter, after))
      .orderBy(...sortOrderBy(spec))
      .limit(query.limit + 1);
    const [total] = await this.db.select({ value: count() }).from(posts).where(filter);
    return adminPageOf(rows, query.limit, spec, Number(total?.value ?? 0), (row) => this.toSummary(row, now));
  }

  async get(id: string): Promise<AdminPost> {
    const post = await this.load(this.db, id, this.clock.now());
    if (!post) throw notFound("Berita tidak ditemukan.");
    return post;
  }

  /** Berita baru selalu draft; slug kosong dibangkitkan dari judul dan dibuat unik (kontrak adminCreatePost). */
  async create(auth: AuthContext, input: PostCreateInput): Promise<AdminPost> {
    const title = input.title.trim();
    const body = this.media.sanitize(input.body_html);
    if (!body.hasContent) throw fieldError("body_html", EMPTY_BODY);
    const base = slugify(title, POST_SLUG_MAX) || "berita";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const now = this.clock.now();
          const slug =
            input.slug ??
            (attempt === 0
              ? await this.freeSlug(tx, base)
              : `${base.slice(0, POST_SLUG_MAX - 5).replace(/-+$/g, "")}-${randomSlugSuffix()}`);
          if (input.category_id)
            await this.categoriesService.assertSelectable(tx, input.category_id, "post", "category_id");
          if (input.cover_file_id)
            await this.media.attachNew(tx, input.cover_file_id, auth.userId, "post_cover", "cover_file_id");
          await this.media.attachBodyImages(tx, body.imageFileIds, "body_html");
          const id = uuidv7();
          await tx.insert(posts).values({
            id,
            slug,
            title,
            excerpt: excerptOf(input.excerpt),
            bodyHtml: body.html,
            coverFileId: input.cover_file_id ?? null,
            categoryId: input.category_id ?? null,
            status: "draft",
            authorAdminId: auth.adminId,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
          await this.audit.write(tx, {
            action: "post.created",
            entityType: "post",
            entityId: id,
            after: {
              slug,
              title,
              category_id: input.category_id ?? null,
              cover_file_id: input.cover_file_id ?? null,
              state: "draft",
            },
          });
          return (await this.load(tx, id, now))!;
        });
      } catch (error) {
        if (!isUniqueViolation(error, "posts_slug_key")) throw error;
        if (input.slug !== undefined) throw conflictField("slug", SLUG_TAKEN);
        if (attempt >= 3) throw conflictField("slug", SLUG_TAKEN);
      }
    }
  }

  /**
   * Ubah isi berita (AC F15-4). Slug hanya selama belum pernah tampil (slug_locked); status/published_at tidak
   * berubah di sini. Cover lama yang tidak dirujuk lagi dibuang.
   */
  async update(auth: AuthContext, id: string, expectedVersion: number, input: PostUpdateInput): Promise<AdminPost> {
    const body = input.body_html === undefined ? null : this.media.sanitize(input.body_html);
    if (body && !body.hasContent) throw fieldError("body_html", EMPTY_BODY);
    try {
      return await this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const row = await this.lockCurrent(tx, id, expectedVersion, now);
        const changes: Partial<typeof posts.$inferInsert> = {};
        if (input.title !== undefined) changes.title = input.title.trim();
        if (input.slug !== undefined && input.slug !== row.slug) {
          if (postSlugLocked(row.publishedAt, now))
            throw fieldError("slug", "Slug berita yang pernah tampil ke anggota tidak dapat diubah.");
          changes.slug = input.slug;
        }
        if (input.excerpt !== undefined) changes.excerpt = excerptOf(input.excerpt);
        if (body) {
          await this.media.attachBodyImages(tx, body.imageFileIds, "body_html");
          changes.bodyHtml = body.html;
        }
        let releasedCover: string | null = null;
        if (input.cover_file_id !== undefined && input.cover_file_id !== row.coverFileId) {
          if (input.cover_file_id)
            await this.media.attachNew(tx, input.cover_file_id, auth.userId, "post_cover", "cover_file_id");
          changes.coverFileId = input.cover_file_id;
          releasedCover = row.coverFileId;
        }
        if (input.category_id !== undefined && input.category_id !== row.categoryId) {
          if (input.category_id)
            await this.categoriesService.assertSelectable(tx, input.category_id, "post", "category_id");
          changes.categoryId = input.category_id;
        }
        await tx
          .update(posts)
          .set({ ...changes, version: row.version + 1, updatedAt: now })
          .where(and(eq(posts.id, id), eq(posts.version, expectedVersion)));
        await this.media.discardIfUnreferenced(tx, releasedCover);
        await this.audit.write(tx, {
          action: "post.updated",
          entityType: "post",
          entityId: id,
          before: {
            slug: row.slug,
            title: row.title,
            category_id: row.categoryId,
            cover_file_id: row.coverFileId,
          },
          after: {
            slug: changes.slug ?? row.slug,
            title: changes.title ?? row.title,
            category_id: changes.categoryId === undefined ? row.categoryId : changes.categoryId,
            cover_file_id: changes.coverFileId === undefined ? row.coverFileId : changes.coverFileId,
            body_changed: body !== null,
            excerpt_changed: input.excerpt !== undefined,
          },
        });
        return (await this.load(tx, id, now))!;
      });
    } catch (error) {
      if (isUniqueViolation(error, "posts_slug_key")) throw conflictField("slug", SLUG_TAKEN);
      throw error;
    }
  }

  /**
   * Terbit sekarang (null) atau terjadwal (masa depan) (AC F08-1, F15-5). Berita yang pernah tampil hanya dapat
   * terbit ulang sekarang dengan Tgl Publikasi aslinya; berita tampil atau archived -> 409 VERSION_CONFLICT.
   */
  async publish(id: string, expectedVersion: number, requestedAt: Date | null): Promise<AdminPost> {
    const requestNow = this.clock.now();
    if (requestedAt && requestedAt.getTime() < requestNow.getTime())
      throw fieldError(
        "published_at",
        "Waktu terbit tidak boleh di masa lalu. Kosongkan untuk menerbitkan sekarang.",
      );
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const row = await this.lockCurrent(tx, id, expectedVersion, now);
      const state = postState(row.status, row.publishedAt, now);
      if (state === "archived" || state === "published") throw versionConflict(await this.load(tx, id, now));
      const future = requestedAt && requestedAt.getTime() > now.getTime() ? requestedAt : null;
      let publishedAt: Date;
      if (state === "draft" && row.publishedAt) {
        // Pernah tampil (draft hasil restore): kembali tampil dengan Tgl Publikasi aslinya, tidak dapat dijadwalkan.
        if (future)
          throw conflictField(
            "published_at",
            "Berita yang pernah tampil hanya dapat diterbitkan ulang sekarang dengan tanggal publikasi aslinya.",
          );
        publishedAt = row.publishedAt;
      } else {
        publishedAt = future ?? now;
      }
      await tx
        .update(posts)
        .set({ status: "published", publishedAt, version: row.version + 1, updatedAt: now })
        .where(and(eq(posts.id, id), eq(posts.version, expectedVersion)));
      await this.audit.write(tx, {
        action: future ? "post.scheduled" : "post.published",
        entityType: "post",
        entityId: id,
        before: { state, published_at: row.publishedAt },
        after: { state: future ? "scheduled" : "published", published_at: publishedAt },
      });
      return (await this.load(tx, id, now))!;
    });
  }

  /** Batalkan jadwal: berita terjadwal (belum pernah tampil, belum diumumkan) kembali draft (AC F15-5). */
  async unschedule(id: string, expectedVersion: number): Promise<AdminPost> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const row = await this.lockCurrent(tx, id, expectedVersion, now);
      const [updated] = await tx
        .update(posts)
        .set({ status: "draft", publishedAt: null, version: row.version + 1, updatedAt: now })
        .where(
          and(
            eq(posts.id, id),
            eq(posts.version, expectedVersion),
            eq(posts.status, "published"),
            gt(posts.publishedAt, now),
            sql`${posts.announcedAt} is null`,
          ),
        )
        .returning({ id: posts.id });
      // Jadwal sudah lewat (berita sudah tampil) atau keadaan lain: muat ulang lalu pakai arsip.
      if (!updated) throw versionConflict(await this.load(tx, id, now));
      await this.audit.write(tx, {
        action: "post.unscheduled",
        entityType: "post",
        entityId: id,
        before: { state: "scheduled", published_at: row.publishedAt },
        after: { state: "draft", published_at: null },
      });
      return (await this.load(tx, id, now))!;
    });
  }

  /**
   * Arsipkan dari draft/terjadwal/published (AC F08-1, F15-5): hilang dari feed dan job pengumuman tidak pernah
   * memprosesnya; jadwal yang belum tiba dikosongkan agar tidak terbaca "pernah tampil".
   */
  async archive(id: string, expectedVersion: number): Promise<AdminPost> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const row = await this.lockCurrent(tx, id, expectedVersion, now);
      const state = postState(row.status, row.publishedAt, now);
      if (state === "archived") throw versionConflict(await this.load(tx, id, now));
      const publishedAt = row.publishedAt && row.publishedAt.getTime() > now.getTime() ? null : row.publishedAt;
      await tx
        .update(posts)
        .set({ status: "archived", publishedAt, version: row.version + 1, updatedAt: now })
        .where(and(eq(posts.id, id), eq(posts.version, expectedVersion)));
      await this.audit.write(tx, {
        action: "post.archived",
        entityType: "post",
        entityId: id,
        before: { state, published_at: row.publishedAt },
        after: { state: "archived", published_at: publishedAt },
      });
      return (await this.load(tx, id, now))!;
    });
  }

  /** Pulihkan archived -> draft; tidak pernah langsung tampil, published_at/announced_at tetap (AC F15-5). */
  async restore(id: string, expectedVersion: number): Promise<AdminPost> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const row = await this.lockCurrent(tx, id, expectedVersion, now);
      if (row.status !== "archived") throw versionConflict(await this.load(tx, id, now));
      await tx
        .update(posts)
        .set({ status: "draft", version: row.version + 1, updatedAt: now })
        .where(and(eq(posts.id, id), eq(posts.version, expectedVersion)));
      await this.audit.write(tx, {
        action: "post.restored",
        entityType: "post",
        entityId: id,
        before: { state: "archived" },
        after: { state: "draft", published_at: row.publishedAt },
      });
      return (await this.load(tx, id, now))!;
    });
  }

  /**
   * Hapus berita draft/archived (PRD 4.5): like ikut terhapus (kaskade, penghitung oleh trigger), banner yang
   * menunjuknya menjadi tidak tersedia (AC F08-2), cover yang tidak dirujuk lagi dibuang. Penghapusan kaskade
   * post_likes dapat bertabrakan urutan kunci dengan penghapusan akun bersamaan (40P01): diulang utuh.
   */
  async remove(id: string, expectedVersion: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.transaction(async (tx) => {
          const now = this.clock.now();
          const row = await this.lockCurrent(tx, id, expectedVersion, now);
          const state = postState(row.status, row.publishedAt, now);
          if (state !== "draft" && state !== "archived") throw versionConflict(await this.load(tx, id, now));
          await tx.delete(posts).where(and(eq(posts.id, id), eq(posts.version, expectedVersion)));
          await this.media.discardIfUnreferenced(tx, row.coverFileId);
          await this.audit.write(tx, {
            action: "post.deleted",
            entityType: "post",
            entityId: id,
            before: { slug: row.slug, title: row.title, state, like_count: row.likeCount },
          });
        });
        return;
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt >= 2) throw error;
      }
    }
  }

  /** Mengunci baris berita (FOR UPDATE) dan memeriksa If-Match; 404 bila tidak ada, 409 dengan `current`. */
  private async lockCurrent(tx: Tx, id: string, expectedVersion: number, now: Date): Promise<PostRow> {
    const [row] = await tx.select().from(posts).where(eq(posts.id, id)).for("update");
    if (!row) throw notFound("Berita tidak ditemukan.");
    if (row.version !== expectedVersion) throw versionConflict(await this.load(tx, id, now));
    return row;
  }

  /** AdminPost lengkap (kontrak), atau null. */
  async load(db: DbOrTx, id: string, now: Date): Promise<AdminPost | null> {
    const [row] = await db
      .select({
        ...summaryColumns,
        excerpt: posts.excerpt,
        bodyHtml: posts.bodyHtml,
        announcedAt: posts.announcedAt,
        authorId: admins.id,
        authorName: admins.displayName,
      })
      .from(posts)
      .leftJoin(categories, eq(categories.id, posts.categoryId))
      .leftJoin(files, and(eq(files.id, posts.coverFileId), eq(files.status, "ready")))
      .leftJoin(admins, eq(admins.id, posts.authorAdminId))
      .where(eq(posts.id, id));
    if (!row) return null;
    return {
      ...this.toSummary(row, now),
      excerpt: row.excerpt,
      body_html: row.bodyHtml,
      announced_at: iso(row.announcedAt),
      slug_locked: postSlugLocked(row.publishedAt, now),
      author: row.authorId ? { admin_id: row.authorId, display_name: row.authorName ?? "" } : null,
    };
  }

  private toSummary(row: SummaryRow, now: Date): AdminPostSummary {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      state: postState(row.status, row.publishedAt, now),
      category:
        row.categoryId && row.categorySlug && row.categoryLabel
          ? { id: row.categoryId, slug: row.categorySlug, label: row.categoryLabel }
          : null,
      cover: row.coverId ? { file_id: row.coverId, url: this.media.publicUrl(row.coverId) } : null,
      published_at: iso(row.publishedAt),
      like_count: row.likeCount,
      version: String(row.version),
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    };
  }

  private async freeSlug(db: DbOrTx, base: string): Promise<string> {
    const rows = await db
      .select({ slug: posts.slug })
      .from(posts)
      .where(or(eq(posts.slug, base), sql`${posts.slug} like ${`${base}-%`}`));
    return nextFreeSlug(base, new Set(rows.map((r) => r.slug)), POST_SLUG_MAX);
  }
}
