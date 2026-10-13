import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { reports, roomMembers } from "@kapdh/database";
import { and, count, eq, inArray, isNull, min, ne, or, type SQL, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { CLOCK, DB } from "../../core/tokens.js";

type QueueCounts = components["schemas"]["AdminModerationQueueCounts"];
type DashboardModeration = components["schemas"]["DashboardModeration"];

/** Status laporan aktif (antrean kerja): open + in_review. */
export const ACTIVE_REPORT_STATUSES = ["open", "in_review"] as const;

/** Bentuk minimum laporan untuk menilai pihak terlapor. */
export interface ReportPartyRef {
  targetType: "user" | "message" | "room";
  targetUserId: string | null;
  roomId: string | null;
}

/**
 * Aturan visibilitas konflik kepentingan laporan untuk pengurus (kontrak admin-moderation aturan domain butir a dan c;
 * PRD 2.3, AC F12-2), dievaluasi per request dari `admins.linked_alumni_user_id` pemanggil:
 * laporan yang pihak terlapornya akun alumni tertaut pemanggil TIDAK PERNAH terlihat olehnya, yaitu
 * - `target_user_id` = akun tertaut (pihak terlapor, pengirim pesan terlapor, subjek yang ditetapkan lewat
 *   `subject_user_id`, atau pemohon banding), atau
 * - laporan grup tanpa subjek (`target_type` room, `target_user_id` null) yang pemanggilnya anggota joined grup itu.
 * super_admin tidak dikecualikan dari aturan ini.
 *
 * SATU sumber bersama untuk semua hitungan laporan yang dikirim ke pengurus (butir c): antrean (`items`, `total`,
 * `counts`, `q`), DashboardModeration dan AdminNavBadges.reports_open ({@link dashboardSummary}), serta
 * AdminMemberDetail.moderation ({@link memberReportCounts}) wajib memakai fungsi kelas ini (atau {@link condition})
 * agar angkanya selalu sama dan tidak membocorkan adanya laporan tersembunyi terhadap pemanggil.
 */
@Injectable()
export class ModerationVisibility {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Predikat SQL "laporan terlihat bagi pemanggil" atas tabel `reports`; undefined bila admin tanpa akun tertaut. */
  condition(linkedAlumniUserId: string | null): SQL | undefined {
    if (!linkedAlumniUserId) return undefined;
    return and(
      or(isNull(reports.targetUserId), ne(reports.targetUserId, linkedAlumniUserId)),
      sql`not (${reports.targetType} = 'room' and ${reports.targetUserId} is null and exists (
        select 1 from ${roomMembers} rm
        where rm.room_id = ${reports.roomId} and rm.user_id = ${linkedAlumniUserId} and rm.status = 'joined'
      ))`,
    );
  }

  /** true bila akun tertaut pemanggil adalah pihak terlapor laporan ini (detail/klaim/keputusan → 404). */
  async isReportedParty(
    report: ReportPartyRef,
    linkedAlumniUserId: string | null,
    db: DbOrTx = this.db,
  ): Promise<boolean> {
    if (!linkedAlumniUserId) return false;
    if (report.targetUserId !== null) return report.targetUserId === linkedAlumniUserId;
    if (report.targetType !== "room" || report.roomId === null) return false;
    const [member] = await db
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, report.roomId),
          eq(roomMembers.userId, linkedAlumniUserId),
          eq(roomMembers.status, "joined"),
        ),
      )
      .limit(1);
    return member !== undefined;
  }

  /**
   * Ringkasan antrean untuk badge/dasbor (AdminModerationQueueCounts) setelah pengecualian konflik kepentingan, tidak
   * terpengaruh filter: open, in_review, overdue (aktif dan waktu server >= due_at), urgent (aktif berprioritas urgent).
   */
  async counts(linkedAlumniUserId: string | null, now: Date = this.clock.now()): Promise<QueueCounts> {
    const row = await this.aggregate(linkedAlumniUserId, now);
    return { open: row.open, in_review: row.inReview, overdue: row.overdue, urgent: row.urgent };
  }

  /**
   * DashboardModeration (admin-dashboard.yaml) dari agregat yang SAMA dengan {@link counts} (aturan domain butir c):
   * open_count = open + in_review (juga nilai AdminNavBadges.reports_open), urgent_count, overdue_count, dan
   * oldest_open_created_at laporan aktif yang terlihat bagi pemanggil.
   */
  async dashboardSummary(
    linkedAlumniUserId: string | null,
    now: Date = this.clock.now(),
  ): Promise<DashboardModeration> {
    const row = await this.aggregate(linkedAlumniUserId, now);
    return {
      open_count: row.open + row.inReview,
      urgent_count: row.urgent,
      overdue_count: row.overdue,
      oldest_open_created_at: row.oldest?.toISOString() ?? null,
    };
  }

  /**
   * Hitungan laporan terhadap satu anggota untuk AdminMemberDetail.moderation (admin-members.yaml) dengan aturan
   * visibilitas yang sama: saat pemanggil membuka akun alumni tertautnya sendiri, laporan terhadap dirinya tidak
   * terhitung (butir c). Banding (kategori appeal) bukan laporan terhadap anggota sehingga tidak dihitung.
   */
  async memberReportCounts(
    memberUserId: string,
    linkedAlumniUserId: string | null,
  ): Promise<{ open_report_count: number; total_report_count: number }> {
    const [row] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${reports.status} in ('open', 'in_review'))`.mapWith(Number),
        total: count(),
      })
      .from(reports)
      .where(
        and(
          eq(reports.targetUserId, memberUserId),
          ne(reports.category, "appeal"),
          this.condition(linkedAlumniUserId),
        ),
      );
    return { open_report_count: row?.open ?? 0, total_report_count: Number(row?.total ?? 0) };
  }

  private async aggregate(linkedAlumniUserId: string | null, now: Date) {
    const nowIso = now.toISOString();
    const [row] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${reports.status} = 'open')`.mapWith(Number),
        inReview: sql<number>`count(*) filter (where ${reports.status} = 'in_review')`.mapWith(Number),
        overdue: sql<number>`count(*) filter (where ${reports.dueAt} <= ${nowIso}::timestamptz)`.mapWith(
          Number,
        ),
        urgent: sql<number>`count(*) filter (where ${reports.priority} = 'urgent')`.mapWith(Number),
        oldest: min(reports.createdAt),
      })
      .from(reports)
      .where(and(inArray(reports.status, [...ACTIVE_REPORT_STATUSES]), this.condition(linkedAlumniUserId)));
    return {
      open: row?.open ?? 0,
      inReview: row?.inReview ?? 0,
      overdue: row?.overdue ?? 0,
      urgent: row?.urgent ?? 0,
      oldest: row?.oldest ?? null,
    };
  }
}
