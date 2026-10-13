import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins } from "@kapdh/database";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { AppException, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import { AuditFilterSchema, compactFilter } from "./audit-filter.js";
import {
  AUDIT_EXPORT_RATE_LIMIT,
  EXPORT_DOWNLOADED,
  EXPORT_ENTITY,
  EXPORT_REQUESTED,
  exportBaseWhere,
  exportCountQuery,
  exportFileName,
  exportQuery,
  exportStatusSql,
  exportTables,
  toAuditExport,
} from "./audit-export.shared.js";

type AuditExport = components["schemas"]["AuditExport"];
type AuditExportPage = components["schemas"]["AuditExportPage"];
type AuditExportAccess = components["schemas"]["AuditExportAccess"];

const ListQuerySchema = z.object({
  status: z
    .enum(["processing", "ready", "failed", "expired"], { message: "Status tidak dikenal" })
    .optional(),
});
const cursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });
const { requested } = exportTables;

/**
 * Ekspor audit asinkron (F-17, AC F17-2..F17-4; kontrak C7 adminCreateAuditExport dst.). Keadaan job disimpan pada
 * audit_logs (append-only) + files tanpa tabel baru; worker `audit.export` (admin-jobs) menulis berkas dan entri
 * terminal. Admin melihat ekspor yang ia minta; Super Admin melihat semua. Kepemilikan dan izin diperiksa ulang setiap
 * permintaan (AC F17-2); bukan pemilik = 404 (N-09).
 */
@Injectable()
export class AuditExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly files: FilesService,
    private readonly limits: RateLimitService,
  ) {}

  /** Satu transaksi: audit `audit.export.requested` (after.filters) + outbox dengan dedup id ekspor (AC F17-1). */
  async create(auth: AuthContext, body: unknown): Promise<AuditExport> {
    const filters = compactFilter(validate(AuditFilterSchema, body));
    await this.limits.consumeOrThrow(
      `audit-export:${auth.adminId}`,
      AUDIT_EXPORT_RATE_LIMIT,
      3600_000,
      "Terlalu banyak permintaan ekspor. Coba lagi nanti.",
    );
    const exportId = uuidv7();
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      await this.audit.write(tx, {
        action: EXPORT_REQUESTED,
        entityType: EXPORT_ENTITY,
        entityId: exportId,
        after: { filters },
      });
      await this.outbox.publish(tx, {
        topic: "audit.export.requested",
        dedupKey: `audit.export.requested:${exportId}`,
        payload: { export_id: exportId, admin_id: auth.adminId! },
      });
    });
    const [admin] = await this.db
      .select({ name: admins.displayName })
      .from(admins)
      .where(eq(admins.id, auth.adminId!))
      .limit(1);
    return {
      id: exportId,
      status: "processing",
      filters,
      requested_by: { admin_id: auth.adminId!, display_name: admin?.name ?? null },
      requested_at: now.toISOString(),
      completed_at: null,
      expires_at: null,
      row_count: null,
      file_name: null,
      bytes: null,
      failure_reason: null,
    };
  }

  /** Visibilitas: peminta sendiri, atau Super Admin untuk semua ekspor. */
  private ownership(auth: AuthContext): SQL | undefined {
    return auth.adminRole === "super_admin" ? undefined : eq(requested.actorAdminId, auth.adminId!);
  }

  async list(auth: AuthContext, query: unknown): Promise<AuditExportPage> {
    const { status } = validateQuery(ListQuerySchema, query);
    const page = parsePageQuery(query);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    const now = this.clock.now();
    const where = and(
      exportBaseWhere(),
      this.ownership(auth),
      status ? sql`${exportStatusSql(now)} = ${status}` : undefined,
    );
    const [rows, [total]] = await Promise.all([
      exportQuery(this.db, now)
        .where(
          and(
            where,
            after
              ? keysetAfter([
                  { column: requested.createdAt, value: after.created_at, direction: "desc" },
                  { column: requested.id, value: after.id, direction: "desc" },
                ])
              : undefined,
          ),
        )
        .orderBy(desc(requested.createdAt), desc(requested.id))
        .limit(page.limit + 1),
      // Total memakai join dan ekspresi status yang sama dengan item (filter status).
      exportCountQuery(this.db).where(where),
    ]);
    return pageOf(rows, page.limit, {
      cursorOf: (row) => ({ created_at: row.requestedAt, id: row.requestedAuditId }),
      toItem: toAuditExport,
      total: Number(total?.total ?? 0),
    });
  }

  private async find(auth: AuthContext, exportId: string) {
    const [row] = await exportQuery(this.db, this.clock.now())
      .where(and(exportBaseWhere(), eq(requested.entityId, exportId), this.ownership(auth)))
      .orderBy(desc(requested.createdAt))
      .limit(1);
    if (!row) throw notFound("Ekspor audit tidak ditemukan.");
    return row;
  }

  async get(auth: AuthContext, exportId: string): Promise<AuditExport> {
    return toAuditExport(await this.find(auth, exportId));
  }

  /**
   * URL unduh bertanda tangan (<= 10 menit) untuk ekspor `ready`; izin (audit.read + audit.export) dan kepemilikan
   * diperiksa ulang oleh guard dan kebijakan berkas `audit_export` pada setiap permintaan (AC F17-2). Status lain 409
   * dengan `current`; berkas kedaluwarsa/terhapus 404. Setiap akses diaudit `audit.export.downloaded` (PRD 3.17).
   */
  async access(auth: AuthContext, exportId: string): Promise<AuditExportAccess> {
    const row = await this.find(auth, exportId);
    const current = toAuditExport(row);
    if (current.status === "expired" || (current.status === "ready" && !row.fileId))
      throw notFound("Berkas ekspor sudah kedaluwarsa. Minta ekspor baru.");
    if (current.status !== "ready" || !row.fileId)
      throw versionConflict(current, "Ekspor belum siap diunduh. Muat ulang status ekspor.");
    let grant;
    try {
      grant = await this.files.accessFor(row.fileId, auth);
    } catch (error) {
      if (error instanceof AppException && error.code === "NOT_FOUND")
        throw notFound("Berkas ekspor sudah kedaluwarsa. Minta ekspor baru.");
      throw error;
    }
    await this.db.transaction((tx) =>
      this.audit.write(tx, {
        action: EXPORT_DOWNLOADED,
        entityType: EXPORT_ENTITY,
        entityId: exportId,
        after: { file_id: row.fileId },
      }),
    );
    return {
      url: grant.url,
      expires_at: (grant.expiresAt ?? this.clock.now()).toISOString(),
      file_name: exportFileName(exportId, row.requestedAt),
    };
  }
}
