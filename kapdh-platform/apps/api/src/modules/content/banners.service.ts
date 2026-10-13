import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { banners, categories, events, pages, posts } from "@kapdh/database";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { isUuid } from "../../core/validation/validate.js";
import { ContentMediaService } from "./content-media.service.js";
import {
  type AdminBannerState,
  adminPageOf,
  bannerState,
  type ContentCategoryRef,
  containsPattern,
  decodeSortCursor,
  iso,
  SLUG_PATTERN,
  type SortSpec,
  sortAfter,
  sortKeySelection,
  sortOrderBy,
} from "./content.util.js";
import { safeHttpsUrl } from "./html-sanitizer.js";

type AdminBanner = components["schemas"]["AdminBanner"];
type AdminBannerPage = components["schemas"]["AdminBannerPage"];
type AdminBannerTarget = components["schemas"]["AdminBannerTarget"];
export type AdminBannerSort = components["schemas"]["AdminBannerSort"];
export type BannerTargetType = components["schemas"]["BannerTargetType"];
type HomeBanner = components["schemas"]["HomeBanner"];
type BannerRow = typeof banners.$inferSelect;

/** Maksimal banner di Beranda (kontrak `Home.banners` maxItems 10). */
export const HOME_BANNER_LIMIT = 10;

export interface BannerListQuery {
  q?: string;
  state?: AdminBannerState;
  sort: AdminBannerSort;
  cursor?: string;
  limit: number;
}

export interface BannerCreateInput {
  title: string;
  image_file_id: string;
  target_type: BannerTargetType;
  target_value: string | null;
  sort_order: number;
  starts_at: Date;
  ends_at: Date | null;
  active: boolean;
}

export type BannerUpdateInput = Partial<BannerCreateInput>;

function sortSpec(sort: AdminBannerSort): SortSpec {
  switch (sort) {
    case "sort_order_asc":
      return {
        name: sort,
        keys: [
          { expr: sql`${banners.sortOrder}`, type: "int", direction: "asc" },
          { expr: sql`${banners.startsAt}`, type: "timestamptz", direction: "desc" },
          { expr: sql`${banners.id}`, type: "uuid", direction: "asc" },
        ],
      };
    case "starts_at_desc":
      return {
        name: sort,
        keys: [
          { expr: sql`${banners.startsAt}`, type: "timestamptz", direction: "desc" },
          { expr: sql`${banners.id}`, type: "uuid", direction: "desc" },
        ],
      };
    case "updated_at_desc":
      return {
        name: sort,
        keys: [
          { expr: sql`${banners.updatedAt}`, type: "timestamptz", direction: "desc" },
          { expr: sql`${banners.id}`, type: "uuid", direction: "desc" },
        ],
      };
    case "title_asc":
      return {
        name: sort,
        keys: [
          { expr: sql`left(lower(${banners.title}), 60)`, type: "text", direction: "asc" },
          { expr: sql`${banners.id}`, type: "uuid", direction: "asc" },
        ],
      };
  }
}

/** Banner tampil: aktif dan di dalam jendela `starts_at <= now < ends_at` (ends_at null = tanpa akhir; AC F08-2). */
export function liveBanner(now: Date): SQL {
  return and(
    eq(banners.active, true),
    lte(banners.startsAt, now),
    or(isNull(banners.endsAt), gt(banners.endsAt, now)),
  )!;
}

function stateFilter(state: AdminBannerState | undefined, now: Date): SQL | undefined {
  switch (state) {
    case undefined:
      return undefined;
    case "inactive":
      return eq(banners.active, false);
    case "ended":
      return and(eq(banners.active, true), lte(banners.endsAt, now));
    case "scheduled":
      return and(eq(banners.active, true), gt(banners.startsAt, now));
    case "live":
      return liveBanner(now);
  }
}

interface ResolvedTarget {
  type: BannerTargetType;
  value: string | null;
  available: boolean;
  label: string | null;
  route: string | null;
  category: ContentCategoryRef | null;
}

function categoryRef(
  id: string | null,
  slug: string | null,
  label: string | null,
): ContentCategoryRef | null {
  return id && slug && label ? { id, slug, label } : null;
}

/**
 * Banner Beranda (F-08, AC F08-2): media, target tervalidasi, urutan dan jendela tayang. Target diselesaikan saat
 * dibaca: berita/event/halaman yang sudah tidak tersedia ditandai `available = false` sehingga klien menampilkan
 * pesan yang jelas alih-alih layar kosong.
 */
@Injectable()
export class BannersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly media: ContentMediaService,
  ) {}

  /** Banner tampil untuk Beranda, urut sort_order naik lalu starts_at turun, maksimal 10. */
  async home(now: Date): Promise<HomeBanner[]> {
    const rows = await this.db
      .select()
      .from(banners)
      .where(liveBanner(now))
      .orderBy(asc(banners.sortOrder), desc(banners.startsAt), asc(banners.id))
      .limit(HOME_BANNER_LIMIT);
    const targets = await this.resolveTargets(this.db, rows, now);
    return rows.map((row) => {
      const target = targets.get(row.id)!;
      return {
        id: row.id,
        title: row.title,
        image_url: this.media.publicUrl(row.imageFileId),
        target: {
          type: target.type,
          available: target.available,
          route: target.available ? target.route : null,
          url: target.type === "url" ? target.value : null,
          external: target.type === "url",
        },
      };
    });
  }

  async list(query: BannerListQuery): Promise<AdminBannerPage> {
    const now = this.clock.now();
    const spec = sortSpec(query.sort);
    const filter = and(
      stateFilter(query.state, now),
      query.q ? ilike(banners.title, containsPattern(query.q)) : undefined,
    );
    const after = query.cursor ? sortAfter(spec, decodeSortCursor(query.cursor, spec)) : undefined;
    const rows = await this.db
      .select({ banner: banners, ...sortKeySelection(spec) })
      .from(banners)
      .where(and(filter, after))
      .orderBy(...sortOrderBy(spec))
      .limit(query.limit + 1);
    const [total] = await this.db.select({ value: count() }).from(banners).where(filter);
    const targets = await this.resolveTargets(
      this.db,
      rows.map((row) => row.banner),
      now,
    );
    return adminPageOf(rows, query.limit, spec, Number(total?.value ?? 0), (row) =>
      this.toAdminBanner(row.banner, targets.get(row.banner.id)!, now),
    );
  }

  async get(id: string): Promise<AdminBanner> {
    const banner = await this.load(this.db, id, this.clock.now());
    if (!banner) throw notFound("Banner tidak ditemukan.");
    return banner;
  }

  async create(auth: AuthContext, input: BannerCreateInput): Promise<AdminBanner> {
    if (input.ends_at && input.ends_at.getTime() <= input.starts_at.getTime())
      throw fieldError("ends_at", "Waktu selesai harus setelah waktu mulai.");
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const targetValue = await this.validateTarget(tx, input.target_type, input.target_value);
      await this.media.attachNew(tx, input.image_file_id, auth.userId, "banner_image", "image_file_id");
      const id = uuidv7();
      await tx.insert(banners).values({
        id,
        title: input.title.trim(),
        imageFileId: input.image_file_id,
        targetType: input.target_type,
        targetValue,
        sortOrder: input.sort_order,
        startsAt: input.starts_at,
        endsAt: input.ends_at,
        active: input.active,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit.write(tx, {
        action: "banner.created",
        entityType: "banner",
        entityId: id,
        after: {
          title: input.title.trim(),
          image_file_id: input.image_file_id,
          target_type: input.target_type,
          target_value: targetValue,
          sort_order: input.sort_order,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
          active: input.active,
        },
      });
      return (await this.load(tx, id, now))!;
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
    input: BannerUpdateInput,
  ): Promise<AdminBanner> {
    if ((input.target_type === undefined) !== (input.target_value === undefined))
      throw fieldError(
        input.target_type === undefined ? "target_type" : "target_value",
        "Jenis dan nilai target wajib dikirim bersama.",
      );
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const row = await this.lockCurrent(tx, id, expectedVersion, now);
      const startsAt = input.starts_at ?? row.startsAt;
      const endsAt = input.ends_at === undefined ? row.endsAt : input.ends_at;
      if (endsAt && endsAt.getTime() <= startsAt.getTime())
        throw fieldError("ends_at", "Waktu selesai harus setelah waktu mulai.");
      const changes: Partial<typeof banners.$inferInsert> = {};
      if (input.title !== undefined) changes.title = input.title.trim();
      if (input.target_type !== undefined) {
        changes.targetType = input.target_type;
        changes.targetValue = await this.validateTarget(tx, input.target_type, input.target_value ?? null);
      }
      if (input.sort_order !== undefined) changes.sortOrder = input.sort_order;
      if (input.starts_at !== undefined) changes.startsAt = input.starts_at;
      if (input.ends_at !== undefined) changes.endsAt = input.ends_at;
      if (input.active !== undefined) changes.active = input.active;
      let releasedImage: string | null = null;
      if (input.image_file_id !== undefined && input.image_file_id !== row.imageFileId) {
        await this.media.attachNew(tx, input.image_file_id, auth.userId, "banner_image", "image_file_id");
        changes.imageFileId = input.image_file_id;
        releasedImage = row.imageFileId;
      }
      await tx
        .update(banners)
        .set({ ...changes, version: row.version + 1, updatedAt: now })
        .where(and(eq(banners.id, id), eq(banners.version, expectedVersion)));
      // Gambar lama dilepas setelah banner menunjuk gambar baru (FK RESTRICT), lalu dibuang bila tidak dirujuk.
      await this.media.discardIfUnreferenced(tx, releasedImage);
      await this.audit.write(tx, {
        action: "banner.updated",
        entityType: "banner",
        entityId: id,
        before: this.auditView(row),
        after: this.auditView({ ...row, ...changes } as BannerRow),
      });
      return (await this.load(tx, id, now))!;
    });
  }

  async remove(id: string, expectedVersion: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const row = await this.lockCurrent(tx, id, expectedVersion, now);
      await tx.delete(banners).where(and(eq(banners.id, id), eq(banners.version, expectedVersion)));
      await this.media.discardIfUnreferenced(tx, row.imageFileId);
      await this.audit.write(tx, {
        action: "banner.deleted",
        entityType: "banner",
        entityId: id,
        before: this.auditView(row),
      });
    });
  }

  /**
   * Validasi target (tabel banners, kontrak adminCreateBanner): `none` tanpa nilai; `post`/`event` = id yang ada;
   * `page` = slug halaman yang ada; `url` = tautan https tanpa kredensial. Mengembalikan nilai ternormalisasi.
   */
  private async validateTarget(tx: Tx, type: BannerTargetType, raw: string | null): Promise<string | null> {
    const value = raw?.trim() ?? "";
    const field = "target_value";
    switch (type) {
      case "none":
        if (value.length > 0) throw fieldError(field, "Banner tanpa target tidak memakai nilai target.");
        return null;
      case "post": {
        const [row] = isUuid(value)
          ? await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, value.toLowerCase()))
          : [];
        if (!row) throw fieldError(field, "Berita tujuan tidak ditemukan.");
        return row.id;
      }
      case "event": {
        const [row] = isUuid(value)
          ? await tx.select({ id: events.id }).from(events).where(eq(events.id, value.toLowerCase()))
          : [];
        if (!row) throw fieldError(field, "Event tujuan tidak ditemukan.");
        return row.id;
      }
      case "page": {
        const [row] =
          value.length <= 120 && SLUG_PATTERN.test(value)
            ? await tx.select({ slug: pages.slug }).from(pages).where(eq(pages.slug, value))
            : [];
        if (!row) throw fieldError(field, "Halaman tujuan tidak ditemukan.");
        return row.slug;
      }
      case "url": {
        const url = safeHttpsUrl(value);
        if (!url)
          throw fieldError(field, "Tautan wajib diawali https:// dan tidak memuat nama pengguna/sandi.");
        return url;
      }
    }
  }

  /**
   * Menyelesaikan target banyak banner sekaligus (AC F08-2). Berita tersedia bila published dan published_at <= now;
   * event bila open/closed dan belum berakhir (draft, dibatalkan, selesai = tidak tersedia); halaman bila pernah
   * terbit. Target yang dihapus = tidak tersedia.
   */
  private async resolveTargets(
    db: DbOrTx,
    rows: BannerRow[],
    now: Date,
  ): Promise<Map<string, ResolvedTarget>> {
    const idsOf = (type: BannerTargetType) => [
      ...new Set(
        rows.filter((r) => r.targetType === type && isUuid(r.targetValue)).map((r) => r.targetValue!),
      ),
    ];
    const postIds = idsOf("post");
    const eventIds = idsOf("event");
    const pageSlugs = [...new Set(rows.filter((r) => r.targetType === "page").map((r) => r.targetValue!))];
    const postRows = postIds.length
      ? await db
          .select({
            id: posts.id,
            slug: posts.slug,
            title: posts.title,
            status: posts.status,
            publishedAt: posts.publishedAt,
            categoryId: categories.id,
            categorySlug: categories.slug,
            categoryLabel: categories.label,
          })
          .from(posts)
          .leftJoin(categories, eq(categories.id, posts.categoryId))
          .where(inArray(posts.id, postIds))
      : [];
    const eventRows = eventIds.length
      ? await db
          .select({
            id: events.id,
            title: events.title,
            status: events.status,
            endsAt: events.endsAt,
            categoryId: categories.id,
            categorySlug: categories.slug,
            categoryLabel: categories.label,
          })
          .from(events)
          .leftJoin(categories, eq(categories.id, events.categoryId))
          .where(inArray(events.id, eventIds))
      : [];
    const pageRows = pageSlugs.length
      ? await db
          .select({
            slug: pages.slug,
            title: pages.title,
            publishedTitle: pages.publishedTitle,
            publishedVersion: pages.publishedVersion,
          })
          .from(pages)
          .where(inArray(pages.slug, pageSlugs))
      : [];

    const result = new Map<string, ResolvedTarget>();
    for (const row of rows) {
      const base = { type: row.targetType, value: row.targetValue };
      switch (row.targetType) {
        case "none":
        case "url":
          result.set(row.id, { ...base, available: true, label: null, route: null, category: null });
          break;
        case "post": {
          const post = postRows.find((p) => p.id === row.targetValue);
          const available = Boolean(
            post && post.status === "published" && post.publishedAt && post.publishedAt <= now,
          );
          result.set(row.id, {
            ...base,
            available,
            label: post?.title ?? null,
            route: available ? `/news/${post!.slug}` : null,
            category: post ? categoryRef(post.categoryId, post.categorySlug, post.categoryLabel) : null,
          });
          break;
        }
        case "event": {
          const event = eventRows.find((e) => e.id === row.targetValue);
          const available = Boolean(
            event && (event.status === "open" || event.status === "closed") && event.endsAt > now,
          );
          result.set(row.id, {
            ...base,
            available,
            label: event?.title ?? null,
            route: available ? `/events/${event!.id}` : null,
            category: event ? categoryRef(event.categoryId, event.categorySlug, event.categoryLabel) : null,
          });
          break;
        }
        case "page": {
          const page = pageRows.find((p) => p.slug === row.targetValue);
          const available = Boolean(page && page.publishedVersion !== null);
          result.set(row.id, {
            ...base,
            available,
            label: page ? (page.publishedTitle ?? page.title) : null,
            route: available ? `/legal/${page!.slug}` : null,
            category: null,
          });
          break;
        }
      }
    }
    return result;
  }

  private async lockCurrent(tx: Tx, id: string, expectedVersion: number, now: Date): Promise<BannerRow> {
    const [row] = await tx.select().from(banners).where(eq(banners.id, id)).for("update");
    if (!row) throw notFound("Banner tidak ditemukan.");
    if (row.version !== expectedVersion) throw versionConflict(await this.load(tx, id, now));
    return row;
  }

  private async load(db: DbOrTx, id: string, now: Date): Promise<AdminBanner | null> {
    const [row] = await db.select().from(banners).where(eq(banners.id, id));
    if (!row) return null;
    const targets = await this.resolveTargets(db, [row], now);
    return this.toAdminBanner(row, targets.get(row.id)!, now);
  }

  private toAdminBanner(row: BannerRow, target: ResolvedTarget, now: Date): AdminBanner {
    const adminTarget: AdminBannerTarget = {
      type: target.type,
      value: target.value,
      available: target.available,
      label: target.label,
      route: target.route,
      category: target.category,
    };
    return {
      id: row.id,
      title: row.title,
      image: { file_id: row.imageFileId, url: this.media.publicUrl(row.imageFileId) },
      target: adminTarget,
      sort_order: row.sortOrder,
      starts_at: iso(row.startsAt),
      ends_at: iso(row.endsAt),
      active: row.active,
      state: bannerState(row, now),
      version: String(row.version),
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    };
  }

  private auditView(row: BannerRow) {
    return {
      title: row.title,
      image_file_id: row.imageFileId,
      target_type: row.targetType,
      target_value: row.targetValue,
      sort_order: row.sortOrder,
      starts_at: row.startsAt,
      ends_at: row.endsAt,
      active: row.active,
    };
  }
}
