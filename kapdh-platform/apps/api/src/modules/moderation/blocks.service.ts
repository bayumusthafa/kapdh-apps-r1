import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, blocks, roomMembers, rooms, users } from "@kapdh/database";
import { and, count, desc, eq, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { isRetryableTransactionError } from "../../core/db/errors.js";
import type { Db, Tx } from "../../core/db/types.js";
import { fieldError, notFound } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { BlockPolicy } from "../../core/policy/block.policy.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { avatarUrlFor } from "./member-avatar.js";

type BlockedMember = components["schemas"]["BlockedMember"];
type BlockedMemberPage = components["schemas"]["BlockedMemberPage"];

/** Percobaan ulang transaksi blokir bila PostgreSQL memutus deadlock/serialisasi (40P01/40001) dengan room chat. */
const MAX_ATTEMPTS = 3;

/** `direct_key` kanonik room direct `min(a,b):max(a,b)` (AC F11-1, rooms_direct_key_canonical_chk). */
export function directKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

const cursorSchema = z.object({ created_at: z.coerce.date(), id: z.uuid() });

/**
 * Blokir dua arah (F-12, PRD 3.12, AC F12-1). Tabel `blocks` hanya menyimpan arah pemblokir → yang diblokir; efek dua
 * arah ditegakkan {@link BlockPolicy.isBlockedEitherWay} (core) yang dipanggil modul chat saat kirim direct, reaksi
 * direct dan undangan grup. Setiap pembuatan/penghapusan blokir mengambil kunci pasangan {@link BlockPolicy.lockPair}
 * lebih dulu (kunci yang sama dengan kirim direct/undangan), sehingga keputusan blokir vs kirim/undang terserialisasi.
 * Blokir tidak diaudit dan tidak diberitahukan kepada pihak yang diblokir (N-09).
 */
@Injectable()
export class BlocksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly policy: BlockPolicy,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
  ) {}

  /** GET /blocks: hanya blokir milik pemanggil, terbaru dulu (keyset created_at, blocked_id). */
  async list(auth: AuthContext, query: unknown): Promise<BlockedMemberPage> {
    const page = parsePageQuery(query);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    const found = await this.db
      .select({
        blockedId: blocks.blockedId,
        createdAt: blocks.createdAt,
        fullName: alumni.fullName,
        avatarFileId: alumni.avatarFileId,
      })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .innerJoin(alumni, eq(alumni.userId, blocks.blockedId))
      .where(
        and(
          eq(blocks.blockerId, auth.userId),
          // Akun yang sudah dihapus tidak ditampilkan (D2); barisnya hilang bersama akun (ON DELETE CASCADE).
          ne(users.status, "deleted"),
          after
            ? keysetAfter([
                { column: blocks.createdAt, value: after.created_at, direction: "desc" },
                { column: blocks.blockedId, value: after.id, direction: "desc" },
              ])
            : undefined,
        ),
      )
      .orderBy(desc(blocks.createdAt), desc(blocks.blockedId))
      .limit(page.limit + 1);
    const result = pageOf(found, page.limit, {
      cursorOf: (row) => ({ created_at: row.createdAt, id: row.blockedId }),
    });
    return {
      items: await Promise.all(
        result.items.map(async (row) => ({
          user_id: row.blockedId,
          full_name: row.fullName,
          avatar_url: await avatarUrlFor(this.files, row.avatarFileId, auth),
          blocked_at: row.createdAt.toISOString(),
        })),
      ),
      next_cursor: result.next_cursor,
    };
  }

  /**
   * PUT /blocks/{userId} (AC F12-1): idempoten. Dalam satu transaksi di bawah kunci pasangan: blokir dicatat, undangan
   * grup tertunda dari salah satu pihak kepada yang lain dibatalkan (status removed; event invitation_cancelled
   * dengan actor_user_id null hanya ke kanal user calon anggota dan admin grup, sehingga tidak dapat dibedakan dari
   * tindakan sistem lain), dan setelah commit perangkat pemanggil menerima `room.updated` (send_permission) untuk room
   * direct keduanya bila ada. Pihak yang diblokir tidak diberi tahu.
   */
  async block(auth: AuthContext, targetUserId: string): Promise<BlockedMember> {
    if (targetUserId === auth.userId)
      throw fieldError("userId", "Anda tidak dapat memblokir akun sendiri.");
    const row = await this.withRetry((tx) => this.blockInTx(tx, auth.userId, targetUserId));
    return {
      user_id: targetUserId,
      full_name: row.fullName,
      avatar_url: await avatarUrlFor(this.files, row.avatarFileId, auth),
      blocked_at: row.blockedAt.toISOString(),
    };
  }

  /**
   * DELETE /blocks/{userId}: menghapus blokir milik pemanggil saja (blokir dari pihak lain tetap berlaku, AC F12-1).
   * Idempoten (blokir yang tidak ada tetap sukses). Undangan yang sudah dibatalkan tidak dipulihkan.
   */
  async unblock(auth: AuthContext, targetUserId: string): Promise<void> {
    if (targetUserId === auth.userId)
      throw fieldError("userId", "Anda tidak dapat membuka blokir akun sendiri.");
    await this.withRetry(async (tx) => {
      await this.policy.lockPair(tx, auth.userId, targetUserId);
      const removed = await tx
        .delete(blocks)
        .where(and(eq(blocks.blockerId, auth.userId), eq(blocks.blockedId, targetUserId)))
        .returning({ blockedId: blocks.blockedId });
      if (removed.length > 0) await this.notifyDirectRoom(tx, auth.userId, targetUserId);
    });
  }

  private async blockInTx(tx: Tx, blockerId: string, blockedId: string) {
    await this.policy.lockPair(tx, blockerId, blockedId);
    const [target] = await tx
      .select({
        kind: users.kind,
        status: users.status,
        fullName: alumni.fullName,
        avatarFileId: alumni.avatarFileId,
      })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(eq(users.id, blockedId))
      .limit(1);
    // Hanya akun alumni yang ada (bukan pending_otp/deleted/admin); selain itu 404 tanpa membedakan alasan (N-09).
    if (!target || target.kind !== "alumni" || target.status === "pending_otp" || target.status === "deleted")
      throw notFound("Anggota tidak ditemukan.");

    const now = this.clock.now();
    const inserted = await tx
      .insert(blocks)
      .values({ blockerId, blockedId, createdAt: now })
      .onConflictDoNothing({ target: [blocks.blockerId, blocks.blockedId] })
      .returning({ createdAt: blocks.createdAt });
    let blockedAt = inserted[0]?.createdAt;
    if (!blockedAt) {
      const [existing] = await tx
        .select({ createdAt: blocks.createdAt })
        .from(blocks)
        .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
        .limit(1);
      blockedAt = existing!.createdAt;
    } else {
      await this.cancelPendingInvitations(tx, blockerId, blockedId, now);
      await this.notifyDirectRoom(tx, blockerId, blockedId);
    }
    return { fullName: target.fullName, avatarFileId: target.avatarFileId, blockedAt };
  }

  /**
   * Undangan grup tertunda dari salah satu pihak kepada yang lain dibatalkan (kontrak blockMember): invited → removed.
   * Event `room.member_changed` (invitation_cancelled, actor null) hanya ke calon anggota dan setiap admin grup joined,
   * tidak pernah ke kanal room (undangan tertunda hanya terlihat admin grup, kontrak C6).
   */
  private async cancelPendingInvitations(tx: Tx, a: string, b: string, now: Date): Promise<void> {
    const pending = await tx
      .select({ roomId: roomMembers.roomId, userId: roomMembers.userId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.status, "invited"),
          or(
            and(eq(roomMembers.userId, b), eq(roomMembers.invitedBy, a)),
            and(eq(roomMembers.userId, a), eq(roomMembers.invitedBy, b)),
          ),
        ),
      )
      .orderBy(roomMembers.roomId, roomMembers.userId)
      .for("update");
    for (const invitation of pending) {
      const cancelled = await tx
        .update(roomMembers)
        .set({ status: "removed", updatedAt: now })
        .where(
          and(
            eq(roomMembers.roomId, invitation.roomId),
            eq(roomMembers.userId, invitation.userId),
            eq(roomMembers.status, "invited"),
          ),
        )
        .returning({ roomId: roomMembers.roomId });
      if (cancelled.length === 0) continue;
      const [joined] = await tx
        .select({ value: count() })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, invitation.roomId), eq(roomMembers.status, "joined")));
      const groupAdmins = await tx
        .select({ userId: roomMembers.userId })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, invitation.roomId),
            eq(roomMembers.role, "admin"),
            eq(roomMembers.status, "joined"),
          ),
        );
      this.realtime.emitToUsers(
        [invitation.userId, ...groupAdmins.map((admin) => admin.userId)],
        "room.member_changed",
        invitation.roomId,
        {
          room_id: invitation.roomId,
          user_id: invitation.userId,
          change: "invitation_cancelled",
          role: null,
          member_count: Math.min(100, Number(joined?.value ?? 0)),
          actor_user_id: null,
        },
      );
    }
  }

  /** `room.updated` (send_permission) hanya ke perangkat pemanggil untuk room direct pasangan ini, bila ada. */
  private async notifyDirectRoom(tx: Tx, callerId: string, otherId: string): Promise<void> {
    const [room] = await tx
      .select({ id: rooms.id, version: rooms.version, closedAt: rooms.closedAt })
      .from(rooms)
      .where(and(eq(rooms.directKey, directKeyOf(callerId, otherId)), eq(rooms.kind, "direct")))
      .limit(1);
    if (!room) return;
    this.realtime.emitToUser(callerId, "room.updated", room.id, {
      room_id: room.id,
      version: String(room.version),
      changes: ["send_permission"],
      name: null,
      avatar_url: null,
      closed_at: room.closedAt?.toISOString() ?? null,
    });
  }

  private async withRetry<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(fn);
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
      }
    }
  }
}
