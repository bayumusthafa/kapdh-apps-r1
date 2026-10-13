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
  displayNames,
  type MessageRow,
  reactionCounts,
  type ReactionCountRow,
  type RoomSummaryRow,
  toDate,
} from "./chat.queries.js";
import { decodeSystemEvent, type NameLookup, systemEventUserIds, systemText } from "./chat.system-messages.js";
import { previewOf } from "./content-filter.js";

export type ChatRoomSummaryDto = components["schemas"]["ChatRoomSummary"];
export type ChatRoomDto = components["schemas"]["ChatRoom"];
export type ChatMessageDto = components["schemas"]["ChatMessage"];
export type ChatUserRefDto = components["schemas"]["ChatUserRef"];
export type ChatPeerDto = components["schemas"]["ChatPeer"];
export type ChatReactionDto = components["schemas"]["ChatReaction"];
export type ChatSendRestriction = components["schemas"]["ChatSendRestriction"];

/**
 * Penerima URL berkas privat: sesi penampil HTTP (AuthContext) atau keluarga sesi penerima event realtime. URL selalu
 * terikat sesi ini sehingga otorisasi diulang saat dibuka (PRD 5.4: TTL tidak menggantikan otorisasi).
 */
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

/** Berkas siap yang hanya boleh dibuka lewat URL bertanda tangan terikat sesi (bukan publik). */
export function isPrivateReady(file: FileRefLite): boolean {
  return file.id !== null && file.status === "ready" && file.visibility !== "public";
}

/**
 * Pemetaan baris kueri chat ke skema kontrak (domains/chat.yaml, events/realtime-chat-*.schema.json). URL berkas privat
 * SELALU terikat sesi penerimanya (respons HTTP: sesi penampil; event realtime: keluarga sesi penerima, lihat
 * ChatFanout), sehingga membuka URL mengulang kebijakan akses (anggota yang keluar/dikeluarkan langsung ditolak, PRD 5.4,
 * AC F11-4). Tanpa penerima hanya URL berkas publik yang diterbitkan. Teks pesan sistem dirangkai dari peristiwa
 * terstruktur dengan nama terkini (chat.system-messages.ts). Isi pesan tidak pernah dilog (ARCHITECTURE §2 butir 3).
 */
@Injectable()
export class ChatPresenter {
  constructor(
    private readonly files: FilesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  static subject(viewer: ChatViewer): FileTokenSubject {
    return { userId: viewer.userId, sessionId: viewer.sessionId, sessionVersion: viewer.sessionVersion };
  }

  /**
   * URL berkas: publik → URL tetap; privat → URL bertanda tangan terikat sesi `viewer` (TTL bawaan <= 10 menit,
   * otorisasi diulang saat dibuka). null bila berkas tidak siap, atau privat tanpa penerima (URL privat tanpa sesi tidak
   * pernah diterbitkan, PRD 5.4).
   */
  async fileUrl(
    file: FileRefLite,
    purpose: "avatar" | "chat_image",
    viewer: ChatViewer | null,
  ): Promise<{ url: string; expiresAt: Date | null } | null> {
    if (!file.id || file.status !== "ready" || !file.visibility) return null;
    if (file.visibility !== "public" && !viewer) return null;
    return this.files.signedUrl(
      { id: file.id, purpose, visibility: file.visibility },
      viewer ? ChatPresenter.subject(viewer) : null,
    );
  }

  async avatarUrl(file: FileRefLite, viewer: ChatViewer | null): Promise<string | null> {
    return (await this.fileUrl(file, "avatar", viewer))?.url ?? null;
  }

  /** ChatUserRef: nama dan avatar saja, tanpa kontak (N-09); null bila akun sudah dihapus. */
  async userRef(
    input: {
      userId: string | null;
      accountStatus: string | null;
      fullName: string | null;
      avatar: FileRefLite;
    },
    viewer: ChatViewer | null,
  ): Promise<ChatUserRefDto | null> {
    if (!input.userId || isDeletedAccount(input)) return null;
    return {
      user_id: input.userId,
      full_name: input.fullName!,
      avatar_url: await this.avatarUrl(input.avatar, viewer),
    };
  }

  // ------------------------------------------------------------------------------------------------ pesan sistem

  /** Nama terkini untuk semua pengguna yang disebut body pesan sistem (satu kueri). */
  async nameLookup(db: DbOrTx, bodies: readonly (string | null)[]): Promise<NameLookup> {
    const ids = new Set<string>();
    for (const body of bodies) {
      const event = decodeSystemEvent(body);
      if (event) for (const id of systemEventUserIds(event)) ids.add(id);
    }
    const names = await displayNames(db, [...ids]);
    return (userId) => names.get(userId) ?? null;
  }

  /**
   * Teks tampilan body pesan sistem (urutan sama dengan masukan). Untuk modul lain yang membaca messages.body mentah,
   * mis. snapshot bukti moderasi atas pesan konteks berjenis system (kontrak AdminModerationEvidenceMessage).
   */
  async renderSystemBodies(db: DbOrTx, bodies: readonly (string | null)[]): Promise<(string | null)[]> {
    const nameOf = await this.nameLookup(db, bodies);
    return bodies.map((body) => systemText(body, nameOf));
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

  /** ChatRoomSummary untuk beberapa baris sekaligus (nama pesan sistem terakhir dimuat dengan satu kueri). */
  async summaries(
    db: DbOrTx,
    found: readonly RoomSummaryRow[],
    viewer: ChatViewer,
  ): Promise<ChatRoomSummaryDto[]> {
    const nameOf = await this.nameLookup(
      db,
      found.map((row) => (row.lm_kind === "system" ? row.lm_body : null)),
    );
    return Promise.all(found.map((row) => this.summary(row, viewer, nameOf)));
  }

  private async summary(
    row: RoomSummaryRow,
    viewer: ChatViewer,
    nameOf: NameLookup,
  ): Promise<ChatRoomSummaryDto> {
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
    const lastText = row.lm_kind === "system" ? systemText(row.lm_body, nameOf) : row.lm_body;
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
            preview: row.lm_deleted ? null : previewOf(lastText, PREVIEW_CHARS),
            has_image: !row.lm_deleted && row.lm_has_image === true,
            deleted: row.lm_deleted === true,
            created_at: row.lm_created_at!,
          }
        : null,
      last_message_at: row.last_message_at,
    };
  }

  async room(db: DbOrTx, row: RoomSummaryRow, viewer: ChatViewer): Promise<ChatRoomDto> {
    const [summary] = await this.summaries(db, [row], viewer);
    const restriction = this.sendRestriction(row);
    return {
      ...summary!,
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

  /** true bila bentuk siaran pesan memuat URL berkas privat (gambar pesan atau avatar privat pengirim). */
  static hasPrivateFiles(row: MessageRow): boolean {
    const image =
      row.deleted_at === null &&
      row.image_file_id !== null &&
      isPrivateReady({ id: row.image_file_id, visibility: row.image_visibility, status: row.image_status });
    const avatar =
      row.kind !== "system" &&
      isPrivateReady({
        id: row.sender_avatar_file_id,
        visibility: row.sender_avatar_visibility,
        status: row.sender_avatar_status,
      });
    return image || avatar;
  }

  /**
   * ChatMessage untuk respons HTTP (viewer = sesi penampil) atau RealtimeChatMessage untuk event (`realtime: true`:
   * reaksi kosong, rujukan balasan tanpa pratinjau sesuai realtime-chat-reply; viewer = keluarga sesi penerima, atau
   * null bila pesan tanpa berkas privat). `names` dapat diberikan agar penyiaran per sesi tidak mengulang kueri nama.
   */
  async messages(
    db: DbOrTx,
    found: readonly MessageRow[],
    viewer: ChatViewer | null,
    options: { realtime?: boolean; names?: NameLookup } = {},
  ): Promise<ChatMessageDto[]> {
    const reactions = options.realtime
      ? new Map<string, ReactionCountRow[]>()
      : await reactionCounts(
          db,
          found.filter((m) => !m.deleted_at).map((m) => m.id),
          viewer?.userId ?? null,
        );
    const nameOf = options.names ?? (await this.nameLookup(db, ChatPresenter.systemBodies(found)));
    return Promise.all(
      found.map((row) => this.message(row, reactions.get(row.id) ?? [], viewer, nameOf, options)),
    );
  }

  /** Body pesan sistem (pesan itu sendiri dan pesan yang dibalas) yang perlu nama terkini. */
  static systemBodies(found: readonly MessageRow[]): (string | null)[] {
    return found.flatMap((row) => [
      row.kind === "system" ? row.body : null,
      row.reply_kind === "system" ? row.reply_body : null,
    ]);
  }

  private async message(
    row: MessageRow,
    reactions: readonly ReactionCountRow[],
    viewer: ChatViewer | null,
    nameOf: NameLookup,
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
        !options.realtime &&
        row.reply_visible === true &&
        row.reply_deleted !== true &&
        row.reply_id !== null;
      const replyText = row.reply_kind === "system" ? systemText(row.reply_body, nameOf) : row.reply_body;
      replyTo = {
        id: row.reply_to_id,
        available,
        sender_name:
          available &&
          row.reply_kind !== "system" &&
          !isDeletedAccount({ accountStatus: row.reply_sender_status, fullName: row.reply_sender_name })
            ? row.reply_sender_name
            : null,
        preview: available ? previewOf(replyText, PREVIEW_CHARS) : null,
        has_image: available && row.reply_has_image === true,
      };
    }
    return {
      id: row.id,
      room_id: row.room_id,
      client_message_id: row.kind === "system" ? null : row.client_message_id,
      kind: row.kind,
      sender,
      body: deleted ? null : row.kind === "system" ? systemText(row.body, nameOf) : row.body,
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
