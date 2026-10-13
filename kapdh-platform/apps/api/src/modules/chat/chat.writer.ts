import { Inject, Injectable } from "@nestjs/common";
import { roomMembers } from "@kapdh/database";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { rows } from "../../core/db/rows.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { FilesService } from "../../core/files/files.service.js";
import { CLOCK } from "../../core/tokens.js";
import { DELETED_ACCOUNT_NAME } from "./chat.constants.js";
import { ChatEvents } from "./chat.events.js";
import { ChatPresenter } from "./chat.presenter.js";
import {
  alumniFacts,
  insertMessageLocked,
  joinedAdminIds,
  joinedCount,
  messageRows,
  referencedByReportEvidence,
} from "./chat.queries.js";

/**
 * Penulis bersama modul chat (dipakai layanan HTTP chat dan ChatLifecycleService untuk moderasi/penghapusan akun):
 * pesan sistem dengan aturan urutan commit C6, pembatalan undangan, dan pelepasan berkas. Semua efek realtime
 * ditunda sampai commit oleh RealtimeService.
 */
@Injectable()
export class ChatWriter {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly presenter: ChatPresenter,
    private readonly events: ChatEvents,
    private readonly files: FilesService,
  ) {}

  /** Nama tampilan anggota untuk teks pesan sistem ("Akun dihapus" bila tidak ada). */
  async displayName(db: DbOrTx, userId: string): Promise<string> {
    const facts = (await alumniFacts(db, [userId])).get(userId);
    return facts && facts.account_status !== "deleted" ? facts.full_name : DELETED_ACCOUNT_NAME;
  }

  /**
   * Pesan sistem (mis. anggota bergabung/keluar). Pemanggil WAJIB sudah mengunci baris room sebagai kunci pertama
   * transaksi (aturan C6). message.created dikirim ke kanal room setelah commit. Mengembalikan id pesan.
   */
  async systemMessage(tx: Tx, roomId: string, body: string): Promise<string> {
    const id = uuidv7();
    await insertMessageLocked(tx, {
      id,
      roomId,
      senderId: null,
      clientMessageId: null,
      kind: "system",
      body,
      now: this.clock.now(),
    });
    await this.broadcastCreated(tx, roomId, id);
    return id;
  }

  /** Menyiarkan message.created untuk pesan yang baru disisipkan (bentuk RealtimeChatMessage, URL tanpa penerima). */
  async broadcastCreated(tx: DbOrTx, roomId: string, messageId: string): Promise<void> {
    const found = await messageRows(tx, { roomId, viewerId: null, ids: [messageId] });
    const [dto] = await this.presenter.messages(tx, found, null, { realtime: true });
    if (dto) this.events.messageCreated(roomId, ChatPresenter.asRealtime(dto));
  }

  /**
   * Membatalkan undangan tertunda (invited → removed) dan memberi tahu calon anggota serta admin grup joined lewat
   * kanal user saja (invitation_cancelled). actorUserId null untuk tindakan sistem (blokir, grup ditutup, penghapusan
   * akun) agar penyebabnya tidak dapat dibedakan (N-09). false bila tidak ada undangan tertunda.
   */
  async cancelInvitation(
    tx: Tx,
    roomId: string,
    userId: string,
    actorUserId: string | null,
  ): Promise<boolean> {
    const now = this.clock.now();
    const [cancelled] = await tx
      .update(roomMembers)
      .set({ status: "removed", updatedAt: now })
      .where(
        and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId), eq(roomMembers.status, "invited")),
      )
      .returning({ userId: roomMembers.userId });
    if (!cancelled) return false;
    this.events.memberChanged(
      {
        roomId,
        userId,
        change: "invitation_cancelled",
        role: null,
        memberCount: await joinedCount(tx, roomId),
        actorUserId,
      },
      await joinedAdminIds(tx, roomId),
    );
    return true;
  }

  /** Membatalkan semua undangan tertunda grup (grup ditutup); actor null. */
  async cancelAllInvitations(tx: Tx, roomId: string): Promise<number> {
    const now = this.clock.now();
    const cancelled = await tx
      .update(roomMembers)
      .set({ status: "removed", updatedAt: now })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "invited")))
      .returning({ userId: roomMembers.userId });
    if (cancelled.length === 0) return 0;
    const admins = await joinedAdminIds(tx, roomId);
    const count = await joinedCount(tx, roomId);
    for (const row of cancelled)
      this.events.memberChanged(
        {
          roomId,
          userId: row.userId,
          change: "invitation_cancelled",
          role: null,
          memberCount: count,
          actorUserId: null,
        },
        admins,
      );
    return cancelled.length;
  }

  /**
   * Melepas berkas chat yang tidak dipakai lagi (gambar pesan terhapus, avatar grup lama): ditandai deleted dan objek
   * dihapus setelah commit, KECUALI masih dirujuk bukti laporan (PRD 3.12, D2).
   */
  async releaseFile(tx: Tx, fileId: string): Promise<void> {
    if (await referencedByReportEvidence(tx, fileId)) return;
    await this.files.discard(tx, fileId);
  }

  /**
   * Mengubah keanggotaan joined menjadi left/removed (riwayat dan langganan socket dicabut, AC F11-4). Tidak mengubah
   * peran admin lain; pemanggil memastikan aturan admin terakhir (AC F11-5). true bila berubah.
   */
  async endMembership(tx: Tx, roomId: string, userId: string, status: "left" | "removed"): Promise<boolean> {
    const now = this.clock.now();
    const changed = rows<{ user_id: string }>(
      await tx.execute(sql`
        update app.room_members set status = ${status}::app.room_member_status, role = 'member', left_at = ${now.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
        where room_id = ${roomId}::uuid and user_id = ${userId}::uuid and status = 'joined'
        returning user_id`),
    );
    return changed.length === 1;
  }
}
