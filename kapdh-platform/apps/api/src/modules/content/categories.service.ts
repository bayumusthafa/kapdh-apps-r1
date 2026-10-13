import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { categories } from "@kapdh/database";
import { and, asc, count, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { isFkViolation, isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { CLOCK, DB } from "../../core/tokens.js";
import {
  adminPageOf,
  CATEGORY_SLUG_MAX,
  containsPattern,
  decodeSortCursor,
  iso,
  nextFreeSlug,
  randomSlugSuffix,
  slugify,
  type SortSpec,
  sortAfter,
  sortKeySelection,
  sortOrderBy,
} from "./content.util.js";

export type ContentCategoryKind = components["schemas"]["ContentCategoryKind"];
type ContentCategory = components["schemas"]["ContentCategory"];
type ContentCategoryList = components["schemas"]["ContentCategoryList"];
type AdminContentCategory = components["schemas"]["AdminContentCategory"];
type AdminContentCategoryPage = components["schemas"]["AdminContentCategoryPage"];
export type AdminContentCategorySort = components["schemas"]["AdminContentCategorySort"];
type CategoryRow = typeof categories.$inferSelect;

export interface CategoryListQuery {
  active?: boolean;
  q?: string;
  sort: AdminContentCategorySort;
  cursor?: string;
  limit: number;
}

export interface CategoryCreateInput {
  label: string;
  slug?: string;
  sort_order: number;
  active: boolean;
}

export type CategoryUpdateInput = Partial<CategoryCreateInput>;

const CATEGORY_IN_USE =
  "Kategori masih dipakai sehingga tidak dapat dihapus. Nonaktifkan kategori agar tidak dipilih lagi.";

/**
 * Jumlah berita (semua keadaan) atau event (semua status) yang memakai kategori (kontrak `usage_count`). Subkueri
 * berkorelasi ditulis dengan alias eksplisit: Drizzle tidak mengkualifikasi kolom tabel utama pada kueri tanpa join,
 * sehingga `${categories.id}` di dalam subkueri akan terbaca sebagai kolom tabel subkueri.
 */
function usageCount(kind: ContentCategoryKind): SQL<number> {
  const table = kind === "post" ? sql.raw(`"app"."posts"`) : sql.raw(`"app"."events"`);
  return sql<number>`(select count(*) from ${table} as "usage_ref" where "usage_ref"."category_id" = "categories"."id")::int`;
}

function sortSpec(kind: ContentCategoryKind, sort: AdminContentCategorySort): SortSpec {
  const label = { expr: sql`left(lower(${categories.label}), 60)`, type: "text", direction: "asc" } as const;
  switch (sort) {
    case "sort_order_asc":
      return {
        name: sort,
        keys: [
          { expr: sql`${categories.sortOrder}`, type: "int", direction: "asc" },
          label,
          { expr: sql`${categories.id}`, type: "uuid", direction: "asc" },
        ],
      };
    case "label_asc":
      return { name: sort, keys: [label, { expr: sql`${categories.id}`, type: "uuid", direction: "asc" }] };
    case "usage_desc":
      return {
        name: sort,
        keys: [
          { expr: usageCount(kind), type: "int", direction: "desc" },
          { expr: sql`${categories.id}`, type: "uuid", direction: "desc" },
        ],
      };
    case "updated_at_desc":
      return {
        name: sort,
        keys: [
          { expr: sql`${categories.updatedAt}`, type: "timestamptz", direction: "desc" },
          { expr: sql`${categories.id}`, type: "uuid", direction: "desc" },
        ],
      };
  }
}

function slugTaken(): AppException {
  return new AppException(409, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    fieldErrors: { slug: ["Slug sudah dipakai kategori lain dengan jenis yang sama."] },
  });
}

/**
 * Kategori berita dan event (guideline "Manajemen Kategori" p13/p14; F-08, F-15). Jenis kategori ditentukan path
 * (kategori berita: content.manage; kategori event: events.manage); id berjenis lain -> 404. Kategori yang dipakai
 * tidak dapat dihapus (FK RESTRICT ditegakkan database), hanya dinonaktifkan; label historis tetap tampil.
 */
@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** GET /categories: kategori aktif untuk tab/filter, urut sort_order lalu label (F-08, F-09). */
  async listActive(kind: ContentCategoryKind | undefined): Promise<ContentCategoryList> {
    const rows = await this.db
      .select()
      .from(categories)
      .where(and(eq(categories.active, true), kind ? eq(categories.kind, kind) : undefined))
      .orderBy(asc(categories.sortOrder), asc(sql`lower(${categories.label})`), asc(categories.id));
    return { items: rows.map((row) => this.toCategory(row)) };
  }

  /**
   * Kategori yang boleh DIPILIH BARU pada berita/event: ada, jenisnya sesuai, dan aktif (kategori nonaktif hanya
   * boleh dipertahankan). Selain itu 400 pada `field`. Baris dikunci FOR KEY SHARE agar tidak terhapus sebelum commit.
   */
  async assertSelectable(
    tx: Tx,
    categoryId: string,
    kind: ContentCategoryKind,
    field: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ active: categories.active })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.kind, kind)))
      .for("key share");
    if (!row) throw fieldError(field, "Kategori tidak ditemukan.");
    if (!row.active) throw fieldError(field, "Kategori sudah dinonaktifkan dan tidak dapat dipilih.");
  }

  async adminList(kind: ContentCategoryKind, query: CategoryListQuery): Promise<AdminContentCategoryPage> {
    const spec = sortSpec(kind, query.sort);
    const filter = and(
      eq(categories.kind, kind),
      query.active === undefined ? undefined : eq(categories.active, query.active),
      query.q
        ? or(
            ilike(categories.label, containsPattern(query.q)),
            ilike(categories.slug, containsPattern(query.q)),
          )
        : undefined,
    );
    const after = query.cursor ? sortAfter(spec, decodeSortCursor(query.cursor, spec)) : undefined;
    const rows = await this.db
      .select({ category: categories, usage: usageCount(kind), ...sortKeySelection(spec) })
      .from(categories)
      .where(and(filter, after))
      .orderBy(...sortOrderBy(spec))
      .limit(query.limit + 1);
    const [total] = await this.db.select({ value: count() }).from(categories).where(filter);
    return adminPageOf(rows, query.limit, spec, Number(total?.value ?? 0), (row) =>
      this.toAdminCategory(row.category, Number(row.usage)),
    );
  }

  async adminGet(kind: ContentCategoryKind, id: string): Promise<AdminContentCategory> {
    const current = await this.load(this.db, kind, id);
    if (!current) throw notFound("Kategori tidak ditemukan.");
    return current;
  }

  async create(kind: ContentCategoryKind, input: CategoryCreateInput): Promise<AdminContentCategory> {
    const label = input.label.trim();
    const base = slugify(label, CATEGORY_SLUG_MAX) || "kategori";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const slug =
            input.slug ??
            (attempt === 0
              ? await this.freeSlug(tx, kind, base)
              : `${base.slice(0, CATEGORY_SLUG_MAX - 5).replace(/-+$/g, "")}-${randomSlugSuffix()}`);
          const now = this.clock.now();
          const [row] = await tx
            .insert(categories)
            .values({
              id: uuidv7(),
              kind,
              label,
              slug,
              active: input.active,
              sortOrder: input.sort_order,
              version: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          await this.audit.write(tx, {
            action: "category.created",
            entityType: "category",
            entityId: row!.id,
            after: { kind, label, slug, active: input.active, sort_order: input.sort_order },
          });
          return this.toAdminCategory(row!, 0);
        });
      } catch (error) {
        if (!isUniqueViolation(error, "categories_kind_slug_key")) throw error;
        if (input.slug !== undefined || attempt >= 3) throw slugTaken();
      }
    }
  }

  async update(
    kind: ContentCategoryKind,
    id: string,
    expectedVersion: number,
    input: CategoryUpdateInput,
  ): Promise<AdminContentCategory> {
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.lock(tx, kind, id);
        if (row.version !== expectedVersion) throw versionConflict(await this.load(tx, kind, id));
        const now = this.clock.now();
        const changes = {
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        };
        await tx
          .update(categories)
          .set({ ...changes, version: row.version + 1, updatedAt: now })
          .where(and(eq(categories.id, id), eq(categories.version, expectedVersion)));
        await this.audit.write(tx, {
          action: "category.updated",
          entityType: "category",
          entityId: id,
          before: { label: row.label, slug: row.slug, sort_order: row.sortOrder, active: row.active },
          after: {
            label: changes.label ?? row.label,
            slug: changes.slug ?? row.slug,
            sort_order: changes.sortOrder ?? row.sortOrder,
            active: changes.active ?? row.active,
          },
        });
        return (await this.load(tx, kind, id))!;
      });
    } catch (error) {
      if (isUniqueViolation(error, "categories_kind_slug_key")) throw slugTaken();
      throw error;
    }
  }

  /** Hapus kategori yang belum dipakai; dipakai -> 409 VALIDATION_ERROR (FK RESTRICT, SQLSTATE 23503/23001). */
  async remove(kind: ContentCategoryKind, id: string, expectedVersion: number): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const row = await this.lock(tx, kind, id);
        if (row.version !== expectedVersion) throw versionConflict(await this.load(tx, kind, id));
        await tx.delete(categories).where(eq(categories.id, id));
        await this.audit.write(tx, {
          action: "category.deleted",
          entityType: "category",
          entityId: id,
          before: { kind, label: row.label, slug: row.slug },
        });
      });
    } catch (error) {
      if (isFkViolation(error))
        throw new AppException(409, "VALIDATION_ERROR", CATEGORY_IN_USE, {
          fieldErrors: { _: [CATEGORY_IN_USE] },
        });
      throw error;
    }
  }

  private async lock(tx: Tx, kind: ContentCategoryKind, id: string): Promise<CategoryRow> {
    const [row] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.kind, kind)))
      .for("update");
    if (!row) throw notFound("Kategori tidak ditemukan.");
    return row;
  }

  private async load(
    db: DbOrTx,
    kind: ContentCategoryKind,
    id: string,
  ): Promise<AdminContentCategory | null> {
    const [row] = await db
      .select({ category: categories, usage: usageCount(kind) })
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.kind, kind)));
    return row ? this.toAdminCategory(row.category, Number(row.usage)) : null;
  }

  private async freeSlug(db: DbOrTx, kind: ContentCategoryKind, base: string): Promise<string> {
    const rows = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(
        and(
          eq(categories.kind, kind),
          or(eq(categories.slug, base), sql`${categories.slug} like ${`${base}-%`}`),
        ),
      );
    return nextFreeSlug(base, new Set(rows.map((r) => r.slug)), CATEGORY_SLUG_MAX);
  }

  private toCategory(row: CategoryRow): ContentCategory {
    return {
      id: row.id,
      kind: row.kind,
      slug: row.slug,
      label: row.label,
      sort_order: row.sortOrder,
    };
  }

  private toAdminCategory(row: CategoryRow, usage: number): AdminContentCategory {
    return {
      ...this.toCategory(row),
      active: row.active,
      usage_count: usage,
      version: String(row.version),
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    };
  }
}
