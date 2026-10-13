import type { components } from "@kapdh/contracts";
import { admins, auditLogs, files } from "@kapdh/database";
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../../core/db/types.js";
import type { AuditFilter } from "./audit-filter.js";
import { tsLiteral } from "./queue-rules.js";

type AuditExport = components["schemas"]["AuditExport"];
export type AuditExportStatus = components["schemas"]["AuditExportStatus"];
type AuditExportFailureReason = components["schemas"]["AuditExportFailureReason"];

/**
 * Konfigurasi server ekspor audit (kontrak C7: nilai usulan, bukan angka PRD; final mengikuti D1/D8).
 * - Batas waktu job sejak diminta: lewat batas tanpa entri terminal = failed/timed_out.
 * - Masa simpan berkas privat sebelum dihapus otomatis (AC F17-4).
 * - Batas baris; hasil filter yang melebihi batas gagal `row_limit_exceeded`, tidak pernah dipotong diam-diam.
 */
export const AUDIT_EXPORT_TIMEOUT_MS = 3600_000;
export const AUDIT_EXPORT_RETENTION_MS = 24 * 3600_000;
export const AUDIT_EXPORT_ROW_LIMIT = 50_000;
/** Percobaan job sebelum `processing_failed` ditulis (retry outbox 10 s, 20 s; jauh sebelum batas waktu). */
export const AUDIT_EXPORT_MAX_ATTEMPTS = 3;
/** Ekspor per admin per jam (RATE_LIMITED, kontrak adminCreateAuditExport). */
export const AUDIT_EXPORT_RATE_LIMIT = 10;

export const EXPORT_ENTITY = "audit_export";
export const EXPORT_REQUESTED = "audit.export.requested";
export const EXPORT_COMPLETED = "audit.export.completed";
export const EXPORT_FAILED = "audit.export.failed";
export const EXPORT_DOWNLOADED = "audit.export.downloaded";

/** `audit-<YYYYMMDD requested_at UTC>-<8 hex awal id>.csv` (tanpa data pribadi). */
export function exportFileName(exportId: string, requestedAt: Date): string {
  const day = requestedAt.toISOString().slice(0, 10).replace(/-/g, "");
  return `audit-${day}-${exportId.replace(/-/g, "").slice(0, 8)}.csv`;
}

const requested = alias(auditLogs, "export_requested");
const completed = alias(auditLogs, "export_completed");
const failed = alias(auditLogs, "export_failed");
const requester = alias(admins, "export_requester");

/**
 * Status ekspor diturunkan dari audit_logs + files tanpa tabel job (kontrak C7 AuditExport), urutan prioritas:
 * completed (ready, atau expired bila berkas deleted/hilang/kedaluwarsa) > failed > lewat batas waktu (failed) >
 * processing. Ekspresi SQL yang sama dipakai filter `status`, `total` dan item agar konsisten.
 */
export function exportStatusSql(now: Date): SQL<AuditExportStatus> {
  const at = tsLiteral(now);
  return sql<AuditExportStatus>`(case
    when ${completed.id} is not null then
      case when ${files.id} is null or ${files.status} = 'deleted' or (${files.expiresAt} is not null and ${files.expiresAt} <= ${at})
        then 'expired' else 'ready' end
    when ${failed.id} is not null then 'failed'
    when ${at} > ${requested.createdAt} + (${AUDIT_EXPORT_TIMEOUT_MS}::bigint * interval '1 millisecond') then 'failed'
    else 'processing' end)`;
}

const completedJoin = and(
  eq(completed.entityType, EXPORT_ENTITY),
  eq(completed.entityId, requested.entityId),
  eq(completed.action, EXPORT_COMPLETED),
);
const failedJoin = and(
  eq(failed.entityType, EXPORT_ENTITY),
  eq(failed.entityId, requested.entityId),
  eq(failed.action, EXPORT_FAILED),
);
const fileJoin = sql`${files.id} = nullif(${completed.after} ->> 'file_id', '')::uuid`;

/** Jumlah ekspor dengan join dan ekspresi status yang sama dengan {@link exportQuery} (filter `status`). */
export function exportCountQuery(db: DbOrTx) {
  return db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(requested)
    .leftJoin(completed, completedJoin)
    .leftJoin(failed, failedJoin)
    .leftJoin(files, fileJoin);
}

/** Kueri ekspor (entri requested + entri terminal + berkas + nama peminta), belum difilter. */
export function exportQuery(db: DbOrTx, now: Date) {
  return db
    .select({
      exportId: requested.entityId,
      requestedAuditId: requested.id,
      requestedAt: requested.createdAt,
      requesterAdminId: requested.actorAdminId,
      requesterUserId: requested.actorUserId,
      requesterName: requester.displayName,
      requestAfter: requested.after,
      completedAt: completed.createdAt,
      completedAfter: completed.after,
      failedAt: failed.createdAt,
      failedAfter: failed.after,
      fileId: files.id,
      fileStatus: files.status,
      fileBytes: files.bytes,
      fileExpiresAt: files.expiresAt,
      status: exportStatusSql(now),
    })
    .from(requested)
    .leftJoin(requester, eq(requester.id, requested.actorAdminId))
    .leftJoin(completed, completedJoin)
    .leftJoin(failed, failedJoin)
    .leftJoin(files, fileJoin);
}

/** Predikat dasar: entri permintaan ekspor (id ekspor = entity_id) yang masih memiliki peminta. */
export function exportBaseWhere(): SQL {
  return and(
    eq(requested.action, EXPORT_REQUESTED),
    eq(requested.entityType, EXPORT_ENTITY),
    isNotNull(requested.entityId),
    isNotNull(requested.actorAdminId),
  )!;
}

export const exportTables = { requested, completed, failed, requester };

export type ExportRow = Awaited<ReturnType<ReturnType<typeof exportQuery>["execute"]>>[number];

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Bentuk kontrak AuditExport dari baris turunan. */
export function toAuditExport(row: ExportRow): AuditExport {
  const status = row.status;
  const exportId = row.exportId!;
  const completedAfter = objectOf(row.completedAfter);
  const failedAfter = objectOf(row.failedAfter);
  const done = row.completedAt !== null;
  const rowCount = completedAfter.row_count;
  let failureReason: AuditExportFailureReason | null = null;
  if (status === "failed")
    failureReason = row.failedAt
      ? ((failedAfter.failure_reason as AuditExportFailureReason | undefined) ?? "processing_failed")
      : "timed_out";
  return {
    id: exportId,
    status,
    filters: objectOf(objectOf(row.requestAfter).filters) as AuditFilter,
    requested_by: { admin_id: row.requesterAdminId!, display_name: row.requesterName ?? null },
    requested_at: row.requestedAt.toISOString(),
    completed_at: (row.completedAt ?? row.failedAt)?.toISOString() ?? null,
    expires_at: done ? (row.fileExpiresAt?.toISOString() ?? null) : null,
    row_count: done && typeof rowCount === "number" ? rowCount : null,
    file_name: done ? exportFileName(exportId, row.requestedAt) : null,
    bytes: done && row.fileBytes !== null ? row.fileBytes : null,
    failure_reason: failureReason,
  };
}
