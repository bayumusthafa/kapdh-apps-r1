import { Inject, Injectable } from "@nestjs/common";
import type { RealtimeEventType, RealtimePayloads } from "@kapdh/contracts";
import type { Logger } from "pino";
import type { Clock } from "../../core/adapters/clock.js";
import { afterCommit } from "../../core/db/tx.js";
import type { Db } from "../../core/db/types.js";
import { safeError } from "../../core/logging/safe-error.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, ROOT_LOGGER } from "../../core/tokens.js";
import { type ChatViewer, ChatPresenter, type FileRefLite, isPrivateReady } from "./chat.presenter.js";
import {
  type MemberRole,
  messageRows,
  type SessionRecipientQuery,
  sessionRecipients,
} from "./chat.queries.js";

export type MemberChange = RealtimePayloads["room.member_changed"]["change"];
export type RoomChange = RealtimePayloads["room.updated"]["changes"][number];

export interface MemberChangedInput {
  roomId: string;
  userId: string;
  change: MemberChange;
  /** Peran terbaru untuk joined/role_changed; null untuk perubahan lain. */
  role: MemberRole | null;
  memberCount: number;
  /** null untuk tindakan sistem (grup ditutup, penghapusan akun, pembatalan karena blokir; N-09). */
  actorUserId: string | null;
}

export interface RoomUpdatedInput {
  roomId: string;
  version: number;
  changes: RoomChange[];
  /** Nama grup terbaru; null untuk room direct. */
  name: string | null;
  /** Berkas avatar grup terbaru (purpose chat_image); null bila tidak ada atau room direct. */
  avatar: FileRefLite | null;
  closedAt: Date | null;
  /** Perubahan milik satu pengguna (muted, send_permission): hanya perangkat pengguna ini. */
  toUserId?: string;
}

/**
 * Event realtime chat (events/*.schema.json, events/README.md), semuanya SESUDAH commit transaksi pemanggil (PRD 5.2:
 * event tidak mendahului data). Kanal mengikuti kontrak C6:
 * - joined/left/removed/role_changed → kanal room:<id> dan user:<terdampak> (tepat sekali per socket: kanal room
 *   mengecualikan socket pengguna terdampak yang menerima lewat kanal user-nya);
 * - invited/invitation_cancelled/declined → HANYA user:<calon anggota> dan user:<admin grup joined>, tidak pernah
 *   kanal room (undangan tertunda hanya terlihat admin grup, N-09).
 *
 * Event yang memuat URL berkas privat (message.created dengan gambar atau avatar privat pengirim, room.updated dengan
 * avatar grup) TIDAK disiarkan sebagai satu payload ke kanal room: URL seperti itu harus terikat sesi penerimanya agar
 * membuka URL mengulang kebijakan akses (PRD 5.4 "TTL tidak menggantikan otorisasi", AC F11-4: anggota yang keluar
 * atau dikeluarkan langsung ditolak walau URL sudah diterimanya). Event itu dikirim per keluarga sesi penerima
 * (kanal session:<familyId>) dengan URL terikat sesi itu. Penerima dihitung dari database sesudah commit dengan aturan
 * yang sama dengan kanal room (anggota joined berstatus aktif dengan keluarga sesi aktif; pesan juga dibatasi
 * history_visible_from penerima), sehingga setiap perangkat tetap menerima tepat satu salinan. Galat penyiaran hanya
 * dicatat: data sudah commit dan klien menyinkron lewat HTTP (event bukan sumber kebenaran).
 */
@Injectable()
export class ChatEvents {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly presenter: ChatPresenter,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  memberChanged(input: MemberChangedInput, inviteAudience: readonly string[] = []): void {
    const payload: RealtimePayloads["room.member_changed"] = {
      room_id: input.roomId,
      user_id: input.userId,
      change: input.change,
      role: input.change === "joined" || input.change === "role_changed" ? input.role : null,
      member_count: Math.min(input.memberCount, 100),
      actor_user_id: input.actorUserId,
    };
    if (
      input.change === "invited" ||
      input.change === "invitation_cancelled" ||
      input.change === "declined"
    ) {
      this.realtime.emitToUsers(
        [input.userId, ...inviteAudience],
        "room.member_changed",
        input.roomId,
        payload,
      );
      return;
    }
    this.realtime.emitToRoom(input.roomId, "room.member_changed", input.roomId, payload, {
      exceptUserId: input.userId,
    });
    this.realtime.emitToUser(input.userId, "room.member_changed", input.roomId, payload);
  }

  /**
   * message.created untuk pesan yang baru disisipkan (pesan anggota maupun sistem), dibangun dari database sesudah
   * commit dalam bentuk RealtimeChatMessage. Tanpa berkas privat: satu siaran ke kanal room; selain itu per keluarga
   * sesi penerima dengan URL terikat sesi.
   */
  messageCreated(roomId: string, messageId: string): void {
    this.afterCommit("message.created", async () => {
      const found = await messageRows(this.db, { roomId, viewerId: null, ids: [messageId] });
      const row = found[0];
      if (!row) return;
      const names = await this.presenter.nameLookup(this.db, ChatPresenter.systemBodies(found));
      const build = async (viewer: ChatViewer | null) => {
        const [message] = await this.presenter.messages(this.db, found, viewer, { realtime: true, names });
        return { room_id: roomId, message: ChatPresenter.asRealtime(message!) };
      };
      if (!ChatPresenter.hasPrivateFiles(row)) {
        this.realtime.emitToRoom(roomId, "message.created", messageId, await build(null));
        return;
      }
      await this.perSession({ roomId, messageId }, "message.created", messageId, build);
    });
  }

  messageDeleted(roomId: string, messageId: string, deletedAt: string): void {
    this.realtime.emitToRoom(roomId, "message.deleted", messageId, {
      room_id: roomId,
      message_id: messageId,
      deleted_at: deletedAt,
    });
  }

  reactionUpdated(payload: RealtimePayloads["reaction.updated"]): void {
    this.realtime.emitToRoom(payload.room_id, "reaction.updated", payload.message_id, payload);
  }

  readUpdated(payload: RealtimePayloads["read.updated"]): void {
    this.realtime.emitToRoom(payload.room_id, "read.updated", payload.room_id, payload);
  }

  /**
   * room.updated: perubahan bersama (group_name, group_avatar, closed) ke anggota room; perubahan milik satu pengguna
   * (muted, send_permission) hanya ke perangkat pengguna itu (events/room.updated.schema.json). Avatar grup privat →
   * per keluarga sesi penerima dengan URL terikat sesi.
   */
  roomUpdated(input: RoomUpdatedInput): void {
    this.afterCommit("room.updated", async () => {
      const build = async (viewer: ChatViewer | null): Promise<RealtimePayloads["room.updated"]> => ({
        room_id: input.roomId,
        version: String(input.version),
        changes: input.changes,
        name: input.name,
        avatar_url: input.avatar
          ? ((await this.presenter.fileUrl(input.avatar, "chat_image", viewer))?.url ?? null)
          : null,
        closed_at: input.closedAt?.toISOString() ?? null,
      });
      if (input.avatar && isPrivateReady(input.avatar)) {
        await this.perSession(
          { roomId: input.roomId, userId: input.toUserId },
          "room.updated",
          input.roomId,
          build,
        );
        return;
      }
      const payload = await build(null);
      if (input.toUserId) this.realtime.emitToUser(input.toUserId, "room.updated", input.roomId, payload);
      else this.realtime.emitToRoom(input.roomId, "room.updated", input.roomId, payload);
    });
  }

  /** Socket pengguna mulai/berhenti menerima kanal room (setelah commit). */
  join(userId: string, roomId: string): void {
    this.realtime.joinRoom(userId, roomId);
  }

  leave(userId: string, roomId: string): void {
    this.realtime.leaveRoom(userId, roomId);
  }

  /** Kirim per keluarga sesi penerima dengan payload yang dibangun untuk sesi itu (URL terikat sesi). */
  private async perSession<T extends RealtimeEventType>(
    query: Omit<SessionRecipientQuery, "now">,
    type: T,
    entityId: string,
    build: (viewer: ChatViewer) => Promise<RealtimePayloads[T]>,
  ): Promise<void> {
    const recipients = await sessionRecipients(this.db, { ...query, now: this.clock.now() });
    const payloads = await Promise.all(
      recipients.map((recipient) =>
        build({
          userId: recipient.user_id,
          sessionId: recipient.session_id,
          sessionVersion: recipient.session_version,
        }),
      ),
    );
    recipients.forEach((recipient, index) =>
      this.realtime.emitToSession(recipient.family_id, type, entityId, payloads[index]!),
    );
  }

  /**
   * Dijalankan sesudah commit (segera bila di luar transaksi); galat hanya dicatat tanpa isi pesan. Tanpa transport
   * (worker tanpa Redis) tidak ada kueri maupun penandatanganan URL.
   */
  private afterCommit(label: string, task: () => Promise<void>): void {
    afterCommit(async () => {
      if (this.realtime.transportKind === "none") return;
      try {
        await task();
      } catch (error) {
        this.logger.warn(
          { error: safeError(error), action: label },
          "penyiaran realtime chat gagal (data tetap tersimpan)",
        );
      }
    });
  }
}
