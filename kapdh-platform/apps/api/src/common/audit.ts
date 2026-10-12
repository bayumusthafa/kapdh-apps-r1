import { auditLogs } from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import type { Db, Tx } from "../infra/db.js";

/** Catatan audit dalam transaksi yang sama dengan perubahan kritis (AC F17-1). Tanpa sandi, OTP, atau token. */
export async function writeAudit(
  tx: Db | Tx,
  entry: {
    actorUserId?: string | null;
    actorAdminId?: string | null;
    effectiveRole: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    requestId: string;
    reason?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    id: uuidv7(),
    actorUserId: entry.actorUserId ?? null,
    actorAdminId: entry.actorAdminId ?? null,
    effectiveRole: entry.effectiveRole,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    requestId: entry.requestId,
    reason: entry.reason ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
