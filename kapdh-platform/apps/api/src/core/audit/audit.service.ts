import { Inject, Injectable } from "@nestjs/common";
import type { Clock } from "../adapters/clock.js";
import { type Actor, ctx } from "../context/request-context.js";
import type { DbOrTx } from "../db/types.js";
import { CLOCK } from "../tokens.js";
import type { AuditLimits } from "./sanitize.js";
import { type AuditRole, writeAudit } from "./write-audit.js";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** Bawaan dari ctx().actor; isi eksplisit hanya bila aktor berbeda dari pemanggil (mis. CLI bootstrap). */
  actor?: Pick<Actor, "kind" | "userId" | "adminId" | "adminRole">;
  /**
   * Batas penyaring before/after; bawaan AUDIT_LIMITS. AUDIT_DOCUMENT_LIMITS untuk entri yang wajib memuat teks
   * dokumen utuh (mis. `page.published`, F-01).
   */
  limits?: AuditLimits;
}

export function auditRoleOf(actor: Pick<Actor, "kind" | "adminRole">): AuditRole {
  switch (actor.kind) {
    case "alumni":
      return "alumni";
    case "admin":
      return actor.adminRole === "super_admin" ? "super_admin" : "admin";
    case "system":
      return "system";
    case "anonymous":
      return "anonymous";
  }
}

/**
 * Audit append-only (F-17, ARCHITECTURE §4.2): aktor, peran efektif, dan request_id diambil dari konteks request/job;
 * waktu dari Clock. Wajib dipanggil di dalam transaksi perubahan kritis (AC F17-1).
 *
 *   await this.audit.write(tx, { action: "payment.approved", entityType: "payment", entityId: id, before, after });
 */
@Injectable()
export class AuditService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async write(tx: DbOrTx, entry: AuditEntry): Promise<string> {
    const context = ctx();
    const actor = entry.actor ?? context.actor;
    return writeAudit(tx, {
      actorUserId: actor.userId,
      actorAdminId: actor.adminId,
      effectiveRole: auditRoleOf(actor),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      requestId: context.requestId,
      reason: entry.reason ?? null,
      before: entry.before,
      after: entry.after,
      createdAt: this.clock.now(),
      ...(entry.limits ? { limits: entry.limits } : {}),
    });
  }
}
