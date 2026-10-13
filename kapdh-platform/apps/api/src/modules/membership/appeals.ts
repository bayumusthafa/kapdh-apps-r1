import { reports } from "@kapdh/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AuditService } from "../../core/audit/audit.service.js";
import type { Tx } from "../../core/db/types.js";

/** Banding yang masih aktif (kontrak C6: open/in_review) milik anggota, dikunci untuk ditutup. */
export interface LockedAppeal {
  id: string;
  status: "open" | "in_review";
  version: number;
}

/**
 * Mengunci banding aktif anggota (reports berkategori `appeal`, target_user_id = anggota, status open/in_review;
 * PRD 3.12) FOR UPDATE, urut id. URUTAN KUNCI bersama: users → alumni (MembershipKernel) → reports banding, sama dengan
 * createAppeal (di bawah kunci baris alumni) sehingga jalur unsuspend dan pengajuan banding tidak deadlock.
 * Perbandingan kategori memakai teks (aturan migrasi 0006: literal enum `appeal` tidak dipakai di SQL bersama).
 */
export async function lockActiveAppeals(tx: Tx, memberUserId: string): Promise<LockedAppeal[]> {
  const rows = await tx
    .select({ id: reports.id, status: reports.status, version: reports.version })
    .from(reports)
    .where(
      and(
        eq(reports.targetUserId, memberUserId),
        sql`${reports.category}::text = 'appeal'`,
        inArray(reports.status, ["open", "in_review"]),
      ),
    )
    .orderBy(asc(reports.id))
    .for("update");
  return rows as LockedAppeal[];
}

/**
 * Menutup banding aktif sebagai DIKABULKAN dalam transaksi pencabutan pembatasan (kontrak adminUnsuspendMember
 * butir 2, admin-moderation "jalur unsuspend lain (menu anggota admin)"; AC F12-3, F17-1): status resolved, action
 * unsuspend, resolution_note internal yang merujuk pencabutan beserta alasannya, `member_message` = pesan aman untuk
 * pemohon (decision_message), resolved_by_admin_id = pelaku, resolved_at = waktu server, version + 1, dan satu audit
 * `moderation.report_resolved` per banding. Notifikasi TIDAK ditulis di sini: pemanggil mengirim satu notifikasi
 * gabungan lewat MembershipKernel.unsuspend({appealGranted: true}) sehingga tidak ada notifikasi ganda per banding.
 */
export async function closeAppealsAsGranted(
  tx: Tx,
  audit: AuditService,
  appeals: readonly LockedAppeal[],
  input: {
    actorAdminId: string | null;
    reason: string;
    memberMessage: string;
    resolutionNote: string;
    now: Date;
  },
): Promise<number> {
  let closed = 0;
  for (const appeal of appeals) {
    const [updated] = await tx
      .update(reports)
      .set({
        status: "resolved",
        action: "unsuspend",
        resolutionNote: input.resolutionNote,
        memberMessage: input.memberMessage,
        resolvedByAdminId: input.actorAdminId,
        resolvedAt: input.now,
        version: sql`${reports.version} + 1`,
        updatedAt: input.now,
      })
      .where(and(eq(reports.id, appeal.id), inArray(reports.status, ["open", "in_review"])))
      .returning({ id: reports.id, version: reports.version });
    if (!updated) continue;
    closed++;
    await audit.write(tx, {
      action: "moderation.report_resolved",
      entityType: "report",
      entityId: appeal.id,
      reason: input.reason,
      before: { status: appeal.status, version: appeal.version },
      after: {
        status: "resolved",
        action: "unsuspend",
        outcome: "action_taken",
        appeal_granted: true,
        via: "member_unsuspend",
        version: updated.version,
      },
    });
  }
  return closed;
}
