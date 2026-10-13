import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { messageReactions, messages, notificationPreferences, notifications, roomMembers } from "@kapdh/database";
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { isUniqueViolation } from "../../core/db/errors.js";
import { rows } from "../../core/db/rows.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, fieldError, forbidden, notFound } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { hasActiveMembership } from "../../core/membership/effective-status.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { BlockPolicy } from "../../core/policy/block.policy.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { validate, validateQuery, queryInt } from "../../core/validation/validate.js";
import {
  CONTRACT_MAX_TEXT_CHARS,
  MAX_EMOJI_CHARS,
  MAX_REACTIONS_PER_USER,
  MSG,
  SEND_LIMIT,
  SEND_WINDOW_MS,
} from "./chat.constants.js";
import { ChatEvents } from "./chat.events.js";
import { type ChatMessageDto, type ChatViewer, ChatPresenter, isActiveMember } from "./chat.presenter.js";
import {
  alumniFacts,
  directPeerId,
  findMembership,
  findRoom,
  insertMessageLocked,
  isMessageVisible,
  lockRoom,
  messageRows,
  reactionCounts,
  type RoomRow,
  toDate,
  unreadCount,
} from "./chat.queries.js";
import { uuidField } from "./chat.validation.js";
import { ChatWriter } from "./chat.writer.js";
import { charLength, harmfulContentReason } from "./content-filter.js";

type ChatMessagePage = components["schemas"]["ChatMessagePage"];
type ChatMessageReactions = components["schemas"]["ChatMessageReactions"];
type ChatReadState = components["schemas"]["ChatReadState"];

const sendSchema = z.object({
  client_message_id: uuidField,
  kind: z.enum(["text", "image"], { message: "Jenis pesan harus text atau image" }),
  body: z.string({ message: "Isi pesan harus berupa teks" }).optional(),
  image_file_id: uuidField.optional(),
  reply_to_id: uuidField.nullable().optional(),
});
const readSchema = z.object({ message_id: uuidField });
const historyQuery = z.object({
  before: uuidField.optional(),
  after: uuidField.optional(),
  limit: queryInt({ min: 1, max: 100 }).optional(),
});

/** Satu emoji (grapheme): piktograf, bendera (regional indicator), atau keycap (kontrak parameter ChatEmoji). */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
const graphemes = new Intl.Segmenter("id", { granularity: "grapheme" });

export function parseEmoji(raw: string): string {
  const emoji = raw.normalize("NFC");
  const length = charLength(emoji);
  if (
    length < 1 ||
    length > MAX_EMOJI_CHARS ||
    [...graphemes.segment(emoji)].length !== 1 ||
    !EMOJI.test(emoji)
  )
    throw fieldError("emoji", "Reaksi harus satu emoji.");
  return emoji;
}

type SendInput = z.infer<typeof sendSchema>;

/**
 * Pesan, reaksi, dan read cursor chat (F-11; AC F11-2, F11-3, F11-4, F11-6, F12-1; PRD 3.11; kontrak chat.yaml).
 * - Kirim lewat HTTP: transaksi mengunci baris room lebih dulu, memeriksa ulang keanggotaan/blokir/status room di bawah
 *   kunci itu, menyisipkan pesan dengan created_at = greatest(clock_timestamp(), Clock, last_message_at + 1 µs),
 *   memajukan read cursor pengirim, memperbarui last_message_at, menjadwalkan push, lalu respons dan message.created
 *   dikirim SESUDAH commit (ack sesudah commit).
 * - client_message_id unik per pengirim: pengulangan mengembalikan pesan yang sama (200), isi berbeda → 409.
 * - Riwayat keyset (created_at, id) dengan jangkar ID pesan; sinkron `after` tanpa celah (urutan commit = urutan
 *   keyset).
 * - Read cursor monoton: UPDATE bersyarat (created_at, id) jangkar > cursor, sehingga paket terlambat tidak memundurkan.
 * Isi pesan tidak pernah dicatat di log atau audit (ARCHITECTURE §2 butir 3).
 */
@Injectable()
export class ChatMessagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly presenter: ChatPresenter,
    private readonly events: ChatEvents,
    private readonly writer: ChatWriter,
    private readonly files: FilesService,
    private readonly blocks: BlockPolicy,
    private readonly membership: MembershipKernel,
    private readonly notifications: NotificationService,
    private readonly limits: RateLimitService,
    private readonly settings: SettingsService,
  ) {}

  private async requireJoined(db: DbOrTx, roomId: string, userId: string) {
    const me = await findMembership(db, roomId, userId);
    if (!me || me.status !== "joined") throw notFound(MSG.roomNotFound);
    return me;
  }

  private async dtosFor(db: DbOrTx, roomId: string, ids: readonly string[], viewer: ChatViewer) {
    const found = await messageRows(db, { roomId, viewerId: viewer.userId, ids });
    return this.presenter.messages(db, found, viewer);
  }

  // --------------------------------------------------------------------------------------------------- riwayat

  async list(auth: AuthContext, roomId: string, query: unknown): Promise<ChatMessagePage> {
    const input = validateQuery(historyQuery, query);
    if (input.before && input.after)
      throw fieldError("before", "Gunakan before atau after, tidak keduanya sekaligus.");
    await this.requireJoined(this.db, roomId, auth.userId);
    const limit = input.limit ?? 30;
    const anchorId = input.before ?? input.after;
    if (anchorId && !(await isMessageVisible(this.db, roomId, anchorId, auth.userId)))
      throw fieldError(input.before ? "before" : "after", "Jangkar bukan pesan yang terlihat di percakapan ini.");
    const direction = input.after ? "after" : input.before ? "before" : "latest";
    const found = await messageRows(this.db, {
      roomId,
      viewerId: auth.userId,
      direction,
      anchorId,
      limit: limit + 1,
    });
    const hasMore = found.length > limit;
    const pageRows = hasMore ? found.slice(0, limit) : found;
    // latest/before diambil menurun; item selalu urut naik (created_at, id).
    const ordered = direction === "after" ? pageRows : [...pageRows].reverse();
    const items = await this.presenter.messages(this.db, ordered, auth);
    const nextCursor = !hasMore
      ? null
      : direction === "after"
        ? (ordered[ordered.length - 1]?.id ?? null)
        : (ordered[0]?.id ?? null);
    return { items, next_cursor: nextCursor };
  }

  // ----------------------------------------------------------------------------------------------------- kirim

  private async validateSend(body: unknown): Promise<SendInput & { text: string | null }> {
    const input = validate(sendSchema, body);
    const chat = await this.settings.get("chat");
    const maxChars = Math.min(chat.max_text_chars, CONTRACT_MAX_TEXT_CHARS);
    const text = input.body ?? null;
    if (input.kind === "text") {
      if (text === null || text.trim().length === 0) throw fieldError("body", "Pesan tidak boleh kosong.");
      if (input.image_file_id !== undefined)
        throw fieldError("image_file_id", "Lampiran gambar hanya untuk pesan bergambar.");
    } else {
      if (input.image_file_id === undefined) throw fieldError("image_file_id", "Pilih gambar yang akan dikirim.");
      if (text !== null && text.trim().length === 0)
        throw fieldError("body", "Keterangan gambar tidak boleh hanya spasi.");
    }
    if (text !== null) {
      if (charLength(text) > maxChars) throw fieldError("body", `Pesan maksimal ${maxChars} karakter.`);
      const harmful = harmfulContentReason(text);
      if (harmful) throw fieldError("body", harmful);
    }
    return { ...input, text };
  }

  /**
   * POST pesan (AC F11-2, F11-6, F12-1). Mengembalikan status 201 (baru) atau 200 (pengulangan client_message_id).
   */
  async send(
    auth: AuthContext,
    roomId: string,
    body: unknown,
  ): Promise<{ status: 200 | 201; message: ChatMessageDto }> {
    const input = await this.validateSend(body);
    const previous = await this.findByClientId(this.db, auth.userId, input.client_message_id);
    if (previous) return { status: 200, message: await this.replay(auth, roomId, previous, input) };
    await this.limits.consumeOrThrow(`chat-send:${auth.userId}`, SEND_LIMIT, SEND_WINDOW_MS, MSG.sendRateLimited);
    try {
      return await this.db.transaction(async (tx) => {
        // Kunci pertama transaksi: baris room (aturan urutan commit C6, AC F11-3).
        const room = await lockRoom(tx, roomId);
        if (!room) throw notFound(MSG.roomNotFound);
        await this.requireJoined(tx, roomId, auth.userId);
        // Duplikat yang commit selagi menunggu kunci room (permintaan ulang paralel di room yang sama).
        const raced = await this.findByClientId(tx, auth.userId, input.client_message_id);
        if (raced) return { status: 200 as const, message: await this.replay(auth, roomId, raced, input, tx) };
        await this.assertCanSend(tx, room, auth.userId);
        const now = this.clock.now();
        const imageFileId =
          input.kind === "image"
            ? (
                await this.files.attach(tx, input.image_file_id!, auth.userId, "chat_image", {
                  field: "image_file_id",
                })
              ).id
            : null;
        const replyToId = input.reply_to_id ?? null;
        if (replyToId && !(await isMessageVisible(tx, roomId, replyToId, auth.userId)))
          throw fieldError("reply_to_id", "Pesan yang dibalas tidak ditemukan di percakapan ini.");
        const id = uuidv7();
        await insertMessageLocked(tx, {
          id,
          roomId,
          senderId: auth.userId,
          clientMessageId: input.client_message_id,
          kind: input.kind,
          body: input.text,
          imageFileId,
          replyToId,
          now,
        });
        // Read cursor pengirim maju ke pesannya sendiri (selalu terbaru di bawah kunci room → monoton).
        await tx
          .update(roomMembers)
          .set({ lastReadMessageId: id, lastReadAt: now, updatedAt: now })
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, auth.userId)));
        await this.schedulePush(tx, room, auth.userId, now);
        const found = await messageRows(tx, { roomId, viewerId: auth.userId, ids: [id] });
        const [message] = await this.presenter.messages(tx, found, auth);
        const [broadcast] = await this.presenter.messages(tx, found, null, { realtime: true });
        // Setelah commit: message.created ke kanal room (hanya socket anggota aktif yang berlangganan) dan status baca.
        this.events.messageCreated(roomId, ChatPresenter.asRealtime(broadcast!));
        this.events.readUpdated({
          room_id: roomId,
          user_id: auth.userId,
          last_read_message_id: id,
          last_read_at: now.toISOString(),
        });
        return { status: 201 as const, message: message! };
      });
    } catch (error) {
      // client_message_id yang sama dikirim bersamaan ke room berbeda: unique per pengirim menjadi wasit (AC F11-2).
      if (!isUniqueViolation(error, "messages_sender_id_client_message_id_key")) throw error;
      const winner = await this.findByClientId(this.db, auth.userId, input.client_message_id);
      if (!winner) throw error;
      return { status: 200, message: await this.replay(auth, roomId, winner, input) };
    }
  }

  private async findByClientId(db: DbOrTx, senderId: string, clientMessageId: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, senderId), eq(messages.clientMessageId, clientMessageId)))
      .limit(1);
    return row;
  }

  /**
   * Pengulangan client_message_id (AC F11-2): room dan isi sama → pesan yang sama; selain itu 409 IDEMPOTENCY_CONFLICT.
   * Keanggotaan tetap diperiksa (AC F11-4): pengirim yang sudah keluar tidak dapat membaca pesan lewat pengulangan.
   */
  private async replay(
    auth: AuthContext,
    roomId: string,
    existing: typeof messages.$inferSelect,
    input: SendInput & { text: string | null },
    db: DbOrTx = this.db,
  ): Promise<ChatMessageDto> {
    const same =
      existing.roomId === roomId &&
      existing.kind === input.kind &&
      (existing.replyToId ?? null) === (input.reply_to_id ?? null) &&
      (existing.deletedAt !== null ||
        ((existing.body ?? null) === input.text &&
          (existing.imageFileId ?? null) === (input.image_file_id ?? null)));
    if (!same) throw new AppException(409, "IDEMPOTENCY_CONFLICT", MSG.clientMessageConflict);
    await this.requireJoined(db, roomId, auth.userId);
    const [message] = await this.dtosFor(db, roomId, [existing.id], auth);
    if (!message) throw notFound(MSG.messageNotFound);
    return message;
  }

  /**
   * Izin kirim di bawah kunci room (AC F12-1, F11-6): grup ditutup → 403; room direct → kunci pasangan BlockPolicy lalu
   * blokir dua arah dan status lawan bicara. Blokir oleh lawan bicara dan lawan bicara nonaktif memakai pesan yang sama
   * (N-09). Status pengirim sudah diperiksa AuthGuard (@MemberAccess active) pada request ini.
   */
  private async assertCanSend(tx: Tx, room: RoomRow, senderId: string): Promise<void> {
    if (room.kind === "group") {
      if (room.closedAt) throw forbidden(MSG.roomClosed);
      return;
    }
    const peerId = directPeerId(room.directKey, senderId);
    if (!peerId) throw forbidden(MSG.peerUnavailable);
    await this.blocks.lockPair(tx, senderId, peerId);
    await this.assertDirectPeer(tx, senderId, peerId);
  }

  private async assertDirectPeer(tx: DbOrTx, me: string, peerId: string): Promise<void> {
    const found = rows<{ blocker_id: string }>(
      await tx.execute(sql`
        select blocker_id from app.blocks
        where (blocker_id = ${me}::uuid and blocked_id = ${peerId}::uuid)
           or (blocker_id = ${peerId}::uuid and blocked_id = ${me}::uuid)`),
    );
    if (found.some((row) => row.blocker_id === me)) throw forbidden(MSG.youBlocked);
    if (found.length > 0) throw forbidden(MSG.peerUnavailable);
    const facts = (await alumniFacts(tx, [peerId])).get(peerId);
    const active =
      facts !== undefined &&
      isActiveMember(
        {
          accountStatus: facts.account_status,
          fullName: facts.full_name,
          suspendedAt: toDate(facts.suspended_at),
          expiresAt: toDate(facts.expires_at),
        },
        this.clock.now(),
      );
    if (!active) throw forbidden(MSG.peerUnavailable);
  }

  /**
   * Push kategori chat tanpa isi pesan (PRD 3.13, §4.7) HANYA untuk anggota joined selain pengirim yang aktif
   * (verified/expiring, tidak suspended), tidak mute room, dan preferensi push chat-nya menyala (kontrak
   * sendChatMessage). Satu notifikasi per "episode belum dibaca": kunci dedup memuat read cursor penerima, sehingga
   * pesan berikutnya sebelum penerima membaca tidak menambah inbox maupun push (riwayat resmi tetap di chat).
   */
  private async schedulePush(tx: Tx, room: RoomRow, senderId: string, now: Date): Promise<void> {
    const members = await tx
      .select({ userId: roomMembers.userId, lastRead: roomMembers.lastReadMessageId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, room.id),
          eq(roomMembers.status, "joined"),
          eq(roomMembers.muted, false),
          ne(roomMembers.userId, senderId),
        ),
      );
    if (members.length === 0) return;
    const statuses = await this.membership.effectiveStatusesFor(
      members.map((m) => m.userId),
      { db: tx, now },
    );
    let recipients = members.filter((m) => {
      const status = statuses.get(m.userId);
      return status !== undefined && status.accountStatus === "active" && hasActiveMembership(status.status);
    });
    if (recipients.length === 0) return;
    const optedOut = new Set(
      (
        await tx
          .select({ userId: notificationPreferences.userId })
          .from(notificationPreferences)
          .where(
            and(
              inArray(
                notificationPreferences.userId,
                recipients.map((r) => r.userId),
              ),
              eq(notificationPreferences.category, "chat"),
              eq(notificationPreferences.channel, "push"),
              eq(notificationPreferences.enabled, false),
            ),
          )
      ).map((row) => row.userId),
    );
    recipients = recipients.filter((r) => !optedOut.has(r.userId));
    const dedupOf = (r: { lastRead: string | null }) => `chat.message:${room.id}:${r.lastRead ?? "none"}`;
    // Saring awal episode yang sudah memiliki notifikasi (format kunci NotificationService: u:<user>:<dedupKey>);
    // notify() tetap menjadi pengaman dedup bila format berubah.
    const existing = new Set(
      recipients.length === 0
        ? []
        : (
            await tx
              .select({ key: notifications.dedupKey })
              .from(notifications)
              .where(
                inArray(
                  notifications.dedupKey,
                  recipients.map((r) => `u:${r.userId}:${dedupOf(r)}`),
                ),
              )
          ).map((row) => row.key),
    );
    const sender = room.kind === "direct" ? await this.writer.displayName(tx, senderId) : null;
    for (const recipient of recipients) {
      if (existing.has(`u:${recipient.userId}:${dedupOf(recipient)}`)) continue;
      await this.notifications.notify(tx, {
        userId: recipient.userId,
        category: "chat",
        title: "Pesan baru",
        body: room.kind === "group" ? `Ada pesan baru di grup "${room.name}".` : `Ada pesan baru dari ${sender}.`,
        route: `/chat/${room.id}`,
        data: { room_id: room.id },
        dedupKey: dedupOf(recipient),
      });
    }
  }

  // ----------------------------------------------------------------------------------------------------- hapus

  /** Hapus pesan sendiri menjadi placeholder; idempoten; bukti laporan tidak ikut terhapus (PRD 3.12). */
  async remove(auth: AuthContext, roomId: string, messageId: string): Promise<ChatMessageDto> {
    return this.db.transaction(async (tx) => {
      await this.requireJoined(tx, roomId, auth.userId);
      if (!(await isMessageVisible(tx, roomId, messageId, auth.userId))) throw notFound(MSG.messageNotFound);
      const [target] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .for("no key update");
      if (!target) throw notFound(MSG.messageNotFound);
      if (target.kind === "system" || target.senderId !== auth.userId)
        throw forbidden("Hanya pengirim yang dapat menghapus pesannya.");
      if (!target.deletedAt) {
        const now = this.clock.now();
        await tx
          .update(messages)
          .set({ body: null, imageFileId: null, deletedAt: now })
          .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)));
        await tx.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
        if (target.imageFileId) await this.writer.releaseFile(tx, target.imageFileId);
        this.events.messageDeleted(roomId, messageId, now.toISOString());
      }
      const [message] = await this.dtosFor(tx, roomId, [messageId], auth);
      return message!;
    });
  }

  // ----------------------------------------------------------------------------------------------------- reaksi

  async addReaction(
    auth: AuthContext,
    roomId: string,
    messageId: string,
    rawEmoji: string,
  ): Promise<ChatMessageReactions> {
    const emoji = parseEmoji(rawEmoji);
    return this.db.transaction(async (tx) => {
      await this.requireJoined(tx, roomId, auth.userId);
      if (!(await isMessageVisible(tx, roomId, messageId, auth.userId))) throw notFound(MSG.messageNotFound);
      const room = await findRoom(tx, roomId);
      if (!room) throw notFound(MSG.roomNotFound);
      if (room.kind === "direct") {
        // Blokir dua arah atau lawan bicara tidak tersedia → 403 dengan pesan yang sama (AC F12-1, N-09).
        const peerId = directPeerId(room.directKey, auth.userId);
        if (!peerId) throw forbidden(MSG.peerUnavailable);
        await this.blocks.lockPair(tx, auth.userId, peerId);
        await this.assertDirectPeer(tx, auth.userId, peerId).catch((error: unknown) => {
          throw error instanceof AppException ? forbidden(MSG.peerUnavailable) : error;
        });
      }
      // Kunci baris pesan: menyerialkan reaksi per pesan (batas 10 emoji) dan penghapusan pesan.
      const [target] = await tx
        .select({ kind: messages.kind, deletedAt: messages.deletedAt })
        .from(messages)
        .where(eq(messages.id, messageId))
        .for("no key update");
      if (!target || target.deletedAt || target.kind === "system")
        throw fieldError("emoji", "Pesan ini tidak dapat diberi reaksi.");
      const [mine] = await tx
        .select({ value: count() })
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, auth.userId),
            ne(messageReactions.emoji, emoji),
          ),
        );
      if (Number(mine?.value ?? 0) >= MAX_REACTIONS_PER_USER)
        throw fieldError("emoji", `Maksimal ${MAX_REACTIONS_PER_USER} reaksi berbeda per pesan.`);
      const inserted = await tx
        .insert(messageReactions)
        .values({ messageId, userId: auth.userId, emoji, createdAt: this.clock.now() })
        .onConflictDoNothing()
        .returning({ emoji: messageReactions.emoji });
      return this.reactionsResult(tx, roomId, messageId, auth.userId, emoji, inserted.length > 0 ? "added" : null);
    });
  }

  async removeReaction(
    auth: AuthContext,
    roomId: string,
    messageId: string,
    rawEmoji: string,
  ): Promise<ChatMessageReactions> {
    const emoji = parseEmoji(rawEmoji);
    return this.db.transaction(async (tx) => {
      await this.requireJoined(tx, roomId, auth.userId);
      if (!(await isMessageVisible(tx, roomId, messageId, auth.userId))) throw notFound(MSG.messageNotFound);
      const removed = await tx
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, auth.userId),
            eq(messageReactions.emoji, emoji),
          ),
        )
        .returning({ emoji: messageReactions.emoji });
      return this.reactionsResult(tx, roomId, messageId, auth.userId, emoji, removed.length > 0 ? "removed" : null);
    });
  }

  private async reactionsResult(
    tx: DbOrTx,
    roomId: string,
    messageId: string,
    userId: string,
    emoji: string,
    action: "added" | "removed" | null,
  ): Promise<ChatMessageReactions> {
    const summary = (await reactionCounts(tx, [messageId], userId)).get(messageId) ?? [];
    if (action)
      this.events.reactionUpdated({
        room_id: roomId,
        message_id: messageId,
        user_id: userId,
        emoji,
        action,
        counts: summary.map((r) => ({ emoji: r.emoji, count: r.count })),
      });
    return {
      message_id: messageId,
      reactions: summary.map((r) => ({ emoji: r.emoji, count: r.count, reacted_by_me: r.mine })),
    };
  }

  // ---------------------------------------------------------------------------------------------- read cursor

  /**
   * Read cursor monoton (PRD 3.11): UPDATE bersyarat (created_at, id) jangkar > cursor saat ini. Pada pembaruan
   * bersamaan PostgreSQL mengevaluasi ulang syarat terhadap baris terbaru (READ COMMITTED), sehingga paket terlambat
   * tidak pernah memundurkan cursor. read.updated hanya dikirim bila cursor benar-benar maju.
   */
  async markRead(auth: AuthContext, roomId: string, body: unknown): Promise<ChatReadState> {
    const { message_id: messageId } = validate(readSchema, body);
    await this.requireJoined(this.db, roomId, auth.userId);
    if (!(await isMessageVisible(this.db, roomId, messageId, auth.userId)))
      throw fieldError("message_id", "Pesan tidak ditemukan di percakapan ini.");
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const advanced = rows<{ user_id: string }>(
        await tx.execute(sql`
          update app.room_members rm
          set last_read_message_id = n.id, last_read_at = ${now.toISOString()}::timestamptz,
              updated_at = ${now.toISOString()}::timestamptz
          from app.messages n
          where n.id = ${messageId}::uuid and n.room_id = rm.room_id
            and rm.room_id = ${roomId}::uuid and rm.user_id = ${auth.userId}::uuid and rm.status = 'joined'
            and (rm.last_read_message_id is null
                 or not exists (select 1 from app.messages c where c.id = rm.last_read_message_id)
                 or (n.created_at, n.id) > (select c.created_at, c.id from app.messages c
                                             where c.id = rm.last_read_message_id))
          returning rm.user_id`),
      );
      const [state] = await tx
        .select({ lastRead: roomMembers.lastReadMessageId, lastReadAt: roomMembers.lastReadAt })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, auth.userId)));
      if (!state) throw notFound(MSG.roomNotFound);
      if (advanced.length > 0 && state.lastRead && state.lastReadAt)
        this.events.readUpdated({
          room_id: roomId,
          user_id: auth.userId,
          last_read_message_id: state.lastRead,
          last_read_at: state.lastReadAt.toISOString(),
        });
      return {
        room_id: roomId,
        last_read_message_id: state.lastRead,
        last_read_at: state.lastReadAt?.toISOString() ?? null,
        unread_count: Math.min(await unreadCount(tx, roomId, auth.userId), 999),
      };
    });
  }
}
