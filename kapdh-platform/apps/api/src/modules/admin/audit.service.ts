import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins, alumni, auditLogs } from "@kapdh/database";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { DB } from "../../core/tokens.js";
import { validateQuery } from "../../core/validation/validate.js";
import { type AuditFilter, AuditFilterSchema, auditFilterSql, compactFilter } from "./audit-filter.js";

type AuditEntry = components["schemas"]["AuditEntry"];
type AuditEntryDetail = components["schemas"]["AuditEntryDetail"];
type AuditEntryPage = components["schemas"]["AuditEntryPage"];
type AuditEffectiveRole = components["schemas"]["AuditEffectiveRole"];

const SearchQuerySchema = z.object({
  sort: z.enum(["created_at_desc", "created_at_asc"], { message: "Urutan tidak dikenal" }).optional(),
});

const cursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });

/** Kolom baris audit + nama pelaku saat dibaca (PRD 3.17): admin dari admins, alumni dari profil; null untuk anonim. */
const auditRowSelection = {
  id: auditLogs.id,
  createdAt: auditLogs.createdAt,
  action: auditLogs.action,
  entityType: auditLogs.entityType,
  entityId: auditLogs.entityId,
  effectiveRole: auditLogs.effectiveRole,
  actorAdminId: auditLogs.actorAdminId,
  actorUserId: auditLogs.actorUserId,
  actorName: sql<string | null>`coalesce(${admins.displayName}, ${alumni.fullName})`,
  requestId: auditLogs.requestId,
  reason: auditLogs.reason,
};

/**
 * Kueri baris audit dengan nama pelaku; dipakai pencarian dan job ekspor dengan predikat filter yang sama (AC F17-4).
 * `withPayload` menambahkan before/after (detail dan ekspor).
 */
export function auditRowsQuery(db: DbOrTx) {
  return db
    .select({ ...auditRowSelection, before: auditLogs.before, after: auditLogs.after })
    .from(auditLogs)
    .leftJoin(admins, eq(admins.id, auditLogs.actorAdminId))
    .leftJoin(alumni, eq(alumni.userId, auditLogs.actorUserId));
}

/** Baris audit lengkap (dengan before/after) dari {@link auditRowsQuery}. */
export type AuditRowWithPayload = Awaited<ReturnType<ReturnType<typeof auditRowsQuery>["execute"]>>[number];

function listQuery(db: DbOrTx) {
  return db
    .select(auditRowSelection)
    .from(auditLogs)
    .leftJoin(admins, eq(admins.id, auditLogs.actorAdminId))
    .leftJoin(alumni, eq(alumni.userId, auditLogs.actorUserId));
}

interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  effectiveRole: string;
  actorAdminId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  requestId: string;
  reason: string | null;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    created_at: row.createdAt.toISOString(),
    action: row.action,
    entity_type: row.entityType,
    entity_id: row.entityId,
    effective_role: row.effectiveRole as AuditEffectiveRole,
    actor: { admin_id: row.actorAdminId, user_id: row.actorUserId, display_name: row.actorName ?? null },
    request_id: row.requestId,
    reason: row.reason,
  };
}

/** before/after kontrak bertipe objek atau null; nilai lain (data lama) dibungkus agar tetap terbaca. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

/** Predikat keyset "setelah cursor" untuk urutan (created_at, id). */
export function auditKeysetAfter(after: { created_at: Date; id: string }, direction: "asc" | "desc") {
  return keysetAfter([
    { column: auditLogs.createdAt, value: after.created_at, direction },
    { column: auditLogs.id, value: after.id, direction },
  ]);
}

/**
 * Pencarian audit (F-17, AC F17-2, F17-4; kontrak adminSearchAudit/adminGetAuditEntry). Hanya membaca; audit
 * append-only. Filter sama persis dengan ekspor (auditFilterSql), keyset (created_at, id), `total` mengikuti filter.
 * before/after tampil sebagaimana disimpan (secret sudah disaring saat tulis); penyamaran kolom privat khusus berkas
 * ekspor.
 */
@Injectable()
export class AuditSearchService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Filter pencarian dari query string (nama dan arti sama dengan body ekspor). */
  parseFilter(query: unknown): AuditFilter {
    return compactFilter(validateQuery(AuditFilterSchema, query));
  }

  async search(query: unknown): Promise<AuditEntryPage> {
    const filter = this.parseFilter(query);
    const { sort } = validateQuery(SearchQuerySchema, query);
    const direction = sort === "created_at_asc" ? "asc" : "desc";
    const page = parsePageQuery(query);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    const where = auditFilterSql(filter);
    const order = direction === "asc" ? asc : desc;
    const [rows, [totalRow]] = await Promise.all([
      listQuery(this.db)
        .where(and(where, after ? auditKeysetAfter(after, direction) : undefined))
        .orderBy(order(auditLogs.createdAt), order(auditLogs.id))
        .limit(page.limit + 1),
      this.db.select({ total: count() }).from(auditLogs).where(where),
    ]);
    return pageOf(rows, page.limit, {
      cursorOf: (row) => ({ created_at: row.createdAt, id: row.id }),
      toItem: toEntry,
      total: Number(totalRow?.total ?? 0),
    });
  }

  async entry(entryId: string): Promise<AuditEntryDetail> {
    const [row] = await auditRowsQuery(this.db).where(eq(auditLogs.id, entryId)).limit(1);
    if (!row) throw notFound("Entri audit tidak ditemukan.");
    return {
      ...toEntry(row),
      before: asObject(row.before) as AuditEntryDetail["before"],
      after: asObject(row.after) as AuditEntryDetail["after"],
    };
  }
}
