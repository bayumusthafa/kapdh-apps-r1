import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins, alumni, membershipEvents, messages, reports, roomMembers, users } from "@kapdh/database";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { fieldError, forbidden, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { type AccountStatus } from "../../core/membership/effective-status.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { decodeCursor, keysetAfter, type KeysetKey, pageOf } from "../../core/pagination/cursor.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { parseEvidence, type StoredEvidence } from "./evidence.js";
import { ACTIVE_REPORT_STATUSES, ModerationVisibility } from "./moderation-visibility.js";
import { loadAdminRefs, loadPeople, type PersonRow, toParty, toTargetMember } from "./parties.js";

type Detail = components["schemas"]["AdminModerationReportDetail"];
type Item = components["schemas"]["AdminModerationReportItem"];
type Page = components["schemas"]["AdminModerationReportPage"];
type Evidence = components["schemas"]["AdminModerationEvidence"];
type EvidenceImage = components["schemas"]["AdminModerationEvidenceImage"];
type HistoryEntry = components["schemas"]["AdminModerationHistoryEntry"];
type StatusFilter = components["schemas"]["AdminModerationStatusFilter"];
type Sort = components["schemas"]["AdminModerationSort"];
type Priority = components["schemas"]["ModerationReportPriority"];
type Category = components["schemas"]["ModerationReportCategory"];
type TargetType = components["schemas"]["ModerationTargetType"];
type Action = components["schemas"]["ModerationAction"];

export interface QueueQuery {
  status: StatusFilter;
  priority?: Priority;
  category?: Category;
  targetType?: TargetType;
  overdue?: boolean;
  q?: string;
  sort: Sort;
  cursor?: string;
  limit: number;
}

export interface ResolveInput {
  action: Action;
  note: string;
  memberMessage: string | null;
  subjectUserId: string | null;
  removeMessage: boolean;
  confirm: boolean;
}

/** Riwayat moderasi pihak terlapor yang ditampilkan (kontrak target_history maksimal 20). */
const HISTORY_LIMIT = 20;
/** Keanggotaan grup yang menandakan "anggota atau mantan anggota" untuk subject_user_id. */
const MEMBER_OR_FORMER = ["joined", "left", "removed"] as const;
/** Rute aturan komunitas untuk notifikasi peringatan (ARCHITECTURE §8.4 /legal/:slug; seed halaman legal). */
const COMMUNITY_RULES_ROUTE = "/legal/ketentuan-komunitas";
/** Rute riwayat laporan/banding anggota (kontrak C6 handoff: hasil moderasi dan banding → /account/reports). */
const MY_REPORTS_ROUTE = "/account/reports";

/** Baris antrean (laporan + subjek terkini + nama pengklaim) tanpa bukti maupun deskripsi. */
interface QueueRow {
  id: string;
  category: Category;
  priority: Priority;
  status: components["schemas"]["ModerationReportStatus"];
  targetType: TargetType;
  targetUserId: string | null;
  roomId: string | null;
  createdAt: Date;
  dueAt: Date;
  claimedByAdminId: string | null;
  claimedAt: Date | null;
  action: Action | null;
  resolvedAt: Date | null;
  roomName: string | null;
  subjectStatus: string | null;
  subjectName: string | null;
  subjectNumber: string | null;
  subjectCohort: number | null;
  claimerName: string | null;
}

/** Keputusan/klaim kalah karena versi berubah atau laporan sudah diputus → 409 dengan detail terbaru. */
class StaleReportError extends Error {
  override name = "StaleReportError";
}

const cursorSchema = z.object({
  s: z.enum(["due", "newest", "oldest"]),
  due_at: z.coerce.date().optional(),
  created_at: z.coerce.date(),
  id: z.uuid(),
});

const isActive = (status: string) => (ACTIVE_REPORT_STATUSES as readonly string[]).includes(status);

/**
 * Moderasi oleh pengurus (F-12, F-15; PRD 3.12, 4.5; kontrak admin-moderation.yaml): antrean dengan SLA dan konflik
 * kepentingan, detail berbukti terminimalkan yang setiap pembacaannya diaudit, klaim, dan keputusan
 * dismiss/warn/suspend/unsuspend (AC F12-3..F12-5) yang atomik: status laporan, efek keanggotaan lewat
 * MembershipKernel, membership_events, audit dan outbox notifikasi dalam satu transaksi (AC F17-1, F04-1).
 *
 * URUTAN KUNCI keputusan: users → alumni subjek (sama dengan kernel suspend/unsuspend dan POST /appeals), lalu baris
 * laporan, lalu (kernel) banding aktif subjek, lalu pesan terlapor. Klaim hanya mengunci baris laporan.
 */
@Injectable()
export class AdminReportsService {
  private readonly subjectUsers = alias(users, "subject_users");
  private readonly subjectAlumni = alias(alumni, "subject_alumni");
  private readonly claimers = alias(admins, "claimers");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly membership: MembershipKernel,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly visibility: ModerationVisibility,
  ) {}

  // --------------------------------------------------------------------------------------------------- antrean

  /**
   * GET /admin/reports: bawaan status active urut due (due_at naik, created_at, id). Konflik kepentingan dikecualikan
   * dari items, total, counts dan q (ModerationVisibility). Item tanpa bukti, deskripsi, maupun identitas pelapor.
   */
  async list(auth: AuthContext, query: QueueQuery): Promise<Page> {
    const now = this.clock.now();
    const after = query.cursor ? decodeCursor(query.cursor, cursorSchema) : null;
    if (after && (after.s !== query.sort || (query.sort === "due" && !after.due_at)))
      throw fieldError("cursor", "Cursor tidak valid. Muat ulang daftar dari awal.");

    const filters: (SQL | undefined)[] = [
      this.visibility.condition(auth.linkedAlumniUserId),
      query.status === "active"
        ? inArray(reports.status, [...ACTIVE_REPORT_STATUSES])
        : query.status === "all"
          ? undefined
          : eq(reports.status, query.status),
      query.priority ? eq(reports.priority, query.priority) : undefined,
      query.category ? eq(reports.category, query.category) : undefined,
      query.targetType ? eq(reports.targetType, query.targetType) : undefined,
      // overdue=true: hanya laporan aktif yang melewati due_at; false tidak menambah saringan.
      query.overdue === true
        ? and(inArray(reports.status, [...ACTIVE_REPORT_STATUSES]), lte(reports.dueAt, now))
        : undefined,
      query.q ? this.searchCondition(query.q) : undefined,
    ];
    const where = and(...filters);
    const keys = this.sortKeys(query.sort, after);
    const rows = await this.queueQuery()
      .where(and(where, after ? keysetAfter(keys) : undefined))
      .orderBy(...keys.map((key) => (key.direction === "asc" ? asc(key.column) : desc(key.column))))
      .limit(query.limit + 1);
    const [total] = await this.db
      .select({ value: count() })
      .from(reports)
      .leftJoin(this.subjectUsers, eq(this.subjectUsers.id, reports.targetUserId))
      .leftJoin(this.subjectAlumni, eq(this.subjectAlumni.userId, reports.targetUserId))
      .where(where);
    const page = pageOf(rows, query.limit, {
      total: Number(total?.value ?? 0),
      cursorOf: (row) => ({
        s: query.sort,
        ...(query.sort === "due" ? { due_at: row.dueAt } : {}),
        created_at: row.createdAt,
        id: row.id,
      }),
      toItem: (row) => this.toItem(row, now),
    });
    return { ...page, counts: await this.visibility.counts(auth.linkedAlumniUserId, now) };
  }

  private sortKeys(sort: Sort, after: z.infer<typeof cursorSchema> | null): KeysetKey[] {
    switch (sort) {
      case "due":
        return [
          { column: reports.dueAt, value: after?.due_at, direction: "asc" },
          { column: reports.createdAt, value: after?.created_at, direction: "asc" },
          { column: reports.id, value: after?.id, direction: "asc" },
        ];
      case "newest":
        return [
          { column: reports.createdAt, value: after?.created_at, direction: "desc" },
          { column: reports.id, value: after?.id, direction: "desc" },
        ];
      case "oldest":
        return [
          { column: reports.createdAt, value: after?.created_at, direction: "asc" },
          { column: reports.id, value: after?.id, direction: "asc" },
        ];
    }
  }

  /** `q`: nama (mengandung) atau nomor anggota (awalan) pihak terlapor/pemohon yang akunnya masih ada. */
  private searchCondition(q: string): SQL {
    const escaped = q.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    return and(
      isNotNull(reports.targetUserId),
      ne(this.subjectUsers.status, "deleted"),
      or(
        ilike(this.subjectAlumni.fullName, `%${escaped}%`),
        ilike(this.subjectAlumni.memberNumber, `${escaped}%`),
      ),
    )!;
  }

  private queueQuery(db: DbOrTx = this.db) {
    return db
      .select({
        id: reports.id,
        category: reports.category,
        priority: reports.priority,
        status: reports.status,
        targetType: reports.targetType,
        targetUserId: reports.targetUserId,
        roomId: reports.roomId,
        createdAt: reports.createdAt,
        dueAt: reports.dueAt,
        claimedByAdminId: reports.claimedByAdminId,
        claimedAt: reports.claimedAt,
        action: reports.action,
        resolvedAt: reports.resolvedAt,
        roomName: sql<string | null>`${reports.evidence} ->> 'room_name'`,
        subjectStatus: this.subjectUsers.status,
        subjectName: this.subjectAlumni.fullName,
        subjectNumber: this.subjectAlumni.memberNumber,
        subjectCohort: this.subjectAlumni.cohort,
        claimerName: this.claimers.displayName,
      })
      .from(reports)
      .leftJoin(this.subjectUsers, eq(this.subjectUsers.id, reports.targetUserId))
      .leftJoin(this.subjectAlumni, eq(this.subjectAlumni.userId, reports.targetUserId))
      .leftJoin(this.claimers, eq(this.claimers.id, reports.claimedByAdminId))
      .$dynamic();
  }

  private toItem(row: QueueRow, now: Date): Item {
    const subjectAlive =
      row.targetUserId !== null && row.subjectName !== null && row.subjectStatus !== "deleted";
    return {
      id: row.id,
      category: row.category,
      priority: row.priority,
      status: row.status,
      target_type: row.targetType,
      subject: subjectAlive
        ? {
            user_id: row.targetUserId!,
            full_name: row.subjectName!,
            member_number: row.subjectNumber,
            cohort: row.subjectCohort,
          }
        : null,
      room_name: row.roomName,
      created_at: row.createdAt.toISOString(),
      due_at: row.dueAt.toISOString(),
      overdue: isActive(row.status) && row.dueAt.getTime() <= now.getTime(),
      claimed_by:
        row.claimedByAdminId && row.claimerName
          ? { admin_id: row.claimedByAdminId, display_name: row.claimerName }
          : null,
      claimed_at: row.claimedAt?.toISOString() ?? null,
      action: row.action,
      resolved_at: row.resolvedAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------------------------------- detail

  /**
   * GET /admin/reports/{reportId}: detail berbukti. Pemanggil yang tertaut ke pihak terlapor → 404 tanpa audit.
   * Setiap pembacaan lain menulis audit `moderation.report_viewed` SEBELUM respons dikirim; kegagalan audit
   * membatalkan respons (AC F17-1). Isi bukti tidak disalin ke audit.
   */
  async get(auth: AuthContext, reportId: string): Promise<Detail> {
    const detail = await this.buildDetail(auth, reportId);
    if (!detail) throw notFound("Laporan tidak ditemukan.");
    await this.db.transaction((tx) => this.auditViewed(tx, detail));
    return detail;
  }

  private async auditViewed(tx: Tx, detail: Detail): Promise<void> {
    await this.audit.write(tx, {
      action: "moderation.report_viewed",
      entityType: "report",
      entityId: detail.id,
      after: {
        status: detail.status,
        version: detail.version,
        evidence_captured_at: detail.evidence.captured_at,
        evidence_message_ids: detail.evidence.messages.map((message) => message.message_id),
        conflict_of_interest: detail.conflict_of_interest,
      },
    });
  }

  /**
   * Detail untuk pemanggil, atau null bila laporan tidak ada ATAU pemanggil tertaut ke pihak terlapor (aturan domain
   * butir a: tidak dapat dibedakan dari laporan yang tidak ada).
   */
  async buildDetail(auth: AuthContext, reportId: string, db: DbOrTx = this.db): Promise<Detail | null> {
    const [row] = await this.queueQuery(db).where(eq(reports.id, reportId)).limit(1);
    if (!row) return null;
    if (await this.visibility.isReportedParty(row, auth.linkedAlumniUserId, db)) return null;
    const [full] = await db
      .select({
        reporterId: reports.reporterId,
        description: reports.description,
        evidence: reports.evidence,
        version: reports.version,
        resolutionNote: reports.resolutionNote,
        memberMessage: reports.memberMessage,
        messageRemovedAt: reports.messageRemovedAt,
        resolvedByAdminId: reports.resolvedByAdminId,
      })
      .from(reports)
      .where(eq(reports.id, reportId))
      .limit(1);
    if (!full) return null;
    const now = this.clock.now();
    const stored = parseEvidence(full.evidence, row.createdAt);
    const people = await loadPeople(db, [
      full.reporterId,
      row.targetUserId,
      stored.profile?.user_id,
      ...stored.messages.map((message) => message.sender_user_id),
    ]);
    const adminRefs = await loadAdminRefs(db, [
      full.resolvedByAdminId,
      stored.contested_suspension?.suspended_by_admin_id,
    ]);
    const target = row.targetUserId ? people.get(row.targetUserId) : undefined;
    const [history, openAgainst] = row.targetUserId
      ? await Promise.all([
          this.history(db, row.targetUserId),
          this.openAgainst(db, row.targetUserId, row.id),
        ])
      : [[], 0];
    const decided = row.status === "resolved" || row.status === "dismissed";
    return {
      ...this.toItem(row, now),
      description: full.description,
      reporter: toParty(full.reporterId ? people.get(full.reporterId) : undefined),
      target_member: toTargetMember(target, now),
      room_id: row.roomId,
      evidence: await this.toEvidence(db, stored, people, adminRefs, target, auth),
      target_history: history,
      open_reports_against_target: openAgainst,
      resolution:
        decided && row.action
          ? {
              action: row.action,
              note: full.resolutionNote ?? "",
              member_message: full.memberMessage,
              message_removed: full.messageRemovedAt !== null,
              resolved_at: (row.resolvedAt ?? row.createdAt).toISOString(),
              resolved_by: full.resolvedByAdminId ? (adminRefs.get(full.resolvedByAdminId) ?? null) : null,
            }
          : null,
      conflict_of_interest: auth.linkedAlumniUserId !== null && full.reporterId === auth.linkedAlumniUserId,
      version: String(full.version),
    };
  }

  /**
   * Bukti dari snapshot saat laporan dibuat (PRD 3.12): identitas, foto dan isi chat pihak yang akunnya sudah dihapus
   * tampil anonim/placeholder (D2, AC F14-3), gambar lewat URL bertanda tangan <= 10 menit yang terikat sesi admin
   * (kebijakan akses berkas bukti didaftarkan modul ini), `deleted_since_report` dari keadaan pesan terkini, `in_force`
   * banding dari suspend terkini.
   */
  private async toEvidence(
    db: DbOrTx,
    stored: StoredEvidence,
    people: Map<string, PersonRow>,
    adminRefs: Map<string, { admin_id: string; display_name: string }>,
    target: PersonRow | undefined,
    auth: AuthContext,
  ): Promise<Evidence> {
    const ids = stored.messages.map((message) => message.message_id);
    const current = ids.length
      ? await db
          .select({ id: messages.id, deletedAt: messages.deletedAt })
          .from(messages)
          .where(inArray(messages.id, ids))
      : [];
    const deletedNow = new Map(current.map((message) => [message.id, message.deletedAt !== null]));
    const evidenceMessages = await Promise.all(
      stored.messages.map(async (message) => {
        const sender = message.sender_user_id ? people.get(message.sender_user_id) : undefined;
        const senderGone = message.sender_user_id === null || sender === undefined;
        // D2 / AC F14-3: isi chat buatan akun yang sudah dihapus menjadi placeholder tanpa isi, juga di bukti
        // (sebelum maupun sesudah job penghapusan membersihkan snapshot lewat anonymizeEvidenceOf). Pesan sistem
        // (tanpa pengirim) tetap tampil.
        const senderDeleted = message.sender_user_id !== null && sender === undefined;
        return {
          message_id: message.message_id,
          reported: message.reported,
          sender_user_id: senderGone ? null : message.sender_user_id,
          sender_name: senderGone ? null : message.sender_name,
          kind: message.kind,
          body: senderDeleted ? null : message.body,
          image: message.image_file_id ? await this.image(message.image_file_id, auth, senderGone) : null,
          created_at: message.created_at,
          deleted_since_report: deletedNow.get(message.message_id) ?? true,
        };
      }),
    );
    const profileOwner = stored.profile ? people.get(stored.profile.user_id) : undefined;
    const contested = stored.contested_suspension;
    return {
      captured_at: stored.captured_at,
      messages: evidenceMessages,
      room: stored.room
        ? {
            room_id: stored.room.room_id,
            kind: stored.room.kind,
            name: stored.room.name,
            avatar: stored.room.avatar_file_id
              ? await this.image(stored.room.avatar_file_id, auth, false)
              : null,
            member_count: stored.room.member_count,
          }
        : null,
      profile: stored.profile
        ? profileOwner
          ? {
              full_name: stored.profile.full_name,
              bio: stored.profile.bio,
              avatar: stored.profile.avatar_file_id
                ? await this.image(stored.profile.avatar_file_id, auth, false)
                : null,
            }
          : { full_name: null, bio: null, avatar: null }
        : null,
      contested_suspension: contested
        ? {
            membership_event_id: contested.membership_event_id,
            suspended_at: contested.suspended_at,
            suspension_reason: contested.suspension_reason,
            suspension_message: contested.suspension_message,
            suspended_by: contested.suspended_by_admin_id
              ? (adminRefs.get(contested.suspended_by_admin_id) ?? null)
              : null,
            in_force: target?.suspendedAt?.toISOString() === contested.suspended_at,
          }
        : null,
    };
  }

  /** Gambar bukti: URL bertanda tangan terikat sesi admin; berkas terhapus (D2/AC F14-3) → url null. */
  private async image(fileId: string, auth: AuthContext, ownerGone: boolean): Promise<EvidenceImage> {
    if (ownerGone) return { file_id: null, url: null, url_expires_at: null };
    const file = await this.files.findReady(fileId);
    if (!file) return { file_id: fileId, url: null, url_expires_at: null };
    const signed = await this.files.signedUrl(file, {
      userId: auth.userId,
      sessionId: auth.sessionId,
      sessionVersion: auth.sessionVersion,
    });
    return { file_id: file.id, url: signed.url, url_expires_at: signed.expiresAt?.toISOString() ?? null };
  }

  /** Riwayat warn/suspend/unsuspend pihak terlapor, terbaru dulu (maksimal 20). */
  private async history(db: DbOrTx, userId: string): Promise<HistoryEntry[]> {
    const found = await db
      .select({
        kind: membershipEvents.kind,
        reason: membershipEvents.reason,
        actorName: admins.displayName,
        createdAt: membershipEvents.createdAt,
      })
      .from(membershipEvents)
      .leftJoin(admins, eq(admins.id, membershipEvents.actorAdminId))
      .where(
        and(
          eq(membershipEvents.userId, userId),
          inArray(membershipEvents.kind, ["warn", "suspend", "unsuspend"]),
        ),
      )
      .orderBy(desc(membershipEvents.createdAt), desc(membershipEvents.id))
      .limit(HISTORY_LIMIT);
    return found.map((entry) => ({
      kind: entry.kind as HistoryEntry["kind"],
      reason: entry.reason,
      actor_name: entry.actorName,
      created_at: entry.createdAt.toISOString(),
    }));
  }

  /** Laporan aktif lain terhadap pihak terlapor yang sama. */
  private async openAgainst(db: DbOrTx, userId: string, exceptId: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(reports)
      .where(
        and(
          eq(reports.targetUserId, userId),
          inArray(reports.status, [...ACTIVE_REPORT_STATUSES]),
          ne(reports.id, exceptId),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /** 409 VERSION_CONFLICT dengan detail terbaru; bukti yang dikirim dalam `current` juga diaudit. */
  private async conflict(auth: AuthContext, reportId: string): Promise<never> {
    const current = await this.buildDetail(auth, reportId);
    if (!current) throw notFound("Laporan tidak ditemukan.");
    await this.db.transaction((tx) => this.auditViewed(tx, current));
    throw versionConflict(
      current,
      "Laporan sudah diubah atau diputus pengurus lain. Muat ulang untuk melihat keadaan terbaru.",
    );
  }

  /** Baris laporan terkunci FOR UPDATE beserta pemeriksaan konflik kepentingan (404 terlapor, 403 pelapor). */
  private async lockReport(tx: Tx, auth: AuthContext, reportId: string) {
    const [row] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
    if (!row || (await this.visibility.isReportedParty(row, auth.linkedAlumniUserId, tx)))
      throw notFound("Laporan tidak ditemukan.");
    if (auth.linkedAlumniUserId && row.reporterId === auth.linkedAlumniUserId)
      throw forbidden("Anda tidak dapat menangani laporan yang Anda kirim sendiri (konflik kepentingan).");
    return row;
  }

  // ------------------------------------------------------------------------------------------------------ klaim

  /**
   * POST /admin/reports/{reportId}/claim: open → in_review dengan claimed_by/claimed_at (UPDATE bersyarat versi).
   * Klaim ulang oleh pengurus yang sama idempoten; ambil alih klaim pengurus lain bila If-Match sama dengan versi yang
   * dibaca. Versi berbeda atau laporan sudah diputus → 409 dengan detail terbaru.
   */
  async claim(auth: AuthContext, reportId: string, expectedVersion: number): Promise<Detail> {
    const adminId = auth.adminId!;
    try {
      await this.db.transaction(async (tx) => {
        const row = await this.lockReport(tx, auth, reportId);
        if (row.status === "in_review" && row.claimedByAdminId === adminId) return;
        if (!isActive(row.status) || row.version !== expectedVersion) throw new StaleReportError();
        const now = this.clock.now();
        const [updated] = await tx
          .update(reports)
          .set({
            status: "in_review",
            claimedByAdminId: adminId,
            claimedAt: now,
            version: sql`${reports.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(reports.id, reportId),
              eq(reports.version, expectedVersion),
              inArray(reports.status, [...ACTIVE_REPORT_STATUSES]),
            ),
          )
          .returning({ version: reports.version });
        if (!updated) throw new StaleReportError();
        await this.audit.write(tx, {
          action: "moderation.report_claimed",
          entityType: "report",
          entityId: reportId,
          before: {
            status: row.status,
            claimed_by_admin_id: row.claimedByAdminId,
            version: row.version,
          },
          after: {
            status: "in_review",
            claimed_by_admin_id: adminId,
            claimed_at: now,
            taken_over: row.status === "in_review",
            version: updated.version,
          },
        });
      });
    } catch (error) {
      if (error instanceof StaleReportError) return this.conflict(auth, reportId);
      throw error;
    }
    return (await this.buildDetail(auth, reportId))!;
  }

  // -------------------------------------------------------------------------------------------------- keputusan

  /**
   * POST /admin/reports/{reportId}/resolve (AC F12-3..F12-5): satu keputusan per laporan dengan versi If-Match.
   * Semuanya atomik: status laporan, efek keanggotaan (MembershipKernel), membership_events, audit beralasan dengan
   * rujukan bukti, outbox notifikasi. Banding hanya dismiss (ditolak) atau unsuspend (dikabulkan); banding usang
   * (suspend yang dibanding sudah dicabut) hanya unsuspend tanpa perubahan keanggotaan.
   */
  async resolve(
    auth: AuthContext,
    reportId: string,
    expectedVersion: number,
    input: ResolveInput,
  ): Promise<Detail> {
    const adminId = auth.adminId!;
    const [pre] = await this.db
      .select({
        category: reports.category,
        targetType: reports.targetType,
        targetUserId: reports.targetUserId,
        roomId: reports.roomId,
        reporterId: reports.reporterId,
      })
      .from(reports)
      .where(eq(reports.id, reportId))
      .limit(1);
    if (!pre || (await this.visibility.isReportedParty(pre, auth.linkedAlumniUserId)))
      throw notFound("Laporan tidak ditemukan.");
    if (auth.linkedAlumniUserId && pre.reporterId === auth.linkedAlumniUserId)
      throw forbidden("Anda tidak dapat menangani laporan yang Anda kirim sendiri (konflik kepentingan).");
    const subjectId = await this.validateDecision(auth, pre, input);
    const isAppeal = pre.category === "appeal";
    const lockSubject = input.action !== "dismiss" || isAppeal ? subjectId : null;

    try {
      await this.db.transaction(async (tx) => {
        const subject = lockSubject ? await this.lockSubject(tx, lockSubject) : undefined;
        const row = await this.lockReport(tx, auth, reportId);
        if (!isActive(row.status) || row.version !== expectedVersion) throw new StaleReportError();
        // target_user_id hanya berubah lewat keputusan (laporan grup) atau SET NULL saat akun dihapus.
        if (row.targetType !== "room" && row.targetUserId !== pre.targetUserId) throw new StaleReportError();

        const now = this.clock.now();
        const evidence = parseEvidence(row.evidence, row.createdAt);
        const contestedAt = evidence.contested_suspension?.suspended_at ?? null;
        // Banding usang: suspend yang dibanding tidak lagi berlaku (dicabut lewat jalur yang tidak menutup bandingnya).
        const staleAppeal =
          isAppeal &&
          subject !== undefined &&
          subject.accountStatus !== "deleted" &&
          subject.suspendedAt?.toISOString() !== contestedAt;
        if (
          (input.action === "warn" ||
            input.action === "suspend" ||
            (input.action === "unsuspend" && !staleAppeal)) &&
          (!subject || subject.accountStatus === "deleted")
        )
          throw fieldError(
            "action",
            "Akun pihak terlapor sudah dihapus; laporan hanya dapat ditutup dengan dismiss.",
          );
        let membershipEventId: string | null = null;
        let closedAppealIds: string[] = [];
        let membershipUnchanged = input.action === "dismiss";

        switch (input.action) {
          case "dismiss":
            if (staleAppeal)
              throw fieldError(
                "action",
                "Suspend yang dibanding sudah dicabut; tutup banding ini dengan unsuspend (dikabulkan).",
              );
            break;
          case "warn": {
            if (!subject || subject.accountStatus !== "active")
              throw fieldError(
                "action",
                "Akun pihak terlapor tidak aktif sehingga tidak dapat diberi peringatan.",
              );
            membershipEventId = await this.warn(tx, subjectId!, subject, input, row.id, adminId, now);
            break;
          }
          case "suspend": {
            const outcome = await this.membership.suspend(tx, subjectId!, {
              reason: input.note,
              memberMessage: input.memberMessage!,
              actorAdminId: adminId,
            });
            membershipEventId = outcome.eventId;
            break;
          }
          case "unsuspend": {
            if (staleAppeal) {
              membershipUnchanged = true;
              break;
            }
            const outcome = await this.membership.unsuspend(tx, subjectId!, {
              reason: input.note,
              memberMessage: input.memberMessage,
              appealGranted: isAppeal,
              actorAdminId: adminId,
              appealResolutionNote: `Banding dikabulkan otomatis karena pembatasan dicabut melalui keputusan laporan ${row.id}.`,
              excludeAppealId: isAppeal ? row.id : undefined,
            });
            membershipEventId = outcome.eventId;
            closedAppealIds = outcome.closedAppealIds;
            break;
          }
        }

        const messageRemovedAt =
          input.removeMessage && row.targetMessageId
            ? await this.removeMessage(tx, row.targetMessageId, now)
            : null;
        const [updated] = await tx
          .update(reports)
          .set({
            status: input.action === "dismiss" ? "dismissed" : "resolved",
            action: input.action,
            resolutionNote: input.note,
            memberMessage: input.memberMessage,
            resolvedByAdminId: adminId,
            resolvedAt: now,
            targetUserId: row.targetType === "room" ? subjectId : row.targetUserId,
            messageRemovedAt,
            version: sql`${reports.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(reports.id, row.id),
              eq(reports.version, expectedVersion),
              inArray(reports.status, [...ACTIVE_REPORT_STATUSES]),
            ),
          )
          .returning({ version: reports.version });
        if (!updated) throw new StaleReportError();

        // AC F12-3: alasan, aktor (ctx), waktu dan rujukan bukti keputusan; isi bukti tidak disalin.
        await this.audit.write(tx, {
          action: "moderation.report_resolved",
          entityType: "report",
          entityId: row.id,
          reason: input.note,
          before: { status: row.status, version: row.version, target_user_id: row.targetUserId },
          after: {
            status: input.action === "dismiss" ? "dismissed" : "resolved",
            action: input.action,
            outcome: input.action === "dismiss" ? "no_action" : "action_taken",
            category: row.category,
            subject_user_id: subjectId,
            membership_event_id: membershipEventId,
            membership_unchanged: membershipUnchanged,
            stale_appeal: staleAppeal,
            closed_appeal_ids: closedAppealIds,
            message_removed: messageRemovedAt !== null,
            member_message_sent: input.memberMessage !== null,
            evidence_captured_at: evidence.captured_at,
            evidence_message_ids: evidence.messages.map((message) => message.message_id),
            version: updated.version,
          },
        });
        await this.notifyOutcome(tx, row, input, { isAppeal, staleAppeal, subjectId });
      });
    } catch (error) {
      if (error instanceof StaleReportError) return this.conflict(auth, reportId);
      throw error;
    }
    return (await this.buildDetail(auth, reportId))!;
  }

  /**
   * Validasi keputusan terhadap jenis laporan (kontrak AdminModerationResolveRequest) sebelum transaksi; mengembalikan
   * subjek tindakan: target_user_id laporan, atau `subject_user_id` (anggota/mantan anggota grup) untuk laporan grup.
   */
  private async validateDecision(
    auth: AuthContext,
    report: { category: string; targetType: TargetType; targetUserId: string | null; roomId: string | null },
    input: ResolveInput,
  ): Promise<string | null> {
    const isAppeal = report.category === "appeal";
    const acting = input.action !== "dismiss";
    if (isAppeal && input.action !== "dismiss" && input.action !== "unsuspend")
      throw fieldError("action", "Banding hanya dapat ditolak (dismiss) atau dikabulkan (unsuspend).");
    if ((input.action === "warn" || input.action === "suspend" || isAppeal) && !input.memberMessage)
      throw fieldError("member_message", "Pesan untuk anggota wajib diisi untuk keputusan ini.");
    if ((input.action === "suspend" || input.action === "unsuspend") && !input.confirm)
      throw fieldError("confirm", "Konfirmasi tindakan wajib (confirm: true).");
    if (input.removeMessage && report.targetType !== "message")
      throw fieldError("remove_message", "Penghapusan pesan hanya untuk laporan pesan.");
    if (input.subjectUserId !== null && report.targetType !== "room")
      throw fieldError("subject_user_id", "Subjek hanya dipilih untuk laporan grup.");
    if (report.targetType !== "room") {
      if (acting && !report.targetUserId)
        throw fieldError(
          "action",
          "Akun pihak terlapor sudah dihapus; laporan hanya dapat ditutup dengan dismiss.",
        );
      return report.targetUserId;
    }
    if (!acting) {
      if (input.subjectUserId !== null)
        throw fieldError("subject_user_id", "Subjek hanya dipilih untuk warn, suspend, atau unsuspend.");
      return null;
    }
    if (input.subjectUserId === null)
      throw fieldError("subject_user_id", "Pilih anggota grup yang dikenai tindakan.");
    if (auth.linkedAlumniUserId && input.subjectUserId === auth.linkedAlumniUserId)
      throw forbidden(
        "Anda tidak dapat memutus perkara yang menyangkut akun Anda sendiri (konflik kepentingan).",
      );
    const [member] = report.roomId
      ? await this.db
          .select({ status: roomMembers.status })
          .from(roomMembers)
          .where(
            and(
              eq(roomMembers.roomId, report.roomId),
              eq(roomMembers.userId, input.subjectUserId),
              inArray(roomMembers.status, [...MEMBER_OR_FORMER]),
            ),
          )
          .limit(1)
      : [];
    if (!member) throw fieldError("subject_user_id", "Pilih anggota atau mantan anggota grup ini.");
    return input.subjectUserId;
  }

  /**
   * Kunci users (FOR NO KEY UPDATE) lalu alumni (FOR UPDATE) subjek: mode dan urutan yang SAMA dengan
   * MembershipKernel, sehingga kernel memakai ulang kunci ini tanpa menunggu dan tidak ada deadlock dengan
   * suspend/unsuspend dari menu anggota, POST /appeals, atau persetujuan iuran.
   */
  private async lockSubject(tx: Tx, userId: string) {
    const [user] = await tx
      .select({ status: users.status, kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    if (!user || user.kind !== "alumni") return undefined;
    const [member] = await tx
      .select({ suspendedAt: alumni.suspendedAt, startsAt: alumni.startsAt, expiresAt: alumni.expiresAt })
      .from(alumni)
      .where(eq(alumni.userId, userId))
      .for("update");
    return member ? { ...member, accountStatus: user.status as AccountStatus } : undefined;
  }

  /**
   * warn (AC F12-3): membership_events kind warn TANPA mengubah starts_at/expires_at (membership_events_warn_chk:
   * after_* kosong), audit `member.warned`, notifikasi kategori account berisi pesan aman untuk anggota.
   */
  private async warn(
    tx: Tx,
    userId: string,
    member: { startsAt: Date | null; expiresAt: Date | null },
    input: ResolveInput,
    reportId: string,
    adminId: string,
    now: Date,
  ): Promise<string> {
    const eventId = uuidv7();
    await tx.insert(membershipEvents).values({
      id: eventId,
      userId,
      kind: "warn",
      actorAdminId: adminId,
      reason: input.note,
      beforeStartsAt: member.startsAt,
      beforeExpiresAt: member.expiresAt,
      createdAt: now,
    });
    await this.audit.write(tx, {
      action: "member.warned",
      entityType: "alumni",
      entityId: userId,
      reason: input.note,
      after: {
        membership_event_id: eventId,
        report_id: reportId,
        member_message: input.memberMessage,
        starts_at: member.startsAt,
        expires_at: member.expiresAt,
      },
    });
    await this.notifications.notify(tx, {
      userId,
      category: "account",
      title: "Peringatan dari pengurus",
      body: input.memberMessage,
      route: COMMUNITY_RULES_ROUTE,
      dedupKey: `moderation.warned:${eventId}`,
    });
    return eventId;
  }

  /**
   * remove_message: pesan terlapor menjadi placeholder (deleted_at, isi dan gambar dikosongkan, AC F14-3 pola
   * placeholder); snapshot bukti tetap utuh dan berkas gambarnya ditahan retensi bukti. Anggota room menerima
   * `message.deleted` setelah commit. Pesan yang sudah dihapus pengirimnya tidak diubah (null = tidak ada yang dihapus).
   */
  private async removeMessage(tx: Tx, messageId: string, now: Date): Promise<Date | null> {
    const [removed] = await tx
      .update(messages)
      .set({ deletedAt: now, body: null, imageFileId: null })
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .returning({ id: messages.id, roomId: messages.roomId });
    if (!removed) return null;
    this.realtime.emitToRoom(removed.roomId, "message.deleted", removed.id, {
      room_id: removed.roomId,
      message_id: removed.id,
      deleted_at: now.toISOString(),
    });
    return now;
  }

  /**
   * Notifikasi hasil (kategori account, wajib): pelapor laporan biasa hanya diberi tahu laporannya selesai ditinjau
   * tanpa rincian tindakan (AC F12-2); pemohon banding menerima pesan pengurus (ditolak, atau dikabulkan untuk banding
   * usang; banding yang dikabulkan dengan unsuspend diberitahukan SATU kali oleh MembershipKernel). Subjek warn/suspend
   * diberi tahu oleh cabang tindakannya; pihak terlapor tidak pernah diberi tahu adanya laporan.
   */
  private async notifyOutcome(
    tx: Tx,
    row: { id: string; reporterId: string | null },
    input: ResolveInput,
    context: { isAppeal: boolean; staleAppeal: boolean; subjectId: string | null },
  ): Promise<void> {
    if (!context.isAppeal) {
      if (!row.reporterId || !(await this.accountAlive(tx, row.reporterId))) return;
      await this.notifications.notify(tx, {
        userId: row.reporterId,
        category: "account",
        title: "Laporan Anda selesai ditinjau",
        body: "Terima kasih. Pengurus telah meninjau laporan Anda dan menindaklanjutinya sesuai ketentuan komunitas.",
        route: MY_REPORTS_ROUTE,
        dedupKey: `moderation.report_reviewed:${row.id}`,
      });
      return;
    }
    const appellant = context.subjectId;
    if (!appellant || !(await this.accountAlive(tx, appellant))) return;
    if (input.action === "dismiss")
      await this.notifications.notify(tx, {
        userId: appellant,
        category: "account",
        title: "Banding ditolak",
        body: input.memberMessage,
        route: MY_REPORTS_ROUTE,
        dedupKey: `moderation.appeal_decided:${row.id}`,
      });
    else if (context.staleAppeal)
      await this.notifications.notify(tx, {
        userId: appellant,
        category: "account",
        title: "Banding dikabulkan",
        body: input.memberMessage,
        route: MY_REPORTS_ROUTE,
        dedupKey: `moderation.appeal_decided:${row.id}`,
      });
  }

  private async accountAlive(tx: Tx, userId: string): Promise<boolean> {
    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    return user !== undefined && user.status !== "deleted";
  }
}
