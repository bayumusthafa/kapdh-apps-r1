import { auditLogs } from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../db/types.js";
import { type AuditLimits, sanitizeAuditValue } from "./sanitize.js";

/** Peran efektif aktor pada audit (CHECK audit_logs_effective_role_chk). */
export type AuditRole = "alumni" | "admin" | "super_admin" | "system" | "anonymous";

export interface AuditRecord {
  actorUserId?: string | null;
  actorAdminId?: string | null;
  effectiveRole: AuditRole;
  /** `domain.verb`, mis. `payment.approved`, `settings.updated`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Kunci korelasi ke log API/worker (N-14). */
  requestId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** Waktu dari Clock aplikasi; bawaan DB now() hanya cadangan (ARCHITECTURE §2.6). */
  createdAt?: Date;
  /** Batas penyaring before/after; bawaan AUDIT_LIMITS (AUDIT_DOCUMENT_LIMITS hanya untuk teks dokumen utuh). */
  limits?: AuditLimits;
}

/**
 * Menulis satu baris audit dalam transaksi yang sama dengan perubahan kritis (AC F17-1): bila audit gagal, perubahan
 * ikut batal. before/after disaring {@link sanitizeAuditValue}. Lebih disarankan memakai `AuditService.write`, yang
 * mengisi aktor, request_id, dan waktu dari konteks.
 */
export async function writeAudit(tx: DbOrTx, record: AuditRecord): Promise<string> {
  const id = uuidv7();
  await tx.insert(auditLogs).values({
    id,
    actorUserId: record.actorUserId ?? null,
    actorAdminId: record.actorAdminId ?? null,
    effectiveRole: record.effectiveRole,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId ?? null,
    requestId: record.requestId,
    reason: record.reason ?? null,
    before: sanitizeAuditValue(record.before, record.limits),
    after: sanitizeAuditValue(record.after, record.limits),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
  });
  return id;
}
