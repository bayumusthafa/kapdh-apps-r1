import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, membershipEvents, messages, reports, roomMembers, rooms, users } from "@kapdh/database";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, Tx } from "../../core/db/types.js";
import { AppException, fieldError, forbidden, notFound } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { dueAtFor, priorityFor } from "./due-at.js";
import { buildEvidence, parseEvidence, type StoredEvidence, type StoredEvidenceMessage } from "./evidence.js";
import { toMemberReport } from "./member-report.js";
import { ACTIVE_REPORT_STATUSES } from "./moderation-visibility.js";

type ModerationReport = components["schemas"]["ModerationReport"];
type ModerationReportPage = components["schemas"]["ModerationReportPage"];
type InputCategory = components["schemas"]["ModerationReportInputCategory"];

/** Laju pelaporan per pelapor (kontrak createReport 429). */
export const REPORT_RATE = { limit: 10, windowMs: 3600_000 } as const;
/** Laju banding per pemohon (kontrak createAppeal 429; banding baru boleh setelah ditolak). */
export const APPEAL_RATE = { limit: 5, windowMs: 24 * 3600_000 } as const;

/** Keanggotaan room yang menandakan "pernah berada di room yang sama" (kontrak createReport target user). */
const EVER_IN_ROOM = ["joined", "left", "removed"] as const;

export type CreateReportInput =
  | {
      targetType: "user";
      targetUserId: string;
      category: InputCategory;
      description: string | null;
    }
  | {
      targetType: "message";
      messageId: string;
      contextMessageIds: string[];
      category: InputCategory;
      description: string | null;
    }
  | { targetType: "room"; roomId: string; category: InputCategory; description: string | null };

export interface ReportResult {
  /** false bila laporan/banding aktif yang sama dikembalikan (200), true bila baru dibuat (201). */
  created: boolean;
  report: ModerationReport;
}

/** Kolom DB untuk tampilan pelapor; nama grup dari snapshot bukti (tanpa memuat seluruh bukti). */
const memberColumns = {
  id: reports.id,
  category: reports.category,
  targetType: reports.targetType,
  targetUserId: reports.targetUserId,
  description: reports.description,
  status: reports.status,
  priority: reports.priority,
  memberMessage: reports.memberMessage,
  createdAt: reports.createdAt,
  dueAt: reports.dueAt,
  resolvedAt: reports.resolvedAt,
  roomName: sql<string | null>`${reports.evidence} ->> 'room_name'`,
};

const cursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });

/**
 * Laporan dan banding milik anggota (F-12, PRD 3.12, AC F12-2): pelaporan pengguna/pesan/grup yang dapat diakses
 * pelapor dengan bukti terminimalkan, riwayat laporan sendiri, dan banding atas suspend yang sedang berlaku. Laporan
 * tidak pernah dibuka kepada pihak terlapor: tidak ada jalur yang memberi tahu terlapor bahwa ia dilaporkan.
 */
@Injectable()
export class ReportsService {
  private readonly targetAlumni = alias(alumni, "target_alumni");
  private readonly targetUsers = alias(users, "target_users");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  // ---------------------------------------------------------------------------------------------- baca pelapor

  /** GET /reports: hanya reporter = pemanggil, terbaru dulu (AC F12-2). */
  async listMine(auth: AuthContext, query: unknown): Promise<ModerationReportPage> {
    const page = parsePageQuery(query);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    const found = await this.memberQuery()
      .where(
        and(
          eq(reports.reporterId, auth.userId),
          after
            ? keysetAfter([
                { column: reports.createdAt, value: after.created_at, direction: "desc" },
                { column: reports.id, value: after.id, direction: "desc" },
              ])
            : undefined,
        ),
      )
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(page.limit + 1);
    return pageOf(found, page.limit, {
      cursorOf: (row) => ({ created_at: row.createdAt, id: row.id }),
      toItem: (row) => toMemberReport(row, row.targetName),
    });
  }

  /** GET /reports/{reportId}: hanya pelapor; milik orang lain → 404 tanpa membedakan alasan (N-09). */
  async getMine(auth: AuthContext, reportId: string): Promise<ModerationReport> {
    const [row] = await this.memberQuery()
      .where(and(eq(reports.id, reportId), eq(reports.reporterId, auth.userId)))
      .limit(1);
    if (!row) throw notFound("Laporan tidak ditemukan.");
    return toMemberReport(row, row.targetName);
  }

  /** Laporan + nama terkini pihak terlapor (null bila akun dihapus, D2). */
  private memberQuery(db: Db | Tx = this.db) {
    return db
      .select({
        ...memberColumns,
        targetName: sql<
          string | null
        >`case when ${this.targetUsers.status} = 'deleted' then null else ${this.targetAlumni.fullName} end`,
      })
      .from(reports)
      .leftJoin(this.targetUsers, eq(this.targetUsers.id, reports.targetUserId))
      .leftJoin(this.targetAlumni, eq(this.targetAlumni.userId, reports.targetUserId))
      .$dynamic();
  }

  private async loadMine(tx: Tx, reportId: string): Promise<ModerationReport> {
    const [row] = await this.memberQuery(tx).where(eq(reports.id, reportId)).limit(1);
    return toMemberReport(row!, row!.targetName);
  }

  // ----------------------------------------------------------------------------------------------- buat laporan

  /**
   * POST /reports (AC F12-2, PRD 3.12): target harus dapat diakses pelapor (selain itu 404), bukti terminimalkan
   * dicatat saat itu juga, prioritas/target penanganan dihitung server (violence_threat urgent 24 jam, lainnya 2 hari
   * kerja). Laporan aktif yang sama dari pelapor ini dikembalikan (200). Transaksi mengunci baris users pelapor lebih
   * dulu (dedup per pelapor), lalu baris sumber bukti FOR SHARE (pesan, profil, atau room) sehingga penghapusan pesan /
   * penggantian avatar bersamaan menunggu laporan commit dan berkas bukti ditahan (retensi core/files).
   */
  async create(auth: AuthContext, input: CreateReportInput): Promise<ReportResult> {
    if (input.targetType === "user" && input.targetUserId === auth.userId)
      throw fieldError("target_user_id", "Akun sendiri tidak dapat dilaporkan. Gunakan banding bila dibatasi.");
    await this.rateLimits.consumeOrThrow(
      `moderation-report:${auth.userId}`,
      REPORT_RATE.limit,
      REPORT_RATE.windowMs,
      "Terlalu banyak laporan dalam waktu singkat. Coba lagi nanti.",
    );
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, auth.userId))
        .for("no key update");
      const now = this.clock.now();
      const target =
        input.targetType === "user"
          ? await this.userTarget(tx, auth.userId, input.targetUserId, now)
          : input.targetType === "message"
            ? await this.messageTarget(tx, auth.userId, input.messageId, input.contextMessageIds, now)
            : await this.roomTarget(tx, auth.userId, input.roomId, now);

      const [existing] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.reporterId, auth.userId),
            eq(reports.targetType, input.targetType),
            inArray(reports.status, [...ACTIVE_REPORT_STATUSES]),
            input.targetType === "user"
              ? eq(reports.targetUserId, input.targetUserId)
              : input.targetType === "message"
                ? eq(reports.targetMessageId, input.messageId)
                : eq(reports.roomId, input.roomId),
          ),
        )
        .orderBy(asc(reports.createdAt))
        .limit(1);
      if (existing) return { created: false, report: await this.loadMine(tx, existing.id) };

      const id = uuidv7();
      const priority = priorityFor(input.category);
      const dueAt = dueAtFor(priority, now);
      await tx.insert(reports).values({
        id,
        reporterId: auth.userId,
        targetType: input.targetType,
        targetUserId: target.targetUserId,
        targetMessageId: input.targetType === "message" ? input.messageId : null,
        roomId: target.roomId,
        category: input.category,
        description: input.description,
        evidence: target.evidence,
        priority,
        status: "open",
        dueAt,
        createdAt: now,
        updatedAt: now,
      });
      // Isi deskripsi dan bukti tidak disalin ke audit (ARCHITECTURE §2 butir 3); hanya rujukan dan metadata.
      await this.audit.write(tx, {
        action: "moderation.report_created",
        entityType: "report",
        entityId: id,
        after: {
          category: input.category,
          target_type: input.targetType,
          priority,
          due_at: dueAt,
          evidence_captured_at: target.evidence.captured_at,
          evidence_message_count: target.evidence.messages.length,
        },
      });
      return { created: true, report: await this.loadMine(tx, id) };
    });
  }

  /**
   * Target pengguna: akun alumni lain yang terlihat di direktori bagi pelapor (verified/expiring, tidak suspended,
   * show_in_directory) ATAU pernah berada di room yang sama dengan pelapor; selain itu 404. Blokir dari pihak mana pun
   * tidak memengaruhi hasil sehingga laporan tidak mengungkap blokir (N-09). Bukti: profil publik minimum.
   */
  private async userTarget(tx: Tx, reporterId: string, targetUserId: string, now: Date) {
    const [account] = await tx
      .select({ kind: users.kind, status: users.status })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    if (!account || account.kind !== "alumni" || account.status === "pending_otp" || account.status === "deleted")
      throw notFound("Anggota tidak ditemukan.");
    // Baris alumni terkunci FOR SHARE: penggantian avatar bersamaan menunggu laporan ini commit (retensi bukti).
    const [row] = await tx
      .select({
        fullName: alumni.fullName,
        bio: alumni.bio,
        avatarFileId: alumni.avatarFileId,
        showInDirectory: alumni.showInDirectory,
        expiresAt: alumni.expiresAt,
        suspendedAt: alumni.suspendedAt,
      })
      .from(alumni)
      .where(eq(alumni.userId, targetUserId))
      .for("share");
    if (!row) throw notFound("Anggota tidak ditemukan.");
    const profile = { ...row, status: account.status };
    const inDirectory =
      profile.status === "active" &&
      profile.showInDirectory &&
      profile.suspendedAt === null &&
      profile.expiresAt !== null &&
      profile.expiresAt.getTime() > now.getTime();
    if (!inDirectory && !(await this.sharedRoom(tx, reporterId, targetUserId)))
      throw notFound("Anggota tidak ditemukan.");
    return {
      targetUserId,
      roomId: null,
      evidence: buildEvidence({
        capturedAt: now,
        profile: {
          user_id: targetUserId,
          full_name: profile.fullName,
          bio: profile.bio,
          avatar_file_id: profile.avatarFileId,
        },
      }),
    };
  }

  private async sharedRoom(tx: Tx, a: string, b: string): Promise<boolean> {
    const other = alias(roomMembers, "other_member");
    const [row] = await tx
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .innerJoin(other, and(eq(other.roomId, roomMembers.roomId), eq(other.userId, b)))
      .where(
        and(
          eq(roomMembers.userId, a),
          inArray(roomMembers.status, [...EVER_IN_ROOM]),
          inArray(other.status, [...EVER_IN_ROOM]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Target pesan: pesan orang lain di room tempat pelapor joined dan terlihat baginya (sejak history_visible_from,
   * belum dihapus); selain itu 404. Konteks opsional maksimal 5 pesan di room yang sama yang terlihat bagi pelapor.
   * Bukti: snapshot pesan (isi, gambar, pengirim, waktu), tetap tersedia walaupun pesan kemudian dihapus. Pengirim
   * menjadi pihak terlapor.
   */
  private async messageTarget(
    tx: Tx,
    reporterId: string,
    messageId: string,
    contextIds: string[],
    now: Date,
  ) {
    if (contextIds.includes(messageId))
      throw fieldError("context_message_ids", "Pesan yang dilaporkan tidak perlu dikirim sebagai konteks.");
    const [message] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .for("share");
    if (!message) throw notFound("Pesan tidak ditemukan.");
    const [membership] = await tx
      .select({ historyVisibleFrom: roomMembers.historyVisibleFrom })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, message.roomId),
          eq(roomMembers.userId, reporterId),
          eq(roomMembers.status, "joined"),
        ),
      )
      .limit(1);
    const visible = (createdAt: Date) =>
      !membership!.historyVisibleFrom || createdAt.getTime() >= membership!.historyVisibleFrom.getTime();
    if (!membership || !visible(message.createdAt) || message.deletedAt)
      throw notFound("Pesan tidak ditemukan.");
    if (message.kind === "system")
      throw fieldError("message_id", "Pesan sistem tidak dapat dilaporkan.");
    if (message.senderId === reporterId)
      throw fieldError("message_id", "Pesan sendiri tidak dapat dilaporkan.");
    if (!message.senderId) throw notFound("Pesan tidak ditemukan.");

    const context = contextIds.length
      ? await tx
          .select()
          .from(messages)
          .where(and(inArray(messages.id, contextIds), eq(messages.roomId, message.roomId)))
          .orderBy(asc(messages.id))
          .for("share")
      : [];
    if (
      context.length !== contextIds.length ||
      context.some((row) => row.deletedAt !== null || !visible(row.createdAt))
    )
      throw fieldError(
        "context_message_ids",
        "Pesan konteks harus pesan di room yang sama yang masih dapat Anda lihat.",
      );

    const [room] = await tx
      .select({ kind: rooms.kind, name: rooms.name })
      .from(rooms)
      .where(eq(rooms.id, message.roomId))
      .limit(1);
    const all = [message, ...context].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );
    const senders = await this.namesOf(
      tx,
      all.map((row) => row.senderId),
    );
    const snapshot: StoredEvidenceMessage[] = all.map((row) => ({
      message_id: row.id,
      reported: row.id === message.id,
      sender_user_id: row.senderId,
      sender_name: row.senderId ? (senders.get(row.senderId) ?? null) : null,
      kind: row.kind,
      body: row.body,
      image_file_id: row.imageFileId,
      created_at: row.createdAt.toISOString(),
    }));
    return {
      targetUserId: message.senderId,
      roomId: message.roomId,
      evidence: buildEvidence({
        capturedAt: now,
        roomName: room?.kind === "group" ? room.name : null,
        messages: snapshot,
      }),
    };
  }

  /**
   * Target grup: room group tempat pelapor joined; room direct → 400 (laporkan pengguna/pesannya). Bukti: nama,
   * avatar (rujukan berkas saat itu) dan jumlah anggota joined. Baris room FOR SHARE agar penggantian avatar grup
   * bersamaan menunggu laporan commit.
   */
  private async roomTarget(tx: Tx, reporterId: string, roomId: string, now: Date) {
    const [room] = await tx
      .select({ id: rooms.id, kind: rooms.kind, name: rooms.name, avatarFileId: rooms.avatarFileId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1)
      .for("share");
    const [membership] = room
      ? await tx
          .select({ status: roomMembers.status })
          .from(roomMembers)
          .where(
            and(
              eq(roomMembers.roomId, roomId),
              eq(roomMembers.userId, reporterId),
              eq(roomMembers.status, "joined"),
            ),
          )
          .limit(1)
      : [];
    if (!room || !membership) throw notFound("Grup tidak ditemukan.");
    if (room.kind !== "group")
      throw fieldError("room_id", "Percakapan langsung tidak dapat dilaporkan sebagai grup. Laporkan pengguna atau pesannya.");
    const [joined] = await tx
      .select({ value: count() })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "joined")));
    return {
      targetUserId: null,
      roomId,
      evidence: buildEvidence({
        capturedAt: now,
        roomName: room.name,
        room: {
          room_id: room.id,
          kind: room.kind,
          name: room.name,
          avatar_file_id: room.avatarFileId,
          member_count: Math.min(100, Number(joined?.value ?? 0)),
        },
      }),
    };
  }

  /** Nama tampilan pengirim saat ini (snapshot bukti). */
  private async namesOf(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const found = await tx
      .select({ userId: alumni.userId, fullName: alumni.fullName })
      .from(alumni)
      .where(inArray(alumni.userId, unique));
    return new Map(found.map((row) => [row.userId, row.fullName]));
  }

  // ------------------------------------------------------------------------------------------------- banding

  /**
   * POST /appeals (PRD 3.12 mekanisme banding; kontrak createAppeal): hanya untuk suspend yang SEDANG berlaku (selain
   * itu 403). Mengunci users → alumni pemohon lebih dulu (urutan yang sama dengan suspend/unsuspend), sehingga
   * pengajuan paralel dan pencabutan suspend berurutan. Banding aktif atas suspend yang sama dikembalikan (200); banding
   * aktif yang usang (suspend yang dibandingnya sudah dicabut) ditutup sebagai dikabulkan tanpa perubahan keanggotaan,
   * lalu banding baru dibuat untuk suspend yang berlaku. Snapshot suspend disimpan di bukti banding.
   */
  async createAppeal(auth: AuthContext, description: string): Promise<ReportResult> {
    await this.rateLimits.consumeOrThrow(
      `moderation-appeal:${auth.userId}`,
      APPEAL_RATE.limit,
      APPEAL_RATE.windowMs,
      "Terlalu banyak pengajuan banding. Coba lagi nanti.",
    );
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, auth.userId))
        .for("no key update");
      const [member] = await tx
        .select({
          suspendedAt: alumni.suspendedAt,
          suspensionReason: alumni.suspensionReason,
          suspensionMessage: alumni.suspensionMessage,
          suspendedByAdminId: alumni.suspendedByAdminId,
        })
        .from(alumni)
        .where(eq(alumni.userId, auth.userId))
        .for("update");
      if (!member?.suspendedAt)
        throw forbidden("Banding hanya dapat diajukan untuk pembatasan akun yang sedang berlaku.");
      const suspendedAtIso = member.suspendedAt.toISOString();
      const now = this.clock.now();

      const active = await tx
        .select({ id: reports.id, status: reports.status, version: reports.version, evidence: reports.evidence })
        .from(reports)
        .where(
          and(
            eq(reports.category, "appeal"),
            eq(reports.reporterId, auth.userId),
            eq(reports.targetUserId, auth.userId),
            inArray(reports.status, [...ACTIVE_REPORT_STATUSES]),
          ),
        )
        .orderBy(asc(reports.createdAt))
        .for("update");
      for (const appeal of active) {
        const evidence = parseEvidence(appeal.evidence, now);
        if (evidence.contested_suspension?.suspended_at === suspendedAtIso)
          return { created: false, report: await this.loadMine(tx, appeal.id) };
        await this.closeStaleAppeal(tx, appeal, now);
      }

      const [event] = await tx
        .select({ id: membershipEvents.id })
        .from(membershipEvents)
        .where(and(eq(membershipEvents.userId, auth.userId), eq(membershipEvents.kind, "suspend")))
        .orderBy(desc(membershipEvents.createdAt), desc(membershipEvents.id))
        .limit(1);
      const evidence: StoredEvidence = buildEvidence({
        capturedAt: now,
        contestedSuspension: {
          membership_event_id: event?.id ?? null,
          suspended_at: suspendedAtIso,
          suspension_reason: member.suspensionReason,
          suspension_message: member.suspensionMessage,
          suspended_by_admin_id: member.suspendedByAdminId,
        },
      });
      const id = uuidv7();
      const priority = priorityFor("appeal");
      const dueAt = dueAtFor(priority, now);
      await tx.insert(reports).values({
        id,
        reporterId: auth.userId,
        targetType: "user",
        targetUserId: auth.userId,
        category: "appeal",
        description,
        evidence,
        priority,
        status: "open",
        dueAt,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit.write(tx, {
        action: "moderation.appeal_created",
        entityType: "report",
        entityId: id,
        after: {
          category: "appeal",
          priority,
          due_at: dueAt,
          contested_suspended_at: suspendedAtIso,
          membership_event_id: event?.id ?? null,
        },
      });
      return { created: true, report: await this.loadMine(tx, id) };
    });
  }

  /**
   * Jaring pengaman banding usang (kontrak createAppeal): suspend yang dibanding sudah dicabut lewat jalur yang tidak
   * menutup bandingnya, lalu pemohon disuspend lagi. Banding lama ditutup sebagai dikabulkan oleh sistem (outcome
   * action_taken) tanpa perubahan keanggotaan; tidak ada notifikasi tambahan karena pemohon sedang mengajukan banding
   * baru atas suspend yang berlaku.
   */
  private async closeStaleAppeal(
    tx: Tx,
    appeal: { id: string; status: string; version: number },
    now: Date,
  ): Promise<void> {
    const note = "Banding ditutup otomatis sebagai dikabulkan: pembatasan yang dibanding sudah dicabut.";
    const [closed] = await tx
      .update(reports)
      .set({
        status: "resolved",
        action: "unsuspend",
        resolutionNote: note,
        memberMessage: "Pembatasan yang Anda bandingkan sudah dicabut.",
        resolvedByAdminId: null,
        resolvedAt: now,
        version: sql`${reports.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(reports.id, appeal.id), inArray(reports.status, [...ACTIVE_REPORT_STATUSES])))
      .returning({ version: reports.version });
    if (!closed) throw new AppException(409, "VERSION_CONFLICT", "Banding sedang diproses. Coba lagi.");
    await this.audit.write(tx, {
      action: "moderation.report_resolved",
      entityType: "report",
      entityId: appeal.id,
      reason: note,
      before: { status: appeal.status, version: appeal.version },
      after: {
        status: "resolved",
        action: "unsuspend",
        outcome: "action_taken",
        version: closed.version,
        stale_appeal: true,
        membership_unchanged: true,
      },
    });
  }
}

