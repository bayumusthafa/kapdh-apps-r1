import { Injectable } from "@nestjs/common";
import type { RealtimeChatMessage, RealtimePayloads } from "@kapdh/contracts";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import type { MemberRole } from "./chat.queries.js";

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

/**
 * Event realtime chat (events/*.schema.json, events/README.md). Semua pemanggilan di dalam transaksi otomatis ditunda
 * sampai commit oleh RealtimeService (PRD 5.2: event tidak mendahului data). Kanal mengikuti kontrak C6:
 * - joined/left/removed/role_changed → kanal room:<id> dan user:<terdampak> (tepat sekali per socket: kanal room
 *   mengecualikan socket pengguna terdampak yang menerima lewat kanal user-nya);
 * - invited/invitation_cancelled/declined → HANYA user:<calon anggota> dan user:<admin grup joined>, tidak pernah
 *   kanal room (undangan tertunda hanya terlihat admin grup, N-09).
 */
@Injectable()
export class ChatEvents {
  constructor(private readonly realtime: RealtimeService) {}

  memberChanged(input: MemberChangedInput, inviteAudience: readonly string[] = []): void {
    const payload: RealtimePayloads["room.member_changed"] = {
      room_id: input.roomId,
      user_id: input.userId,
      change: input.change,
      role: input.change === "joined" || input.change === "role_changed" ? input.role : null,
      member_count: Math.min(input.memberCount, 100),
      actor_user_id: input.actorUserId,
    };
    if (input.change === "invited" || input.change === "invitation_cancelled" || input.change === "declined") {
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

  messageCreated(roomId: string, message: RealtimeChatMessage): void {
    this.realtime.emitToRoom(roomId, "message.created", message.id, { room_id: roomId, message });
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
   * Perubahan bersama (group_name, group_avatar, closed) ke kanal room; perubahan milik satu pengguna (muted,
   * send_permission) hanya ke kanal user pengguna itu (events/room.updated.schema.json).
   */
  roomUpdated(payload: RealtimePayloads["room.updated"], toUserId?: string): void {
    if (toUserId) this.realtime.emitToUser(toUserId, "room.updated", payload.room_id, payload);
    else this.realtime.emitToRoom(payload.room_id, "room.updated", payload.room_id, payload);
  }

  /** Socket pengguna mulai/berhenti menerima kanal room (setelah commit). */
  join(userId: string, roomId: string): void {
    this.realtime.joinRoom(userId, roomId);
  }

  leave(userId: string, roomId: string): void {
    this.realtime.leaveRoom(userId, roomId);
  }
}
