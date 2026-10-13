import { Inject, Injectable } from "@nestjs/common";
import type { components, RealtimeChatMessage } from "@kapdh/contracts";
import type { Clock } from "../../core/adapters/clock.js";
import type { DbOrTx } from "../../core/db/types.js";
import type { FileTokenSubject } from "../../core/files/file-token.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import {
  type AccountStatus,
  effectiveStatus,
  hasActiveMembership,
} from "../../core/membership/effective-status.js";
import { CLOCK } from "../../core/tokens.js";
import { DELETED_ACCOUNT_NAME, PREVIEW_CHARS } from "./chat.constants.js";
import {
  type MessageRow,
  reactionCounts,
  type ReactionCountRow,
  type RoomSummaryRow,
  toDate,
} from "./chat.queries.js";
import { previewOf } from "./content-filter.js";

export type ChatRoomSummaryDto = components["schemas"]["ChatRoomSummary"];
export type ChatRoomDto = components["schemas"]["ChatRoom"];
export type ChatMessageDto = components["schemas"]["ChatMessage"];
export type ChatUserRefDto = components["schemas"]["ChatUserRef"];
export type ChatPeerDto = components["schemas"]["ChatPeer"];
export type ChatReactionDto = components["schemas"]["ChatReaction"];
export type ChatSendRestriction = components["schemas"]["ChatSendRestriction"];

/** Penampil HTTP: URL berkas privat diikat ke sesi penampil (PRD 5.4: TTL tidak menggantikan otorisasi). */
export type ChatViewer = Pick<AuthContext, "userId" | "sessionId" | "sessionVersion">;

/** Rujukan berkas minimum untuk URL: null bila tidak ada atau belum/tidak lagi `ready`. */
export interface FileRefLite {
  id: string | null;
  visibility: string | null;
  status: string | null;
}

/** Fakta akun pengguna lain untuk status "tersedia" (ChatPeer.available, peer_unavailable, N-09). */
export interface UserFacts {
  accountStatus: string | null;
  fullName: string | null;
  suspendedAt: Date | null;
  expiresAt: Date | null;
}

/** Akun dianggap dihapus bila baris users/alumni tidak ada atau status `deleted` (D2, AC F14-3). */
export function isDeletedAccount(facts: Pick<UserFacts, "accountStatus" | "fullName">): boolean {
  return !facts.accountStatus || facts.accountStatus === "deleted" || facts.fullName === null;
}

/** Status efektif aktif (verified/expiring, tidak suspended) dari data canonical (PRD 2.2, ARCHITECTURE §3.1). */
export function isActiveMember(facts: UserFacts, now: Date): boolean {
  if (isDeletedAccount(facts)) return false;
  return hasActiveMembership(
    effectiveStatus(
      {
        accountStatus: facts.accountStatus as AccountStatus,
        expiresAt: facts.expiresAt,
        suspendedAt: facts.suspendedAt,
      },
      now,
    ),
  );
}

/**
 * Pemetaan baris kueri chat ke skema kontrak (domains/chat.yaml, events/realtime-chat-*.schema.json). URL berkas:
 * - respons HTTP: URL bertanda tangan terikat sesi penampil (dibuka ulang hanya bila kebijakan akses masih lolos);
 * - siaran realtime room: URL terikat berkas tanpa penerima tertentu (kanal room:<id> sudah dibatasi anggota aktif,
 *   kontrak "URL bertanda tangan maksimal 10 menit dan terikat berkas").
 * Isi pesan tidak pernah dilog (ARCHITECTURE §2 butir 3).
 */
@Injectable()
export class ChatPresenter {
  constructor(
    private readonly files: FilesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  static subject(viewer: ChatViewer | null): FileTokenSubject | null {
    return viewer
      ? { userId: viewer.userId, sessionId: viewer.sessionId, sessionVersion: viewer.sessionVersion }
      : null;
  }

  /** URL berkas (publik tetap, privat bertanda tangan <= 10 menit) atau null bila berkas tidak siap. */
  async fileUrl(
    file: FileRefLite,
    purpose: "avatar" | "chat_image",
    viewer: ChatViewer | null,
  ): Promise<{ url: string; expiresAt: Date | null } | null> {
    if (!file.id || file.status !== "ready" || !file.visibility) return null;
    return this.files.signedUrl(
      { id: file.id, purpose, visibility: file.visibility },
      ChatPresenter.subject(viewer),
    );
  }

  async avatarUrl(file: FileRefLite, viewer: ChatViewer | null): Promise<string | null> {
    return (await this.fileUrl(file, "avatar", viewer))?.url ?? null;
  }

  /** ChatUserRef: nama dan avatar saja, tanpa kontak (N-09); null bila akun sudah dihapus. */
  async userRef(
    input: { userId: string | null; accountStatus: string | null; fullName: string | null; avatar: FileRefLite },
    viewer: ChatViewer | null,
  ): Promise<ChatUserRefDto | null> {
    if (!input.userId || isDeletedAccount(input)) return null;
    return {
      user_id: input.userId,
      full_name: input.fullName!,
      avatar_url: await this.avatarUrl(input.avatar, viewer),
    };
  }

  // ----------------------------------------------------------------------------------------------------- room

  private peerFacts(row: RoomSummaryRow): UserFacts {
    return {
      accountStatus: row.peer_account_status,
      fullName: row.peer_name,
      suspendedAt: toDate(row.peer_suspended_at),
      expiresAt: toDate(row.peer_expires_at),
    };
  }

  /** Alasan server menolak kirim (ChatSendRestriction); blokir oleh lawan bicara dilaporkan peer_unavailable (N-09). */
  sendRestriction(row: RoomSummaryRow, now: Date = this.clock.now()): ChatSendRestriction | null {
    if (row.kind === "group") return row.closed_at ? "room_closed" : null;
    if (row.i_block) return "blocked";
    if (row.peer_blocks || !isActiveMember(this.peerFacts(row), now)) return "peer_unavailable";
    return null;
  }

  async summary(row: RoomSummaryRow, viewer: ChatViewer | null): Promise<ChatRoomSummaryDto> {
    const now = this.clock.now();
    const facts = this.peerFacts(row);
    const peerDeleted = row.kind === "direct" && isDeletedAccount(facts);
    let peer: ChatPeerDto | null = null;
    let title: string;
    let avatarUrl: string | null;
    if (row.kind === "group") {
      title = row.name ?? "";
      avatarUrl =
        (
          await this.fileUrl(
            { id: row.avatar_file_id, visibility: row.avatar_visibility, status: row.avatar_status },
            "chat_image",
            viewer,
          )
        )?.url ?? null;
    } else if (peerDeleted || !row.peer_id) {
      title = DELETED_ACCOUNT_NAME;
      avatarUrl = null;
    } else {
      avatarUrl = await this.avatarUrl(
        {
          id: row.peer_avatar_file_id,
          visibility: row.peer_avatar_visibility,
          status: row.peer_avatar_status,
        },
        viewer,
      );
      title = row.peer_name!;
      peer = {
        user_id: row.peer_id,
        full_name: row.peer_name!,
        avatar_url: avatarUrl,
        available: !row.peer_blocks && isActiveMember(facts, now),
      };
    }
    return {
      id: row.id,
      kind: row.kind,
      title,
      avatar_url: avatarUrl,
      peer,
      member_count: Math.min(row.member_count, 100),
      my_role: row.my_role,
      muted: row.muted,
      unread_count: Math.min(row.unread_count, 999),
      last_message: row.lm_id
        ? {
            id: row.lm_id,
            kind: row.lm_kind!,
            sender_user_id: row.lm_kind === "system" ? null : row.lm_sender_id,
            sender_name:
              row.lm_kind === "system" ||
              isDeletedAccount({ accountStatus: row.lm_sender_status, fullName: row.lm_sender_name })
                ? null
                : row.lm_sender_name,
            preview: row.lm_deleted ? null : previewOf(row.lm_body, PREVIEW_CHARS),
            has_image: !row.lm_deleted && row.lm_has_image === true,
            deleted: row.lm_deleted === true,
            created_at: row.lm_created_at!,
          }
        : null,
      last_message_at: row.last_message_at,
    };
  }

  async room(row: RoomSummaryRow, viewer: ChatViewer | null): Promise<ChatRoomDto> {
    const summary = await this.summary(row, viewer);
    const restriction = this.sendRestriction(row);
    return {
      ...summary,
      name: row.kind === "group" ? row.name : null,
      avatar_file_id: row.kind === "group" ? row.avatar_file_id : null,
      can_send: restriction === null,
      send_restriction: restriction,
      can_manage: row.kind === "group" && row.my_role === "admin" && row.closed_at === null,
      last_read_message_id: row.last_read_message_id,
      peer_last_read_message_id: row.kind === "direct" ? row.peer_last_read_message_id : null,
      history_visible_from: row.history_visible_from,
      closed_at: row.closed_at,
      created_at: row.created_at,
      version: String(row.version),
    };
  }

  // ----------------------------------------------------------------------------------------------------- pesan

  /**
   * ChatMessage untuk respons HTTP (viewer = sesi penampil) atau RealtimeChatMessage untuk siaran room
   * (`realtime: true`: viewer null, reaksi kosong, rujukan balasan tanpa pratinjau sesuai realtime-chat-reply).
   */
  async messages(
    db: DbOrTx,
    found: readonly MessageRow[],
    viewer: ChatViewer | null,
    options: { realtime?: boolean } = {},
  ): Promise<ChatMessageDto[]> {
    const reactions = options.realtime
      ? new Map<string, ReactionCountRow[]>()
      : await reactionCounts(
          db,
          found.filter((m) => !m.deleted_at).map((m) => m.id),
          viewer?.userId ?? null,
        );
    return Promise.all(found.map((row) => this.message(row, reactions.get(row.id) ?? [], viewer, options)));
  }

  private async message(
    row: MessageRow,
    reactions: readonly ReactionCountRow[],
    viewer: ChatViewer | null,
    options: { realtime?: boolean },
  ): Promise<ChatMessageDto> {
    const deleted = row.deleted_at !== null;
    const sender =
      row.kind === "system"
        ? null
        : await this.userRef(
            {
              userId: row.sender_id,
              accountStatus: row.sender_status,
              fullName: row.sender_name,
              avatar: {
                id: row.sender_avatar_file_id,
                visibility: row.sender_avatar_visibility,
                status: row.sender_avatar_status,
              },
            },
            viewer,
          );
    let image: ChatMessageDto["image"] = null;
    if (!deleted && row.image_file_id && row.image_status === "ready" && row.image_mime) {
      const signed = await this.fileUrl(
        { id: row.image_file_id, visibility: row.image_visibility, status: row.image_status },
        "chat_image",
        viewer,
      );
      if (signed)
        image = {
          file_id: row.image_file_id,
          url: signed.url,
          // Gambar chat tidak pernah publik (files_private_purpose_chk), sehingga selalu ada masa berlaku.
          url_expires_at: (signed.expiresAt ?? this.clock.now()).toISOString(),
          mime: row.image_mime,
          width: row.image_width && row.image_width > 0 ? row.image_width : null,
          height: row.image_height && row.image_height > 0 ? row.image_height : null,
        };
    }
    let replyTo: ChatMessageDto["reply_to"] = null;
    if (row.reply_to_id) {
      const available =
        !options.realtime && row.reply_visible === true && row.reply_deleted !== true && row.reply_id !== null;
      replyTo = {
        id: row.reply_to_id,
        available,
        sender_name:
          available &&
          row.reply_kind !== "system" &&
          !isDeletedAccount({ accountStatus: row.reply_sender_status, fullName: row.reply_sender_name })
            ? row.reply_sender_name
            : null,
        preview: available ? previewOf(row.reply_body, PREVIEW_CHARS) : null,
        has_image: available && row.reply_has_image === true,
      };
    }
    return {
      id: row.id,
      room_id: row.room_id,
      client_message_id: row.kind === "system" ? null : row.client_message_id,
      kind: row.kind,
      sender,
      body: deleted ? null : row.body,
      image,
      reply_to: replyTo,
      reactions: deleted
        ? []
        : reactions.map((r) => ({ emoji: r.emoji, count: r.count, reacted_by_me: r.mine })),
      created_at: row.created_at,
      deleted_at: row.deleted_at,
    };
  }

  /** Bentuk siaran message.created (RealtimeChatMessage = ChatMessage). */
  static asRealtime(message: ChatMessageDto): RealtimeChatMessage {
    return message as RealtimeChatMessage;
  }
}
