import type { components } from "@kapdh/contracts";
import type { reports } from "@kapdh/database";

type ModerationReport = components["schemas"]["ModerationReport"];
type ReportRow = typeof reports.$inferSelect;

/** Kolom laporan yang dibutuhkan tampilan pelapor (tanpa bukti, catatan internal, maupun identitas pengurus). */
export type MemberReportRow = Pick<
  ReportRow,
  | "id"
  | "category"
  | "targetType"
  | "description"
  | "status"
  | "priority"
  | "memberMessage"
  | "createdAt"
  | "dueAt"
  | "resolvedAt"
> & { roomName: string | null };

/**
 * Laporan/banding dari sudut pandang pelapor (kontrak ModerationReport, AC F12-2): status dan hasil tanpa merinci
 * tindakan terhadap pihak lain (outcome no_action untuk dismiss, action_taken untuk warn/suspend/unsuspend), tanpa
 * bukti, identitas pengurus, catatan internal, maupun reporter_id/target_user_id. `decision_message` hanya untuk banding
 * yang sudah diputus (pesan pengurus kepada pemohon); `target_name` null untuk laporan grup atau akun yang dihapus.
 */
export function toMemberReport(row: MemberReportRow, targetName: string | null): ModerationReport {
  const decided = row.status === "resolved" || row.status === "dismissed";
  return {
    id: row.id,
    category: row.category,
    target_type: row.targetType,
    target_name: row.targetType === "room" ? null : targetName,
    room_name: row.roomName,
    description: row.description,
    status: row.status,
    priority: row.priority,
    outcome: !decided ? null : row.status === "dismissed" ? "no_action" : "action_taken",
    decision_message: decided && row.category === "appeal" ? row.memberMessage : null,
    created_at: row.createdAt.toISOString(),
    due_at: row.dueAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  };
}
