import { Inject, Injectable } from "@nestjs/common";
import { messageReactions, messages, roomMembers, rooms } from "@kapdh/database";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { rows } from "../../core/db/rows.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { FilesService } from "../../core/files/files.service.js";
import { hasActiveMembership } from "../../core/membership/effective-status.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { DELETION_EVENT_CAP } from "./chat.constants.js";
import { ChatEvents } from "./chat.events.js";
import { ChatPresenter } from "./chat.presenter.js";
import { findDirectRoom, joinedCount, lockRoom } from "./chat.queries.js";
import { ChatWriter } from "./chat.writer.js";

export interface DeletedAccountChatResult {
  /** Grup yang ditinggalkan pengguna yang dihapus. */
  groupsLeft: number;
  /** Grup yang ditutup otomatis (tidak ada anggota aktif lain untuk menerima kewenangan admin). */
  groupsClosed: number;
  /** Grup yang kewenangan adminnya dialihkan sistem ke anggota aktif lain (AC F11-5, F14-5). */
  adminsReassigned: number;
  invitationsCancelled: number;
  messagesPlaceholdered: number;
}

/**
 * Efek chat dari domain lain, tanpa controller dan tanpa layanan khusus API sehingga aman dimuat worker
 * (ChatLifecycleModule; ARCHITECTURE §4.1, §4.8):
 * - moderation (F-12): blokir baru membatalkan undangan tertunda antara pasangan dan memberi tahu perangkat pemblokir
 *   (room.updated send_permission); keputusan remove_message menjadikan pesan placeholder;
 * - account (F-14): pengungkapan jumlah grup yang admin tunggalnya pengguna, dan pelepasan akun yang dihapus dari chat
 *   dengan aturan pengalihan sistem (AC F11-5 "Penghapusan akun memakai aturan pengalihan sistem agar tidak
 *   terhambat", AC F14-3 placeholder, AC F14-5).
 * Urutan kunci bersama modul chat: baris rooms (FOR UPDATE) → kunci pasangan blokir (advisory) → baris room_members /
 * messages. Helper blokir di sini tidak mengunci baris rooms, sehingga aman dipanggil sesudah BlockPolicy.lockPair.
 */
@Injectable()
export class ChatLifecycleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly writer: ChatWriter,
    private readonly events: ChatEvents,
    private readonly presenter: ChatPresenter,
    private readonly files: FilesService,
    private readonly membership: MembershipKernel,
  ) {}

  // ---------------------------------------------------------------------------------------------- blokir (F-12)

  /**
   * Dipanggil modul moderation DI DALAM transaksi blockMember, SESUDAH BlockPolicy.lockPair dan insert blok
   * (kontrak blockMember): undangan grup tertunda dari salah satu pihak kepada yang lain dibatalkan dengan
   * actor_user_id null (tidak dapat dibedakan dari tindakan sistem lain, N-09), lalu perangkat pemblokir menerima
   * room.updated (send_permission) untuk room direct bila ada. Mengembalikan jumlah undangan yang dibatalkan.
   */
  async onBlockCreated(tx: Tx, blockerId: string, blockedId: string): Promise<number> {
    const pending = await tx
      .select({ roomId: roomMembers.roomId, userId: roomMembers.userId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.status, "invited"),
          or(
            and(eq(roomMembers.userId, blockedId), eq(roomMembers.invitedBy, blockerId)),
            and(eq(roomMembers.userId, blockerId), eq(roomMembers.invitedBy, blockedId)),
          ),
        ),
      );
    let cancelled = 0;
    for (const invite of pending)
      if (await this.writer.cancelInvitation(tx, invite.roomId, invite.userId, null)) cancelled++;
    await this.sendPermissionChanged(tx, blockerId, blockedId);
    return cancelled;
  }

  /** Dipanggil modul moderation setelah unblockMember: perangkat pemanggil memuat ulang izin kirim room direct. */
  async onBlockRemoved(db: DbOrTx, blockerId: string, blockedId: string): Promise<void> {
    await this.sendPermissionChanged(db, blockerId, blockedId);
  }

  /** room.updated (changes send_permission) hanya ke kanal user `userId`; pihak lain tidak diberi tahu (N-09). */
  private async sendPermissionChanged(db: DbOrTx, userId: string, otherId: string): Promise<void> {
    const room = await findDirectRoom(db, userId, otherId);
    if (!room) return;
    this.events.roomUpdated(
      {
        room_id: room.id,
        version: String(room.version),
        changes: ["send_permission"],
        name: null,
        avatar_url: null,
        closed_at: room.closedAt?.toISOString() ?? null,
      },
      userId,
    );
  }

  /**
   * Keputusan moderasi remove_message (kontrak admin-moderation): pesan menjadi placeholder (isi dan gambar
   * dikosongkan, reaksi dihapus), event message.deleted ke anggota room setelah commit. Berkas gambar ditahan bila
   * dirujuk bukti laporan. Mengembalikan room dan waktu hapus, atau null bila pesan tidak ada / sudah dihapus.
   */
  async removeMessage(tx: Tx, messageId: string): Promise<{ roomId: string; deletedAt: Date } | null> {
    const [target] = await tx
      .select({ roomId: messages.roomId, imageFileId: messages.imageFileId })
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt), ne(messages.kind, "system")))
      .for("no key update");
    if (!target) return null;
    const now = this.clock.now();
    await tx
      .update(messages)
      .set({ body: null, imageFileId: null, deletedAt: now })
      .where(eq(messages.id, messageId));
    await tx.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
    if (target.imageFileId) await this.writer.releaseFile(tx, target.imageFileId);
    this.events.messageDeleted(target.roomId, messageId, now.toISOString());
    return { roomId: target.roomId, deletedAt: now };
  }

  // ------------------------------------------------------------------------------------------- akun (F-14)

  /** AC F14-5 (pengungkapan): grup aktif yang admin joined satu-satunya adalah pengguna. */
  async soleAdminGroupCount(userId: string, db: DbOrTx = this.db): Promise<number> {
    const [row] = rows<{ n: number }>(
      await db.execute(sql`
        select count(*)::int as n from app.room_members rm
        join app.rooms r on r.id = rm.room_id and r.kind = 'group' and r.closed_at is null
        where rm.user_id = ${userId}::uuid and rm.status = 'joined' and rm.role = 'admin'
          and not exists (
            select 1 from app.room_members o
            where o.room_id = rm.room_id and o.status = 'joined' and o.role = 'admin' and o.user_id <> rm.user_id)`),
    );
    return row?.n ?? 0;
  }

  /**
   * Melepas akun yang dihapus dari chat (job penghapusan akun, F-14). Idempoten dan dapat diulang setelah gagal
   * (N-15): setiap grup diproses dalam transaksinya sendiri dengan kunci baris room lebih dulu (aturan C6).
   * - Grup joined: bila pengguna admin terakhir dan masih ada anggota lain, kewenangan dialihkan SISTEM ke anggota
   *   aktif yang paling lama bergabung tanpa menunggu respons siapa pun (AC F11-5, F14-5); tanpa anggota aktif lain
   *   grup ditutup otomatis dan undangan tertunda dibatalkan. Keanggotaan menjadi left (actor null).
   * - Undangan tertunda untuk pengguna dibatalkan (actor null).
   * - Pesan buatan pengguna menjadi placeholder tanpa isi dan reaksinya dihapus (AC F14-3); berkas gambar dilepas
   *   kecuali dirujuk bukti laporan (PRD 3.12, D2).
   * Room direct tetap ada: lawan bicara melihat "Akun dihapus" dan tidak dapat mengirim (peer_unavailable).
   * Wajib dipanggil SEBELUM baris users/berkas pengguna dihapus (catatan skema messages).
   */
  async detachDeletedAccount(userId: string): Promise<DeletedAccountChatResult> {
    const result: DeletedAccountChatResult = {
      groupsLeft: 0,
      groupsClosed: 0,
      adminsReassigned: 0,
      invitationsCancelled: 0,
      messagesPlaceholdered: 0,
    };
    const memberships = await this.db
      .select({ roomId: roomMembers.roomId, status: roomMembers.status })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(
        and(
          eq(roomMembers.userId, userId),
          eq(rooms.kind, "group"),
          inArray(roomMembers.status, ["joined", "invited"]),
        ),
      );
    for (const membership of memberships) {
      if (membership.status === "invited") {
        if (
          await this.db.transaction((tx) => this.writer.cancelInvitation(tx, membership.roomId, userId, null))
        )
          result.invitationsCancelled++;
        continue;
      }
      const outcome = await this.db.transaction((tx) => this.leaveGroupForDeletion(tx, membership.roomId, userId));
      if (outcome.left) result.groupsLeft++;
      if (outcome.closed) result.groupsClosed++;
      if (outcome.reassigned) result.adminsReassigned++;
    }
    result.messagesPlaceholdered = await this.db.transaction((tx) => this.placeholderMessagesOf(tx, userId));
    return result;
  }

  private async leaveGroupForDeletion(
    tx: Tx,
    roomId: string,
    userId: string,
  ): Promise<{ left: boolean; closed: boolean; reassigned: boolean }> {
    const room = await lockRoom(tx, roomId);
    const [me] = room
      ? await tx
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
      : [];
    if (!room || !me || me.status !== "joined") return { left: false, closed: false, reassigned: false };
    const others = await tx
      .select({ userId: roomMembers.userId, role: roomMembers.role })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "joined"), ne(roomMembers.userId, userId)))
      .orderBy(asc(roomMembers.joinedAt), asc(roomMembers.userId));
    const now = this.clock.now();
    let reassigned = false;
    let closed = false;
    const lastAdmin = me.role === "admin" && !others.some((o) => o.role === "admin");
    if (lastAdmin && others.length > 0 && !room.closedAt) {
      const statuses = await this.membership.effectiveStatusesFor(
        others.map((o) => o.userId),
        { db: tx, now },
      );
      const successor = others.find((o) => {
        const status = statuses.get(o.userId);
        return status !== undefined && status.accountStatus === "active" && hasActiveMembership(status.status);
      });
      if (successor) {
        await tx
          .update(roomMembers)
          .set({ role: "admin", updatedAt: now })
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, successor.userId)));
        const name = await this.writer.displayName(tx, successor.userId);
        await this.writer.systemMessage(
          tx,
          roomId,
          `${name} sekarang admin grup karena admin sebelumnya menghapus akunnya.`,
        );
        this.events.memberChanged({
          roomId,
          userId: successor.userId,
          change: "role_changed",
          role: "admin",
          memberCount: others.length + 1,
          actorUserId: null,
        });
        reassigned = true;
      } else {
        closed = true;
      }
    }
    await this.writer.systemMessage(tx, roomId, "Seorang anggota keluar dari grup karena akunnya dihapus.");
    await this.writer.endMembership(tx, roomId, userId, "left");
    if (others.length === 0 && !room.closedAt) closed = true;
    if (closed) {
      const [updated] = await tx
        .update(rooms)
        .set({ closedAt: now, version: sql`${rooms.version} + 1`, updatedAt: now })
        .where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)))
        .returning();
      await this.writer.cancelAllInvitations(tx, roomId);
      if (updated) {
        const avatar = updated.avatarFileId ? await this.files.findReady(updated.avatarFileId, tx) : null;
        this.events.roomUpdated({
          room_id: roomId,
          version: String(updated.version),
          changes: ["closed"],
          name: updated.name,
          avatar_url: avatar
            ? ((await this.presenter.fileUrl(
                { id: avatar.id, visibility: avatar.visibility, status: avatar.status },
                "chat_image",
                null,
              ))?.url ?? null)
            : null,
          closed_at: now.toISOString(),
        });
      }
    }
    this.events.memberChanged({
      roomId,
      userId,
      change: "left",
      role: null,
      memberCount: await joinedCount(tx, roomId),
      actorUserId: null,
    });
    this.events.leave(userId, roomId);
    return { left: true, closed, reassigned };
  }

  private async placeholderMessagesOf(tx: Tx, userId: string): Promise<number> {
    const now = this.clock.now();
    const changed = rows<{ id: string; room_id: string; image_file_id: string | null }>(
      await tx.execute(sql`
        with target as (
          select id, image_file_id from app.messages
          where sender_id = ${userId}::uuid and deleted_at is null and kind <> 'system'
          for no key update
        )
        update app.messages m set body = null, image_file_id = null, deleted_at = ${now.toISOString()}::timestamptz
        from target where m.id = target.id
        returning m.id, m.room_id, target.image_file_id`),
    );
    await tx.delete(messageReactions).where(eq(messageReactions.userId, userId));
    for (const row of changed) if (row.image_file_id) await this.writer.releaseFile(tx, row.image_file_id);
    // Event placeholder untuk pesan terbaru saja; sisanya diterapkan saat klien memuat ulang jendela pesan (C6 butir 7).
    for (const row of changed.slice(-DELETION_EVENT_CAP))
      this.events.messageDeleted(row.room_id, row.id, now.toISOString());
    return changed.length;
  }
}
