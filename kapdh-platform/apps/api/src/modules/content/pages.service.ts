import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins, appSettings, pages } from "@kapdh/database";
import { and, asc, count, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { AUDIT_DOCUMENT_LIMITS } from "../../core/audit/sanitize.js";
import { isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { legalConsentVersions } from "../../core/settings/legal-consent.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { ContentMediaService } from "./content-media.service.js";
import {
  adminPageOf,
  containsPattern,
  decodeSortCursor,
  iso,
  isSystemPage,
  legalDocumentOf,
  legalSettingField,
  type SortSpec,
  sortAfter,
  sortKeySelection,
  sortOrderBy,
  SYSTEM_PAGES,
} from "./content.util.js";

type AdminInfoPage = components["schemas"]["AdminInfoPage"];
type AdminInfoPageSummary = components["schemas"]["AdminInfoPageSummary"];
type AdminInfoPageList = components["schemas"]["AdminInfoPageList"];
export type AdminInfoPageSort = components["schemas"]["AdminInfoPageSort"];
type PublicPage = components["schemas"]["PublicPage"];
type PublicPageList = components["schemas"]["PublicPageList"];
type PageRow = typeof pages.$inferSelect;

export interface PageListQuery {
  q?: string;
  sort: AdminInfoPageSort;
  cursor?: string;
  limit: number;
}

export interface PageCreateInput {
  slug: string;
  title: string;
  body_html: string;
}

export type PageUpdateInput = Partial<PageCreateInput>;

const EPOCH = sql`'1970-01-01T00:00:00Z'::timestamptz`;
const EMPTY_BODY = "Isi halaman kosong setelah dibersihkan. Tulis isi halaman.";

/** Peringkat halaman baku menurut urutan seed (PRD 8.2), lalu halaman lain. */
const SYSTEM_RANK = sql.raw(
  `case "pages"."slug" ${SYSTEM_PAGES.map((page, i) => `when '${page.slug}' then ${i}`).join(" ")} else ${SYSTEM_PAGES.length} end`,
);
/** Urutan publik: dokumen legal (privacy, terms, community) lebih dahulu, lalu halaman lain menurut judul. */
const LEGAL_RANK = sql.raw(
  `case "pages"."slug" ${SYSTEM_PAGES.filter((page) => page.legal)
    .map((page, i) => `when '${page.slug}' then ${i}`)
    .join(" ")} else 9 end`,
);

function sortSpec(sort: AdminInfoPageSort): SortSpec {
  const title = { expr: sql`left(lower(${pages.title}), 60)`, type: "text", direction: "asc" } as const;
  switch (sort) {
    case "system_first":
      return {
        name: sort,
        keys: [
          { expr: SYSTEM_RANK, type: "int", direction: "asc" },
          title,
          { expr: sql`${pages.id}`, type: "uuid", direction: "asc" },
        ],
      };
    case "title_asc":
      return { name: sort, keys: [title, { expr: sql`${pages.id}`, type: "uuid", direction: "asc" }] };
    case "updated_at_desc":
      return {
        name: sort,
        keys: [
          { expr: sql`${pages.updatedAt}`, type: "timestamptz", direction: "desc" },
          { expr: sql`${pages.id}`, type: "uuid", direction: "desc" },
        ],
      };
    case "published_at_desc":
      return {
        name: sort,
        keys: [
          { expr: sql`coalesce(${pages.publishedAt}, ${EPOCH})`, type: "timestamptz", direction: "desc" },
          { expr: sql`${pages.id}`, type: "uuid", direction: "desc" },
        ],
      };
  }
}

function conflictField(field: string, message: string): AppException {
  return new AppException(409, "VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });
}

const SLUG_TAKEN = "Slug sudah dipakai halaman lain.";

function hasUnpublishedChanges(row: PageRow): boolean {
  return (
    row.publishedVersion === null || row.title !== row.publishedTitle || row.bodyHtml !== row.publishedBodyHtml
  );
}

/**
 * Halaman informasi dan legal berversi (F-08, F-01, PRD 6.2): draf kerja (`title`/`body_html`, If-Match `version`)
 * terpisah dari salinan TAYANG (`published_*`, `published_version`). Penerbitan menyalin draf ke salinan tayang dan
 * menaikkan versi legal dalam SATU UPDATE bersyarat, mencerminkan versi ke `app_settings.legal` (SettingsService)
 * dan menulis audit `page.published` berisi teks tayang agar versi yang pernah disetujui dapat direproduksi
 * (F-01, F-17). Halaman tayang publik tanpa login (PRD 3.8).
 */
@Injectable()
export class PagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly media: ContentMediaService,
  ) {}

  // ------------------------------------------------------------------------------------------------- publik

  /** GET /public/pages: halaman yang pernah terbit + versi persetujuan registrasi (F-01). */
  async publicList(): Promise<PublicPageList> {
    const rows = await this.db
      .select()
      .from(pages)
      .where(isNotNull(pages.publishedVersion))
      .orderBy(asc(LEGAL_RANK), asc(sql`lower(${pages.publishedTitle})`), asc(pages.id));
    return {
      items: rows.map((row) => ({
        slug: row.slug,
        title: row.publishedTitle!,
        version: String(row.publishedVersion),
        published_at: iso(row.publishedAt!),
        legal_document: legalDocumentOf(row.slug),
      })),
      consent: legalConsentVersions(await this.settings.get("legal")),
    };
  }

  /** GET /public/pages/{slug}: salinan tayang terbaru; draf tidak pernah terlihat; belum terbit -> 404. */
  async publicGet(slug: string): Promise<PublicPage> {
    const [row] = await this.db
      .select()
      .from(pages)
      .where(and(eq(pages.slug, slug), isNotNull(pages.publishedVersion)));
    if (!row) throw notFound("Halaman tidak ditemukan.");
    return {
      slug: row.slug,
      title: row.publishedTitle!,
      body_html: row.publishedBodyHtml!,
      version: String(row.publishedVersion),
      published_at: iso(row.publishedAt!),
      legal_document: legalDocumentOf(row.slug),
    };
  }

  // ------------------------------------------------------------------------------------------------ pengurus

  async list(query: PageListQuery): Promise<AdminInfoPageList> {
    const spec = sortSpec(query.sort);
    const filter = query.q
      ? or(ilike(pages.title, containsPattern(query.q)), ilike(pages.slug, containsPattern(query.q)))
      : undefined;
    const after = query.cursor ? sortAfter(spec, decodeSortCursor(query.cursor, spec)) : undefined;
    const rows = await this.db
      .select({ page: pages, updatedByName: admins.displayName, ...sortKeySelection(spec) })
      .from(pages)
      .leftJoin(admins, eq(admins.id, pages.updatedByAdminId))
      .where(and(filter, after))
      .orderBy(...sortOrderBy(spec))
      .limit(query.limit + 1);
    const [total] = await this.db.select({ value: count() }).from(pages).where(filter);
    return adminPageOf(rows, query.limit, spec, Number(total?.value ?? 0), (row) =>
      this.toSummary(row.page, row.updatedByName),
    );
  }

  async get(id: string): Promise<AdminInfoPage> {
    const page = await this.load(this.db, id);
    if (!page) throw notFound("Halaman tidak ditemukan.");
    return page;
  }

  /** Halaman baru selalu draf (belum ada salinan tayang). */
  async create(auth: AuthContext, input: PageCreateInput): Promise<AdminInfoPage> {
    const body = this.media.sanitize(input.body_html);
    if (!body.hasContent) throw fieldError("body_html", EMPTY_BODY);
    try {
      return await this.db.transaction(async (tx) => {
        const now = this.clock.now();
        await this.media.attachBodyImages(tx, body.imageFileIds, "body_html");
        const id = uuidv7();
        await tx.insert(pages).values({
          id,
          slug: input.slug,
          title: input.title.trim(),
          bodyHtml: body.html,
          version: 1,
          updatedByAdminId: auth.adminId,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit.write(tx, {
          action: "page.created",
          entityType: "page",
          entityId: id,
          after: { slug: input.slug, title: input.title.trim() },
        });
        return (await this.load(tx, id))!;
      });
    } catch (error) {
      if (isUniqueViolation(error, "pages_slug_key")) throw conflictField("slug", SLUG_TAKEN);
      throw error;
    }
  }

  /** Simpan draf; salinan tayang dan versi legal tidak berubah sampai diterbitkan (AC F15-4, PRD 6.2). */
  async update(auth: AuthContext, id: string, expectedVersion: number, input: PageUpdateInput): Promise<AdminInfoPage> {
    const body = input.body_html === undefined ? null : this.media.sanitize(input.body_html);
    if (body && !body.hasContent) throw fieldError("body_html", EMPTY_BODY);
    try {
      return await this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const row = await this.lockCurrent(tx, id, expectedVersion);
        const changes: Partial<typeof pages.$inferInsert> = {};
        if (input.slug !== undefined && input.slug !== row.slug) {
          if (isSystemPage(row.slug) || row.publishedVersion !== null)
            throw fieldError("slug", "Slug halaman baku atau halaman yang pernah terbit tidak dapat diubah.");
          changes.slug = input.slug;
        }
        if (input.title !== undefined) changes.title = input.title.trim();
        if (body) {
          await this.media.attachBodyImages(tx, body.imageFileIds, "body_html");
          changes.bodyHtml = body.html;
        }
        await tx
          .update(pages)
          .set({ ...changes, version: row.version + 1, updatedAt: now, updatedByAdminId: auth.adminId })
          .where(and(eq(pages.id, id), eq(pages.version, expectedVersion)));
        await this.audit.write(tx, {
          action: "page.updated",
          entityType: "page",
          entityId: id,
          before: { slug: row.slug, title: row.title },
          after: { slug: changes.slug ?? row.slug, title: changes.title ?? row.title, body_changed: body !== null },
        });
        return (await this.load(tx, id))!;
      });
    } catch (error) {
      if (isUniqueViolation(error, "pages_slug_key")) throw conflictField("slug", SLUG_TAKEN);
      throw error;
    }
  }

  /** Hapus halaman non-baku (PRD 4.5); halaman baku wajib tersedia (PRD 8.2) -> 409 VALIDATION_ERROR. */
  async remove(id: string, expectedVersion: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockCurrent(tx, id, expectedVersion);
      if (isSystemPage(row.slug))
        throw conflictField(
          "_",
          "Halaman baku (kebijakan privasi, ketentuan, ketentuan komunitas, bantuan, tentang) tidak dapat dihapus.",
        );
      await tx.delete(pages).where(and(eq(pages.id, id), eq(pages.version, expectedVersion)));
      await this.audit.write(tx, {
        action: "page.deleted",
        entityType: "page",
        entityId: id,
        before: { slug: row.slug, title: row.title, published_version: row.publishedVersion },
      });
    });
  }

  /**
   * Terbitkan draf sebagai versi tayang baru (F-01, F-08, PRD 6.2), dalam satu transaksi:
   * 1. SATU UPDATE bersyarat (versi If-Match + ada perubahan) menyalin draf ke published_* dan menaikkan
   *    published_version;
   * 2. dokumen legal: app_settings.legal.<doc>_version = versi baru lewat SettingsService (baris dikunci FOR UPDATE
   *    lebih dulu sehingga penerbitan privasi dan ketentuan bersamaan berurutan, bukan saling menolak);
   * 3. audit `page.published` berisi versi beserta teks tayang utuh.
   */
  async publish(auth: AuthContext, id: string, expectedVersion: number, changeNote: string | null): Promise<AdminInfoPage> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [published] = await tx
        .update(pages)
        .set({
          publishedTitle: sql`${pages.title}`,
          publishedBodyHtml: sql`${pages.bodyHtml}`,
          publishedVersion: sql`coalesce(${pages.publishedVersion}, 0) + 1`,
          publishedAt: now,
          version: sql`${pages.version} + 1`,
          updatedAt: now,
          updatedByAdminId: auth.adminId,
        })
        .where(
          and(
            eq(pages.id, id),
            eq(pages.version, expectedVersion),
            or(
              isNull(pages.publishedVersion),
              sql`${pages.publishedTitle} is distinct from ${pages.title}`,
              sql`${pages.publishedBodyHtml} is distinct from ${pages.bodyHtml}`,
            ),
          ),
        )
        .returning();
      if (!published) {
        const current = await this.load(tx, id);
        if (!current) throw notFound("Halaman tidak ditemukan.");
        if (current.version !== String(expectedVersion)) throw versionConflict(current);
        throw conflictField("_", "Tidak ada perubahan untuk diterbitkan. Draf sama dengan versi tayang.");
      }
      const previousVersion = published.publishedVersion! - 1;
      const legalDocument = legalDocumentOf(published.slug);
      if (legalDocument) await this.mirrorLegalVersion(tx, legalDocument, published.publishedVersion!, changeNote);
      await this.audit.write(tx, {
        action: "page.published",
        entityType: "page",
        entityId: id,
        reason: changeNote,
        before: { published_version: previousVersion === 0 ? null : previousVersion },
        after: {
          slug: published.slug,
          legal_document: legalDocument,
          published_version: published.publishedVersion,
          published_at: now,
          title: published.publishedTitle,
          body_html: published.publishedBodyHtml,
          body_sha256: createHash("sha256").update(published.publishedBodyHtml!, "utf8").digest("hex"),
          change_note: changeNote,
        },
        limits: AUDIT_DOCUMENT_LIMITS,
      });
      return (await this.load(tx, id))!;
    });
  }

  /** app_settings.legal mencerminkan pages.published_version dokumen legal (F-01, ARCHITECTURE §5.4). */
  private async mirrorLegalVersion(
    tx: Tx,
    document: NonNullable<ReturnType<typeof legalDocumentOf>>,
    version: number,
    changeNote: string | null,
  ): Promise<void> {
    await tx
      .select({ key: appSettings.key })
      .from(appSettings)
      .where(eq(appSettings.key, "legal"))
      .for("update");
    const entry = await this.settings.getEntry("legal", { tx });
    try {
      await this.settings.update(
        tx,
        "legal",
        { ...entry.value, [legalSettingField(document)]: String(version) },
        entry.version,
        undefined,
        { reason: changeNote ?? `Penerbitan ${document} versi ${version}` },
      );
    } catch (error) {
      // Hanya mungkin bila baris legal belum pernah disemai dan dua penerbitan pertama bersamaan: ulangi penerbitan.
      if (error instanceof AppException && error.code === "VERSION_CONFLICT")
        throw new AppException(
          409,
          "VERSION_CONFLICT",
          "Versi dokumen legal berubah bersamaan. Muat ulang lalu terbitkan lagi.",
        );
      throw error;
    }
  }

  private async lockCurrent(tx: Tx, id: string, expectedVersion: number): Promise<PageRow> {
    const [row] = await tx.select().from(pages).where(eq(pages.id, id)).for("update");
    if (!row) throw notFound("Halaman tidak ditemukan.");
    if (row.version !== expectedVersion) throw versionConflict(await this.load(tx, id));
    return row;
  }

  private async load(db: DbOrTx, id: string): Promise<AdminInfoPage | null> {
    const [row] = await db
      .select({ page: pages, updatedByName: admins.displayName })
      .from(pages)
      .leftJoin(admins, eq(admins.id, pages.updatedByAdminId))
      .where(eq(pages.id, id));
    if (!row) return null;
    const page = row.page;
    return {
      ...this.toSummary(page, row.updatedByName),
      body_html: page.bodyHtml,
      published:
        page.publishedVersion !== null
          ? {
              title: page.publishedTitle!,
              body_html: page.publishedBodyHtml!,
              version: String(page.publishedVersion),
              published_at: iso(page.publishedAt!),
            }
          : null,
      slug_locked: isSystemPage(page.slug) || page.publishedVersion !== null,
      created_at: iso(page.createdAt),
    };
  }

  private toSummary(row: PageRow, updatedByName: string | null): AdminInfoPageSummary {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      legal_document: legalDocumentOf(row.slug),
      system: isSystemPage(row.slug),
      published_version: row.publishedVersion === null ? null : String(row.publishedVersion),
      published_at: iso(row.publishedAt),
      has_unpublished_changes: hasUnpublishedChanges(row),
      version: String(row.version),
      updated_at: iso(row.updatedAt),
      updated_by:
        row.updatedByAdminId && updatedByName !== null
          ? { admin_id: row.updatedByAdminId, display_name: updatedByName }
          : null,
    };
  }
}
