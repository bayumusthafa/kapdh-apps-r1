import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { roomMembers, rooms } from "@kapdh/database";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import { rows } from "../../core/db/rows.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import {
  AppException,
  fieldError,
  forbidden,
  notFound,
  versionConflict,
} from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { decodeCursor, encodeCursor, parsePageQuery } from "../../core/pagination/cursor.js";
import { BlockPolicy } from "../../core/policy/block.policy.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import {
  CONTRACT_MAX_GROUP_MEMBERS,
  GROUP_CREATE_LIMIT,
  GROUP_CREATE_WINDOW_MS,
  INVITE_LIMIT,
  INVITE_WINDOW_MS,
  MAX_GROUP_NAME_CHARS,
  MSG,
} from "./chat.constants.js";
import { ChatEvents } from "./chat.events.js";
import {
  type ChatRoomDto,
  type ChatRoomSummaryDto,
  type ChatViewer,
  ChatPresenter,
  isActiveMember,
  isDeletedAccount,
} from "./chat.presenter.js";
import {
  alumniFacts,
  blockedAmong,
  directKeyFor,
  findDirectRoom,
  findMembership,
  findRoom,
  invitationRows,
  joinedAdminIds,
  joinedCount,
  lockPairs,
  lockRoom,
  type MemberListRow,
  memberRows,
  type MemberRow,
  type RoomRow,
  roomBadges,
  roomSummaries,
  seatCount,
  sharedGroupHistory,
  toDate,
} from "./chat.queries.js";
import { uuidField } from "./chat.validation.js";
import { ChatWriter } from "./chat.writer.js";
import { charLength, harmfulContentReason } from "./content-filter.js";

type ChatRoomPage = components["schemas"]["ChatRoomPage"];
type ChatGroupCreated = components["schemas"]["ChatGroupCreated"];
type ChatInviteOutcome = components["schemas"]["ChatInviteOutcome"];
type ChatInviteSkip = components["schemas"]["ChatInviteSkip"];
type ChatInvitationPage = components["schemas"]["ChatInvitationPage"];
type ChatRoomMember = components["schemas"]["ChatRoomMember"];
type ChatRoomMemberPage = components["schemas"]["ChatRoomMemberPage"];

const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

const directSchema = z.object({ user_id: uuidField });
const groupSchema = z.object({
  name: z.string({ message: "Nama grup wajib diisi" }),
  avatar_file_id: uuidField.nullable().optional(),
  invitee_user_ids: z
    .array(uuidField)
    .max(99, "Maksimal 99 calon anggota")
    .refine(uniqueIds, "Calon anggota tidak boleh berulang")
    .optional(),
});
const inviteSchema = z.object({
  user_ids: z
    .array(uuidField)
    .min(1, "Pilih minimal satu anggota")
    .max(50, "Maksimal 50 anggota per undangan")
    .refine(uniqueIds, "Anggota tidak boleh berulang"),
});
const roomUpdateSchema = z.object({
  name: z.string({ message: "Nama grup harus berupa teks" }).optional(),
  avatar_file_id: uuidField.nullable().optional(),
});
const memberUpdateSchema = z.object({
  role: z.enum(["admin", "member"], { message: "Peran harus admin atau member" }),
});
const leaveSchema = z.object({ successor_user_id: uuidField.optional() });
const muteSchema = z.object({ muted: z.boolean({ message: "muted harus true atau false" }) });

const roomCursor = z.object({ us: z.string().regex(/^-?\d{1,20}$/), id: z.uuid() });
const memberCursor = z.object({ r: z.number().int().min(0).max(1), n: z.string().max(200), u: z.uuid() });

/** Nama grup: dipangkas, 1..80 karakter (rooms_name_chk), lolos filter dasar konten (PRD 3.12). */
function groupName(raw: string, field = "name"): string {
  const name = raw.trim();
  const length = charLength(name);
  if (length < 1) throw fieldError(field, "Nama grup wajib diisi.");
  if (length > MAX_GROUP_NAME_CHARS) throw fieldError(field, "Nama grup maksimal 80 karakter.");
  const harmful = harmfulContentReason(name);
  if (harmful) throw fieldError(field, harmful);
  return name;
}

/**
 * Room, anggota dan undangan chat (F-11, F-12; PRD 3.11, 3.12; kontrak domains/chat.yaml). Aturan:
 * - keanggotaan joined diperiksa pada setiap operasi; selain itu 404 (UUID room bukan izin akses, AC F11-4);
 * - room direct kanonik direct_key dengan pembuatan aman-balapan (kunci pasangan + unique + ON CONFLICT, AC F11-1);
 * - blokir dua arah menolak room direct baru dan undangan (AC F12-1), riwayat lama tetap dapat dibaca;
 * - grup <= 100 (joined + undangan tertunda) dihitung di bawah kunci baris room, hanya admin grup mengundang,
 *   undangan wajib diterima, anggota baru melihat riwayat sejak bergabung (history_visible_from);
 * - admin terakhir wajib menunjuk pengganti sebelum keluar (AC F11-5);
 * - setiap insert pesan (termasuk pesan sistem) mengunci baris room lebih dulu (aturan urutan commit C6).
 */
@Injectable()
export class ChatRoomsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly presenter: ChatPresenter,
    private readonly events: ChatEvents,
    private readonly writer: ChatWriter,
    private readonly files: FilesService,
    private readonly blocks: BlockPolicy,
    private readonly notifications: NotificationService,
    private readonly limits: RateLimitService,
    private readonly settings: SettingsService,
  ) {}

  private async maxGroupMembers(): Promise<number> {
    const chat = await this.settings.get("chat");
    return Math.min(chat.max_group_members, CONTRACT_MAX_GROUP_MEMBERS);
  }

  /** ChatRoom untuk penampil joined; 404 bila bukan anggota joined (AC F11-4). */
  async roomDto(db: DbOrTx, roomId: string, viewer: ChatViewer): Promise<ChatRoomDto> {
    const [row] = await roomSummaries(db, { viewerId: viewer.userId, roomId, limit: 1 });
    if (!row) throw notFound(MSG.roomNotFound);
    return this.presenter.room(row, viewer);
  }

  /** Room + keanggotaan joined penampil, dengan kunci baris room (kunci pertama transaksi) bila `tx` diberikan. */
  private async joinedLocked(tx: Tx, roomId: string, userId: string): Promise<{ room: RoomRow; me: MemberRow }> {
    const room = await lockRoom(tx, roomId);
    const me = room ? await findMembership(tx, roomId, userId) : undefined;
    if (!room || !me || me.status !== "joined") throw notFound(MSG.roomNotFound);
    return { room, me };
  }

  /** Pengelolaan grup: hanya room group (direct → 400), grup aktif dan pemanggil admin (selain itu 403). */
  private assertGroupAdmin(room: RoomRow, me: MemberRow): void {
    if (room.kind !== "group") throw fieldError("_", MSG.directRoomOnlyGroup);
    if (room.closedAt || me.role !== "admin") throw forbidden(room.closedAt ? MSG.roomClosed : MSG.notGroupAdmin);
  }

  // ---------------------------------------------------------------------------------------------- daftar room

  async listRooms(auth: AuthContext, query: unknown): Promise<ChatRoomPage> {
    const page = parsePageQuery(query);
    const { kind } = validateQuery(z.object({ kind: z.enum(["direct", "group"]).optional() }), query);
    const before = page.cursor ? decodeCursor(page.cursor, roomCursor) : undefined;
    const found = await roomSummaries(this.db, {
      viewerId: auth.userId,
      kind,
      hideEmptyDirect: true,
      before,
      limit: page.limit + 1,
    });
    const hasMore = found.length > page.limit;
    const pageRows = hasMore ? found.slice(0, page.limit) : found;
    const last = pageRows[pageRows.length - 1];
    const items: ChatRoomSummaryDto[] = await Promise.all(pageRows.map((row) => this.presenter.summary(row, auth)));
    return {
      items,
      next_cursor: hasMore && last ? encodeCursor({ us: last.activity_us, id: last.id }) : null,
      ...(await roomBadges(this.db, auth.userId)),
    };
  }

  async getRoom(auth: AuthContext, roomId: string): Promise<ChatRoomDto> {
    return this.roomDto(this.db, roomId, auth);
  }

  // -------------------------------------------------------------------------------------------- room direct

  /**
   * POST /chat/direct (AC F11-1, F12-1): kunci pasangan (sama dengan BlockPolicy) menyerialkan pembuatan dari kedua
   * pihak dan pembuatan blokir; unique rooms_direct_key_key + ON CONFLICT menjadi pengaman kedua. Blokir oleh lawan
   * bicara tidak diungkap: room lama tetap 200 (peer_unavailable), tanpa room → 404 yang sama dengan akun nonaktif.
   */
  async openDirect(auth: AuthContext, body: unknown): Promise<{ created: boolean; room: ChatRoomDto }> {
    const { user_id: peerId } = validate(directSchema, body);
    const me = auth.userId;
    if (peerId === me) throw fieldError("user_id", "Tidak dapat membuka percakapan dengan diri sendiri.");
    return this.db.transaction(async (tx) => {
      await this.blocks.lockPair(tx, me, peerId);
      const blocked = await blockedAmong(tx, me, [peerId]);
      if (blocked.size > 0 && (await this.iBlock(tx, me, peerId))) throw forbidden(MSG.youBlocked);
      const existing = await findDirectRoom(tx, me, peerId);
      if (existing) return { created: false, room: await this.roomDto(tx, existing.id, auth) };

      const now = this.clock.now();
      const facts = (await alumniFacts(tx, [peerId])).get(peerId);
      const eligible =
        facts !== undefined &&
        blocked.size === 0 &&
        isActiveMember(
          {
            accountStatus: facts.account_status,
            fullName: facts.full_name,
            suspendedAt: toDate(facts.suspended_at),
            expiresAt: toDate(facts.expires_at),
          },
          now,
        ) &&
        (facts.show_in_directory || (await sharedGroupHistory(tx, me, peerId)));
      if (!eligible) throw notFound(MSG.peerNotFound);

      const roomId = uuidv7();
      const inserted = await tx
        .insert(rooms)
        .values({
          id: roomId,
          kind: "direct",
          directKey: directKeyFor(me, peerId),
          createdBy: me,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: rooms.directKey })
        .returning({ id: rooms.id });
      if (inserted.length === 0) {
        const raced = await findDirectRoom(tx, me, peerId);
        if (!raced) throw new Error("Room direct hilang setelah konflik direct_key");
        return { created: false, room: await this.roomDto(tx, raced.id, auth) };
      }
      await tx.insert(roomMembers).values(
        [me, peerId].map((userId) => ({
          roomId,
          userId,
          role: "member" as const,
          status: "joined" as const,
          joinedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );
      // Kedua pihak aktif: socket mereka mengikuti kanal room setelah commit.
      this.events.join(me, roomId);
      this.events.join(peerId, roomId);
      return { created: true, room: await this.roomDto(tx, roomId, auth) };
    });
  }

  private async iBlock(db: DbOrTx, me: string, other: string): Promise<boolean> {
    const [row] = rows<{ ok: boolean }>(
      await db.execute(
        sql`select true as ok from app.blocks where blocker_id = ${me}::uuid and blocked_id = ${other}::uuid`,
      ),
    );
    return row?.ok === true;
  }

  // ------------------------------------------------------------------------------------------------------ grup

  async createGroup(auth: AuthContext, body: unknown): Promise<ChatGroupCreated> {
    const input = validate(groupSchema, body);
    const name = groupName(input.name);
    await this.limits.consumeOrThrow(
      `chat-group:${auth.userId}`,
      GROUP_CREATE_LIMIT,
      GROUP_CREATE_WINDOW_MS,
      MSG.groupRateLimited,
    );
    const max = await this.maxGroupMembers();
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const roomId = uuidv7();
      await tx.insert(rooms).values({
        id: roomId,
        kind: "group",
        name,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      });
      // Kunci baris room (aturan C6) sebelum lampiran berkas dan pesan sistem.
      const room = (await lockRoom(tx, roomId))!;
      if (input.avatar_file_id) {
        const avatar = await this.files.attach(tx, input.avatar_file_id, auth.userId, "chat_image", {
          field: "avatar_file_id",
        });
        await tx.update(rooms).set({ avatarFileId: avatar.id }).where(eq(rooms.id, roomId));
        room.avatarFileId = avatar.id;
      }
      await tx.insert(roomMembers).values({
        roomId,
        userId: auth.userId,
        role: "admin",
        status: "joined",
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      this.events.join(auth.userId, roomId);
      const creator = await this.writer.displayName(tx, auth.userId);
      const systemId = await this.writer.systemMessage(tx, roomId, `${creator} membuat grup "${name}".`);
      await tx
        .update(roomMembers)
        .set({ lastReadMessageId: systemId, lastReadAt: now })
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, auth.userId)));
      const invitations = await this.inviteLocked(tx, room, auth.userId, input.invitee_user_ids ?? [], max);
      return { room: await this.roomDto(tx, roomId, auth), invitations };
    });
  }

  /** PATCH /chat/rooms/{roomId}: nama/avatar grup oleh admin grup dengan If-Match (pola konflik AC F15-4). */
  async updateRoom(
    auth: AuthContext,
    roomId: string,
    ifMatch: string | string[] | undefined,
    body: unknown,
  ): Promise<ChatRoomDto> {
    const expected = parseIfMatch(ifMatch);
    const input = validate(roomUpdateSchema, body);
    if (input.name === undefined && input.avatar_file_id === undefined)
      throw fieldError("_", "Kirim name atau avatar_file_id yang akan diubah.");
    const name = input.name === undefined ? undefined : groupName(input.name);
    return this.db.transaction(async (tx) => {
      const { room, me } = await this.joinedLocked(tx, roomId, auth.userId);
      this.assertGroupAdmin(room, me);
      if (room.version !== expected) throw versionConflict(await this.roomDto(tx, roomId, auth));
      const changes: ("group_name" | "group_avatar")[] = [];
      const now = this.clock.now();
      let avatarFileId = room.avatarFileId;
      if (name !== undefined && name !== room.name) changes.push("group_name");
      if (input.avatar_file_id !== undefined && input.avatar_file_id !== room.avatarFileId) {
        if (input.avatar_file_id)
          avatarFileId = (
            await this.files.attach(tx, input.avatar_file_id, auth.userId, "chat_image", {
              field: "avatar_file_id",
            })
          ).id;
        else avatarFileId = null;
        if (room.avatarFileId) await this.writer.releaseFile(tx, room.avatarFileId);
        changes.push("group_avatar");
      }
      if (changes.length === 0) return this.roomDto(tx, roomId, auth);
      const [updated] = await tx
        .update(rooms)
        .set({
          name: name ?? room.name,
          avatarFileId,
          version: sql`${rooms.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(rooms.id, roomId), eq(rooms.version, expected)))
        .returning();
      if (!updated) throw versionConflict(await this.roomDto(tx, roomId, auth));
      const actor = await this.writer.displayName(tx, auth.userId);
      if (changes.includes("group_name"))
        await this.writer.systemMessage(tx, roomId, `${actor} mengubah nama grup menjadi "${updated.name}".`);
      if (changes.includes("group_avatar"))
        await this.writer.systemMessage(
          tx,
          roomId,
          avatarFileId ? `${actor} mengubah foto grup.` : `${actor} menghapus foto grup.`,
        );
      const avatar = avatarFileId ? await this.files.findReady(avatarFileId, tx) : null;
      this.events.roomUpdated({
        room_id: roomId,
        version: String(updated.version),
        changes,
        name: updated.name,
        avatar_url: avatar
          ? ((await this.presenter.fileUrl(
              { id: avatar.id, visibility: avatar.visibility, status: avatar.status },
              "chat_image",
              null,
            ))?.url ?? null)
          : null,
        closed_at: updated.closedAt?.toISOString() ?? null,
      });
      return this.roomDto(tx, roomId, auth);
    });
  }

  // --------------------------------------------------------------------------------------------------- anggota

  private async memberDtos(rowsFound: readonly MemberListRow[], viewer: ChatViewer): Promise<ChatRoomMember[]> {
    return Promise.all(
      rowsFound.map(async (row) => {
        const deleted = isDeletedAccount({ accountStatus: row.account_status, fullName: row.full_name });
        return {
          user_id: row.user_id,
          full_name: deleted ? "Akun dihapus" : row.full_name!,
          avatar_url: deleted
            ? null
            : await this.presenter.avatarUrl(
                { id: row.avatar_file_id, visibility: row.avatar_visibility, status: row.avatar_status },
                viewer,
              ),
          role: row.role,
          status: row.status,
          invited_at: row.invited_at,
          joined_at: row.status === "joined" ? row.joined_at : null,
          last_read_message_id: row.status === "joined" ? row.last_read_message_id : null,
          is_me: row.user_id === viewer.userId,
        };
      }),
    );
  }

  async listMembers(auth: AuthContext, roomId: string, query: unknown): Promise<ChatRoomMemberPage> {
    const page = parsePageQuery(query);
    const { status } = validateQuery(z.object({ status: z.enum(["joined", "invited"]).optional() }), query);
    const me = await findMembership(this.db, roomId, auth.userId);
    if (!me || me.status !== "joined") throw notFound(MSG.roomNotFound);
    // Undangan tertunda hanya terlihat admin grup (kontrak listChatRoomMembers, N-09).
    if (status === "invited" && me.role !== "admin")
      throw forbidden("Undangan tertunda hanya dapat dilihat admin grup.");
    const after = page.cursor ? decodeCursor(page.cursor, memberCursor) : undefined;
    const found = await memberRows(this.db, {
      roomId,
      status: status ?? "joined",
      after,
      limit: page.limit + 1,
    });
    const hasMore = found.length > page.limit;
    const pageRows = hasMore ? found.slice(0, page.limit) : found;
    const last = pageRows[pageRows.length - 1];
    return {
      items: await this.memberDtos(pageRows, auth),
      next_cursor:
        hasMore && last ? encodeCursor({ r: last.role_rank, n: last.sort_name, u: last.user_id }) : null,
    };
  }

  /** PATCH anggota: promosi/turun peran oleh admin grup; admin terakhir tidak dapat diturunkan (AC F11-5). */
  async updateMember(
    auth: AuthContext,
    roomId: string,
    targetId: string,
    body: unknown,
  ): Promise<ChatRoomMember> {
    const { role } = validate(memberUpdateSchema, body);
    return this.db.transaction(async (tx) => {
      const { room, me } = await this.joinedLocked(tx, roomId, auth.userId);
      this.assertGroupAdmin(room, me);
      const target = await findMembership(tx, roomId, targetId);
      if (!target || target.status !== "joined") throw notFound(MSG.memberNotFound);
      if (target.role !== role) {
        if (role === "member" && (await joinedAdminIds(tx, roomId)).length <= 1)
          throw fieldError("role", "Grup wajib memiliki minimal satu admin. Tunjuk admin lain lebih dulu.");
        await tx
          .update(roomMembers)
          .set({ role, updatedAt: this.clock.now() })
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, targetId)));
        const targetName = await this.writer.displayName(tx, targetId);
        await this.writer.systemMessage(
          tx,
          roomId,
          role === "admin" ? `${targetName} sekarang admin grup.` : `${targetName} bukan lagi admin grup.`,
        );
        this.events.memberChanged({
          roomId,
          userId: targetId,
          change: "role_changed",
          role,
          memberCount: await joinedCount(tx, roomId),
          actorUserId: auth.userId,
        });
      }
      const [row] = await memberRows(tx, { roomId, userIds: [targetId] });
      return (await this.memberDtos([row!], auth))[0]!;
    });
  }

  /** DELETE anggota: keluarkan anggota joined atau batalkan undangan tertunda (admin grup; AC F11-4). */
  async removeMember(auth: AuthContext, roomId: string, targetId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { room, me } = await this.joinedLocked(tx, roomId, auth.userId);
      this.assertGroupAdmin(room, me);
      if (targetId === auth.userId)
        throw fieldError("user_id", "Gunakan keluar grup untuk keluar dari grup sendiri.");
      const target = await findMembership(tx, roomId, targetId);
      if (target?.status === "joined") {
        await this.writer.endMembership(tx, roomId, targetId, "removed");
        const [targetName, actor] = await Promise.all([
          this.writer.displayName(tx, targetId),
          this.writer.displayName(tx, auth.userId),
        ]);
        await this.writer.systemMessage(tx, roomId, `${targetName} dikeluarkan dari grup oleh ${actor}.`);
        this.events.memberChanged({
          roomId,
          userId: targetId,
          change: "removed",
          role: null,
          memberCount: await joinedCount(tx, roomId),
          actorUserId: auth.userId,
        });
        // Langganan socket target dicabut segera sesudah event (AC F11-4).
        this.events.leave(targetId, roomId);
        return;
      }
      if (target?.status === "invited" && (await this.writer.cancelInvitation(tx, roomId, targetId, auth.userId)))
        return;
      throw notFound(MSG.memberNotFound);
    });
  }

  // ------------------------------------------------------------------------------------------------- undangan

  async invite(auth: AuthContext, roomId: string, body: unknown): Promise<ChatInviteOutcome> {
    const { user_ids: userIds } = validate(inviteSchema, body);
    await this.limits.consumeOrThrow(
      `chat-invite:${auth.userId}`,
      INVITE_LIMIT,
      INVITE_WINDOW_MS,
      MSG.inviteRateLimited,
    );
    const max = await this.maxGroupMembers();
    return this.db.transaction(async (tx) => {
      const { room, me } = await this.joinedLocked(tx, roomId, auth.userId);
      this.assertGroupAdmin(room, me);
      return this.inviteLocked(tx, room, auth.userId, userIds, max);
    });
  }

  /**
   * Undangan di bawah kunci baris room (kapasitas joined + undangan tertunda <= batas tidak terlampaui undangan paralel).
   * Kunci pasangan BlockPolicy diambil berurutan (urutan direct_key) sebelum memeriksa blokir, sehingga blokir yang
   * dibuat bersamaan diserialkan (AC F12-1). Alasan tidak dapat diundang sengaja tidak dibedakan (N-09).
   */
  private async inviteLocked(
    tx: Tx,
    room: RoomRow,
    inviterId: string,
    requested: readonly string[],
    max: number,
  ): Promise<ChatInviteOutcome> {
    const invited: string[] = [];
    const skipped: ChatInviteSkip[] = [];
    if (requested.length === 0) return { invited_user_ids: invited, skipped };
    const now = this.clock.now();
    const candidates = requested.filter((id) => id !== inviterId);
    const existing = new Map(
      (
        await tx
          .select()
          .from(roomMembers)
          .where(
            and(
              eq(roomMembers.roomId, room.id),
              candidates.length > 0 ? inArray(roomMembers.userId, candidates) : sql`false`,
            ),
          )
      ).map((row) => [row.userId, row]),
    );
    const facts = await alumniFacts(tx, candidates);
    const lockable = candidates.filter((id) => !["joined", "invited"].includes(existing.get(id)?.status ?? ""));
    await lockPairs(tx, inviterId, lockable);
    const blocked = await blockedAmong(tx, inviterId, lockable);
    let seats = await seatCount(tx, room.id);
    const admins = await joinedAdminIds(tx, room.id);
    const memberCount = await joinedCount(tx, room.id);

    for (const userId of requested) {
      const membership = existing.get(userId);
      const fact = facts.get(userId);
      let reason: ChatInviteSkip["reason"] | null = null;
      if (userId === inviterId) reason = "not_invitable";
      else if (membership?.status === "joined") reason = "already_member";
      else if (membership?.status === "invited") reason = "already_invited";
      else if (
        !fact ||
        blocked.has(userId) ||
        !isActiveMember(
          {
            accountStatus: fact.account_status,
            fullName: fact.full_name,
            suspendedAt: toDate(fact.suspended_at),
            expiresAt: toDate(fact.expires_at),
          },
          now,
        )
      )
        reason = "not_invitable";
      else if (seats >= max) reason = "room_full";
      if (reason) {
        skipped.push({ user_id: userId, reason });
        continue;
      }
      const values = {
        role: "member" as const,
        status: "invited" as const,
        invitedBy: inviterId,
        invitedAt: now,
        joinedAt: null,
        leftAt: null,
        historyVisibleFrom: null,
        lastReadMessageId: null,
        lastReadAt: null,
        muted: false,
        updatedAt: now,
      };
      if (membership) {
        // Undangan ulang setelah left/declined/removed (kontrak inviteChatMembers).
        const [again] = await tx
          .update(roomMembers)
          .set(values)
          .where(
            and(
              eq(roomMembers.roomId, room.id),
              eq(roomMembers.userId, userId),
              inArray(roomMembers.status, ["left", "declined", "removed"]),
            ),
          )
          .returning({ userId: roomMembers.userId });
        if (!again) {
          skipped.push({ user_id: userId, reason: "already_invited" });
          continue;
        }
      } else {
        await tx.insert(roomMembers).values({ roomId: room.id, userId, ...values, createdAt: now });
      }
      seats++;
      invited.push(userId);
      await this.notifications.notify(tx, {
        userId,
        category: "chat",
        title: "Undangan grup",
        body: `Anda diundang bergabung ke grup "${room.name}". Buka undangan untuk menerima atau menolak.`,
        route: "/chat/invitations",
        data: { room_id: room.id },
        dedupKey: `chat.invitation:${room.id}:${now.getTime()}`,
      });
      this.events.memberChanged(
        {
          roomId: room.id,
          userId,
          change: "invited",
          role: null,
          memberCount,
          actorUserId: inviterId,
        },
        admins,
      );
    }
    return { invited_user_ids: invited, skipped };
  }

  async listInvitations(auth: AuthContext, query: unknown): Promise<ChatInvitationPage> {
    const page = parsePageQuery(query);
    const before = page.cursor ? decodeCursor(page.cursor, roomCursor) : undefined;
    const found = await invitationRows(this.db, auth.userId, { before, limit: page.limit + 1 });
    const hasMore = found.length > page.limit;
    const pageRows = hasMore ? found.slice(0, page.limit) : found;
    const last = pageRows[pageRows.length - 1];
    const items = await Promise.all(
      pageRows.map(async (row) => ({
        room_id: row.room_id,
        room_name: row.room_name,
        room_avatar_url:
          (
            await this.presenter.fileUrl(
              { id: row.avatar_file_id, visibility: row.avatar_visibility, status: row.avatar_status },
              "chat_image",
              auth,
            )
          )?.url ?? null,
        member_count: Math.min(row.member_count, 100),
        invited_by: await this.presenter.userRef(
          {
            userId: row.invited_by,
            accountStatus: row.inviter_status,
            fullName: row.inviter_name,
            avatar: {
              id: row.inviter_avatar_file_id,
              visibility: row.inviter_avatar_visibility,
              status: row.inviter_avatar_status,
            },
          },
          auth,
        ),
        invited_at: row.invited_at,
      })),
    );
    return {
      items,
      next_cursor: hasMore && last ? encodeCursor({ us: last.invited_us, id: last.room_id }) : null,
    };
  }

  /**
   * Terima undangan (PRD 3.11): di bawah kunci baris room, pesan sistem "bergabung" ditulis dengan aturan urutan C6
   * lalu joined_at = history_visible_from = created_at pesan itu, sehingga anggota baru melihat riwayat sejak
   * bergabung, tanpa celah maupun pesan sebelum bergabung. Sudah joined → room apa adanya (idempoten).
   */
  async acceptInvitation(auth: AuthContext, roomId: string): Promise<ChatRoomDto> {
    const max = await this.maxGroupMembers();
    return this.db.transaction(async (tx) => {
      const room = await lockRoom(tx, roomId);
      if (!room || room.kind !== "group" || room.closedAt) throw notFound(MSG.invitationNotFound);
      const me = await findMembership(tx, roomId, auth.userId);
      if (me?.status === "joined") return this.roomDto(tx, roomId, auth);
      if (me?.status !== "invited") throw notFound(MSG.invitationNotFound);
      if ((await joinedCount(tx, roomId)) >= max)
        throw new AppException(400, "VALIDATION_ERROR", "Grup sudah penuh. Hubungi admin grup.", {
          fieldErrors: { _: ["Grup sudah mencapai batas anggota."] },
        });
      const now = this.clock.now();
      // Socket penerima bergabung sebelum pesan sistem disiarkan sehingga event "bergabung" ikut diterima.
      this.events.join(auth.userId, roomId);
      const name = await this.writer.displayName(tx, auth.userId);
      const systemId = await this.writer.systemMessage(tx, roomId, `${name} bergabung ke grup.`);
      const joined = rows<{ user_id: string }>(
        await tx.execute(sql`
          update app.room_members rm
          set status = 'joined', role = 'member', joined_at = m.created_at, history_visible_from = m.created_at,
              left_at = null, last_read_message_id = m.id, last_read_at = ${now.toISOString()}::timestamptz,
              updated_at = ${now.toISOString()}::timestamptz
          from app.messages m
          where m.id = ${systemId}::uuid and rm.room_id = ${roomId}::uuid and rm.user_id = ${auth.userId}::uuid
            and rm.status = 'invited'
          returning rm.user_id`),
      );
      if (joined.length !== 1) throw notFound(MSG.invitationNotFound);
      this.events.memberChanged({
        roomId,
        userId: auth.userId,
        change: "joined",
        role: "member",
        memberCount: await joinedCount(tx, roomId),
        actorUserId: auth.userId,
      });
      return this.roomDto(tx, roomId, auth);
    });
  }

  async declineInvitation(auth: AuthContext, roomId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [declined] = await tx
        .update(roomMembers)
        .set({ status: "declined", updatedAt: this.clock.now() })
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, auth.userId),
            eq(roomMembers.status, "invited"),
          ),
        )
        .returning({ userId: roomMembers.userId });
      if (!declined) {
        const me = await findMembership(tx, roomId, auth.userId);
        if (me?.status === "declined") return;
        throw notFound(MSG.invitationNotFound);
      }
      this.events.memberChanged(
        {
          roomId,
          userId: auth.userId,
          change: "declined",
          role: null,
          memberCount: await joinedCount(tx, roomId),
          actorUserId: auth.userId,
        },
        await joinedAdminIds(tx, roomId),
      );
    });
  }

  // -------------------------------------------------------------------------------------------- keluar & mute

  /**
   * Keluar grup (AC F11-5, F11-4): admin terakhir dengan anggota lain wajib menunjuk pengganti (dipromosikan dalam
   * transaksi yang sama). Anggota terakhir menutup grup dan membatalkan undangan tertunda (actor null).
   */
  async leave(auth: AuthContext, roomId: string, body: unknown): Promise<void> {
    const { successor_user_id: successorId } = validate(leaveSchema, body);
    await this.db.transaction(async (tx) => {
      const { room, me } = await this.joinedLocked(tx, roomId, auth.userId);
      if (room.kind !== "group")
        throw fieldError("_", "Percakapan langsung tidak dapat ditinggalkan. Gunakan bisukan atau blokir.");
      const others = await tx
        .select({ userId: roomMembers.userId, role: roomMembers.role })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.status, "joined"),
            ne(roomMembers.userId, auth.userId),
          ),
        );
      if (successorId !== undefined && me.role !== "admin")
        throw fieldError("successor_user_id", "Hanya admin grup yang dapat menunjuk pengganti.");
      const lastAdmin = me.role === "admin" && !others.some((o) => o.role === "admin");
      if (lastAdmin && others.length > 0 && successorId === undefined)
        throw fieldError(
          "successor_user_id",
          "Anda admin terakhir. Tunjuk anggota lain sebagai admin sebelum keluar.",
        );
      const now = this.clock.now();
      if (successorId !== undefined) {
        const successor = others.find((o) => o.userId === successorId);
        if (!successor) throw fieldError("successor_user_id", "Pengganti wajib anggota grup ini.");
        if (successor.role !== "admin") {
          await tx
            .update(roomMembers)
            .set({ role: "admin", updatedAt: now })
            .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, successorId)));
          const successorName = await this.writer.displayName(tx, successorId);
          await this.writer.systemMessage(tx, roomId, `${successorName} sekarang admin grup.`);
          this.events.memberChanged({
            roomId,
            userId: successorId,
            change: "role_changed",
            role: "admin",
            memberCount: others.length + 1,
            actorUserId: auth.userId,
          });
        }
      }
      const name = await this.writer.displayName(tx, auth.userId);
      await this.writer.systemMessage(tx, roomId, `${name} keluar dari grup.`);
      await this.writer.endMembership(tx, roomId, auth.userId, "left");
      if (others.length === 0) {
        await tx
          .update(rooms)
          .set({ closedAt: now, version: sql`${rooms.version} + 1`, updatedAt: now })
          .where(eq(rooms.id, roomId));
        await this.writer.cancelAllInvitations(tx, roomId);
      }
      this.events.memberChanged({
        roomId,
        userId: auth.userId,
        change: "left",
        role: null,
        memberCount: others.length,
        actorUserId: auth.userId,
      });
      // Riwayat dan langganan socket room dicabut segera sesudah event (AC F11-4).
      this.events.leave(auth.userId, roomId);
    });
  }

  async setMute(auth: AuthContext, roomId: string, body: unknown): Promise<void> {
    const { muted } = validate(muteSchema, body);
    const [updated] = await this.db
      .update(roomMembers)
      .set({ muted, updatedAt: this.clock.now() })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.userId, auth.userId),
          eq(roomMembers.status, "joined"),
        ),
      )
      .returning({ userId: roomMembers.userId });
    if (!updated) throw notFound(MSG.roomNotFound);
    const room = await findRoom(this.db, roomId);
    if (!room) throw notFound(MSG.roomNotFound);
    const avatar = room.kind === "group" && room.avatarFileId ? await this.files.findReady(room.avatarFileId) : null;
    // Perangkat lain pemanggil menyesuaikan preferensi (kanal user saja; field per pengguna dimuat ulang lewat HTTP).
    this.events.roomUpdated(
      {
        room_id: roomId,
        version: String(room.version),
        changes: ["muted"],
        name: room.kind === "group" ? room.name : null,
        avatar_url: avatar
          ? ((await this.presenter.fileUrl(
              { id: avatar.id, visibility: avatar.visibility, status: avatar.status },
              "chat_image",
              null,
            ))?.url ?? null)
          : null,
        closed_at: room.closedAt?.toISOString() ?? null,
      },
      auth.userId,
    );
  }
}
