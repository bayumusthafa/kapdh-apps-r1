import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { rows } from "../../core/db/rows.js";
import type { Db } from "../../core/db/types.js";
import type { FileAccessRequest } from "../../core/files/access-policy.js";
import { FilesService } from "../../core/files/files.service.js";
import { roomChannel } from "../../core/realtime/envelope.js";
import {
  CHAT_ACTIVE_STATUSES,
  type RealtimeClient,
  RealtimeService,
} from "../../core/realtime/realtime.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { isUuid } from "../../core/validation/validate.js";
import {
  PRESENCE_MAX_RECIPIENTS,
  PRESENCE_THROTTLE_MS,
  PRESENCE_TTL_SECONDS,
  TYPING_THROTTLE_MS,
  TYPING_TTL_SECONDS,
} from "./chat.constants.js";
import { directPeerId } from "./chat.queries.js";

/** Batas entri peta throttle di memori sebelum dipangkas (mencegah pertumbuhan tanpa batas). */
const THROTTLE_MAP_LIMIT = 10_000;

/**
 * Handler realtime milik modul chat (ARCHITECTURE §4.9; events/README.md):
 * - event klien `typing {room_id}`: hanya dari anggota joined berstatus aktif pada room yang belum ditutup, tidak
 *   antara pasangan yang saling memblokir di room direct; diteruskan sebagai `typing` (TTL, bukan bukti baca) ke anggota
 *   room lain. Emit dari pengguna yang tidak lagi berizin diabaikan dan langganan room dicabut (AC F11-4, F11-6).
 * - event klien `presence.ping`: pengguna aktif disiarkan online (TTL) ke anggota aktif room yang sama, tidak antara
 *   pasangan yang saling memblokir; pengguna yang tidak lagi aktif tidak disiarkan, langganan room-nya dicabut, dan
 *   disiarkan offline (ttl 0). Presence/typing tidak pernah disimpan di database (sementara).
 * - kebijakan akses berkas (PRD 5.4, AC F11-4): `chat_image` hanya untuk anggota joined aktif yang dapat melihat pesan
 *   bergambar itu (history_visible_from) atau avatar grupnya (termasuk calon anggota yang diundang); `avatar` anggota
 *   lain hanya untuk anggota aktif yang berbagi room dengannya (nama dan avatar tampil di chat walau disembunyikan dari
 *   direktori, kontrak listChatRoomMembers).
 */
@Injectable()
export class ChatRealtimeHandlers implements OnModuleInit {
  private readonly typingAt = new Map<string, number>();
  private readonly presenceAt = new Map<string, number>();

  constructor(
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.realtime.registerClientEvent("typing", (client, data) => this.onTyping(client, data));
    this.realtime.registerClientEvent("presence.ping", (client) => this.onPresencePing(client));
    this.files.registerAccessPolicy("chat_image", (request) => this.canViewChatImage(request));
    this.files.registerAccessPolicy("avatar", (request) => this.canViewMemberAvatar(request));
  }

  // ---------------------------------------------------------------------------------------------------- typing

  async onTyping(client: RealtimeClient, data: unknown): Promise<void> {
    const raw = (data as { room_id?: unknown } | null)?.room_id;
    if (!isUuid(raw)) return;
    const roomId = raw.toLowerCase();
    if (!CHAT_ACTIVE_STATUSES.has(client.effectiveStatus)) {
      this.revokeInactive(client);
      return;
    }
    const verdict = await this.typingVerdict(client.userId, roomId);
    if (verdict === "denied") {
      // Bukan anggota joined room aktif: langganan socket ini pada room tersebut dicabut (AC F11-4).
      client.leave(roomChannel(roomId));
      return;
    }
    if (verdict === "silent") return;
    if (!this.throttle(this.typingAt, `${client.userId}:${roomId}`, TYPING_THROTTLE_MS)) return;
    this.realtime.emitToRoom(
      roomId,
      "typing",
      roomId,
      { room_id: roomId, user_id: client.userId, ttl_seconds: TYPING_TTL_SECONDS },
      { exceptUserId: client.userId },
    );
  }

  /** allowed / silent (room direct dengan blokir dua arah: tidak diteruskan, langganan tetap) / denied. */
  private async typingVerdict(userId: string, roomId: string): Promise<"allowed" | "silent" | "denied"> {
    const [row] = rows<{ kind: string; direct_key: string | null; closed: boolean; status: string }>(
      await this.db.execute(sql`
        select r.kind::text as kind, r.direct_key, (r.closed_at is not null) as closed, rm.status::text as status
        from app.rooms r join app.room_members rm on rm.room_id = r.id and rm.user_id = ${userId}::uuid
        where r.id = ${roomId}::uuid`),
    );
    if (!row || row.status !== "joined" || row.closed) return "denied";
    if (row.kind !== "direct") return "allowed";
    const peerId = directPeerId(row.direct_key, userId);
    if (!peerId) return "silent";
    const [blocked] = rows<{ ok: boolean }>(
      await this.db.execute(sql`
        select true as ok from app.blocks
        where (blocker_id = ${userId}::uuid and blocked_id = ${peerId}::uuid)
           or (blocker_id = ${peerId}::uuid and blocked_id = ${userId}::uuid)
        limit 1`),
    );
    return blocked ? "silent" : "allowed";
  }

  // -------------------------------------------------------------------------------------------------- presence

  async onPresencePing(client: RealtimeClient): Promise<void> {
    if (!CHAT_ACTIVE_STATUSES.has(client.effectiveStatus)) {
      this.revokeInactive(client);
      return;
    }
    if (!this.throttle(this.presenceAt, client.userId, PRESENCE_THROTTLE_MS)) return;
    const recipients = await this.presenceAudience(client.userId);
    if (recipients.length === 0) return;
    this.realtime.emitToUsers(recipients, "presence", client.userId, {
      user_id: client.userId,
      status: "online",
      ttl_seconds: PRESENCE_TTL_SECONDS,
    });
  }

  /**
   * Pengguna tidak lagi aktif (expired/suspended) saat emit: semua langganan room socket-nya dicabut (lintas instance)
   * dan disiarkan offline (ttl 0) ke anggota room yang sama (AC F11-6, events/presence.schema.json).
   */
  private revokeInactive(client: RealtimeClient): void {
    this.realtime.syncRoomSubscriptions(client.userId, client.effectiveStatus);
    if (!this.throttle(this.presenceAt, `offline:${client.userId}`, PRESENCE_THROTTLE_MS)) return;
    void this.presenceAudience(client.userId).then((recipients) => {
      if (recipients.length > 0)
        this.realtime.emitToUsers(recipients, "presence", client.userId, {
          user_id: client.userId,
          status: "offline",
          ttl_seconds: 0,
        });
    });
  }

  /** Anggota aktif (verified/expiring, tidak suspended) yang berbagi room joined, tanpa pasangan yang saling memblokir. */
  private async presenceAudience(userId: string): Promise<string[]> {
    const now = this.clock.now().toISOString();
    const found = rows<{ user_id: string }>(
      await this.db.execute(sql`
        select distinct o.user_id
        from app.room_members me
        join app.rooms r on r.id = me.room_id and r.closed_at is null
        join app.room_members o on o.room_id = me.room_id and o.status = 'joined' and o.user_id <> me.user_id
        join app.users u on u.id = o.user_id and u.status = 'active'
        join app.alumni a on a.user_id = o.user_id and a.suspended_at is null
          and a.expires_at is not null and a.expires_at > ${now}::timestamptz
        where me.user_id = ${userId}::uuid and me.status = 'joined'
          and not exists (
            select 1 from app.blocks b
            where (b.blocker_id = me.user_id and b.blocked_id = o.user_id)
               or (b.blocker_id = o.user_id and b.blocked_id = me.user_id))
        limit ${PRESENCE_MAX_RECIPIENTS}`),
    );
    return found.map((row) => row.user_id);
  }

  /** true bila boleh disiarkan sekarang (jeda minimal per kunci menurut Clock). */
  private throttle(map: Map<string, number>, key: string, windowMs: number): boolean {
    const now = this.clock.now().getTime();
    const last = map.get(key);
    if (last !== undefined && now - last < windowMs && now >= last) return false;
    if (map.size >= THROTTLE_MAP_LIMIT)
      for (const [entry, at] of map) if (now - at >= windowMs || at > now) map.delete(entry);
    map.set(key, now);
    return true;
  }

  // ------------------------------------------------------------------------------------- kebijakan akses berkas

  /** Penampil sesi anggota berstatus aktif (chat hanya verified/expiring, PRD 2.2). */
  private static activeMember(request: FileAccessRequest): boolean {
    const status = request.viewer.effectiveStatus;
    return request.viewer.audience === "mobile" && status !== null && CHAT_ACTIVE_STATUSES.has(status);
  }

  /** chat_image: gambar pesan yang terlihat bagi anggota joined, atau avatar grup bagi anggota/calon anggota. */
  async canViewChatImage(request: FileAccessRequest): Promise<boolean> {
    if (!ChatRealtimeHandlers.activeMember(request)) return false;
    const [row] = rows<{ ok: boolean }>(
      await request.db.execute(sql`
        select true as ok from app.messages m
        join app.room_members vm on vm.room_id = m.room_id and vm.user_id = ${request.viewer.userId}::uuid
          and vm.status = 'joined'
        where m.image_file_id = ${request.file.id}::uuid and m.deleted_at is null
          and (vm.history_visible_from is null or m.created_at >= vm.history_visible_from)
        union all
        select true as ok from app.rooms r
        join app.room_members vm on vm.room_id = r.id and vm.user_id = ${request.viewer.userId}::uuid
        where r.avatar_file_id = ${request.file.id}::uuid and r.kind = 'group'
          and (vm.status = 'joined' or (vm.status = 'invited' and r.closed_at is null))
        limit 1`),
    );
    return row?.ok === true;
  }

  /** avatar anggota lain: berkas avatar terkini pemiliknya dan penampil berbagi room dengannya (joined/diundang). */
  async canViewMemberAvatar(request: FileAccessRequest): Promise<boolean> {
    const owner = request.file.ownerUserId;
    if (!owner || owner === request.viewer.userId || !ChatRealtimeHandlers.activeMember(request)) return false;
    const [row] = rows<{ ok: boolean }>(
      await request.db.execute(sql`
        select true as ok from app.alumni a
        join app.room_members om on om.user_id = a.user_id and om.joined_at is not null
        join app.rooms r on r.id = om.room_id
        join app.room_members vm on vm.room_id = om.room_id and vm.user_id = ${request.viewer.userId}::uuid
        where a.user_id = ${owner}::uuid and a.avatar_file_id = ${request.file.id}::uuid
          and (vm.status = 'joined' or (vm.status = 'invited' and r.kind = 'group' and r.closed_at is null))
        limit 1`),
    );
    return row?.ok === true;
  }
}
